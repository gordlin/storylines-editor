import JSZip from 'jszip';

// ---- Types ----
type Hash = string;
type Bytes = Uint8Array;

interface EntryMetadata {
    hash: Hash;
    date?: Date;
}
type Manifest = Record<string, EntryMetadata>; // path -> meta

// ---- Helpers ----
async function sha256(bytes: Bytes): Promise<Hash> {
    const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- History core ----
export class ZipHistory {
    // Global, deduped blob store: hash -> bytes
    private store = new Map<Hash, Bytes>();

    // Linear timeline of manifests + a cursor
    private timeline: Manifest[] = [];
    private idx = -1;

    get currentPosition() {
        return this.idx;
    }

    get canUndo() {
        return this.idx > 0;
    }
    get canRedo() {
        return this.idx >= 0 && this.idx < this.timeline.length - 1;
    }

    private current(): Manifest {
        if (this.idx < 0) return {};
        return this.timeline[this.idx];
    }

    /** Take a snapshot from a live JSZip (deduped) */
    async snapshotFromZip(zip: JSZip): Promise<void> {
        const manifest: Manifest = {};
        const entries: { path: string; file: JSZip.JSZipObject }[] = [];
        zip.forEach((path, file) => {
            if (!file.dir) entries.push({ path, file });
        });

        for (const { path, file } of entries) {
            const bytes = await file.async('uint8array');
            const hash = await sha256(bytes);
            if (!this.store.has(hash)) this.store.set(hash, bytes);
            manifest[path] = { hash, date: file.date };
        }
        this.commit(manifest);
    }

    /** Apply edits as ops and create a new snapshot (no recompression) */
    async applyOps(
        ops: Array<{ type: 'put'; path: string; bytes: Bytes; date?: Date } | { type: 'remove'; path: string }>
    ): Promise<void> {
        const base = { ...this.current() };
        for (const op of ops) {
            if (op.type === 'remove') {
                delete base[op.path];
            } else {
                const hash = await sha256(op.bytes);
                if (!this.store.has(hash)) this.store.set(hash, op.bytes);
                base[op.path] = { hash, date: op.date };
            }
        }
        this.commit(base);
    }

    /** Rebuild a JSZip for the current snapshot (only when you need it) */
    async toJSZip(): Promise<JSZip> {
        const manifest = this.current();
        const zip = new JSZip();
        for (const [path, meta] of Object.entries(manifest)) {
            const blob = this.store.get(meta.hash)!; // guaranteed by construction
            zip.file(path, blob, { date: meta.date });
        }
        return zip;
    }

    /** Convenience: export a zipped Uint8Array */
    async toUint8Array(options?: JSZip.JSZipGeneratorOptions & { type?: 'uint8array' }) {
        const zip = await this.toJSZip();
        return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', ...options });
    }

    undo() {
        if (this.canUndo) this.idx--;
    }
    redo() {
        if (this.canRedo) this.idx++;
    }

    /**
     * Return true if the given zip differs from the current snapshot.
     * Cheap early-out on path changes; otherwise hashes until the first mismatch.
     */
    async hasChangesFromZip(zip: JSZip, opts?: { prefixes?: string[]; compareMeta?: boolean }): Promise<boolean> {
        const diff = await this.diffFromZip(zip, {
            prefixes: opts?.prefixes,
            compareMeta: opts?.compareMeta ?? false,
            stopOnFirst: true, // early-exit
            returnManifest: false // we only need a boolean
        });
        return diff.changed;
    }

    /**
     * Produce a structured diff (added/removed/modified) vs current snapshot.
     * If returnManifest is true, also returns a manifest for committing.
     */
    async diffFromZip(
        zip: JSZip,
        opts?: {
            prefixes?: string[]; // e.g., ["assets/", "charts/", "rampConfig/"]
            compareMeta?: boolean; // also treat date/perm changes as changes
            stopOnFirst?: boolean; // short-circuit at the first difference
            returnManifest?: boolean; // build a next manifest you can commit
        }
    ): Promise<{
        changed: boolean;
        added: string[];
        removed: string[];
        modified: string[];
        metaChanged: string[];
        nextManifest?: Record<string, { hash: string; date?: Date }>;
    }> {
        const prefixes = opts?.prefixes;
        const compareMeta = !!opts?.compareMeta;
        const stopOnFirst = !!opts?.stopOnFirst;
        const returnManifest = !!opts?.returnManifest;

        const base = this.current();
        const include = (p: string) => !prefixes || prefixes.some((pre) => p.startsWith(pre));

        // Collect new entries (paths only) first — cheap precheck
        const newEntries: { path: string; file: JSZip.JSZipObject }[] = [];
        zip.forEach((path, file) => {
            if (!file.dir && include(path)) newEntries.push({ path, file });
        });

        const basePaths = new Set(Object.keys(base).filter(include));
        const newPaths = new Set(newEntries.map((e) => e.path));

        // Added / removed via set diff (no bytes yet)
        const added: string[] = [];
        const removed: string[] = [];
        for (const p of newPaths)
            if (!basePaths.has(p)) {
                added.push(p);
                if (stopOnFirst) return { changed: true, added, removed: [], modified: [], metaChanged: [] };
            }
        for (const p of basePaths)
            if (!newPaths.has(p)) {
                removed.push(p);
                if (stopOnFirst) return { changed: true, added: [], removed: [p], modified: [], metaChanged: [] };
            }

        // If path sets equal so far, check content hashes (and optional metadata)
        const modified: string[] = [];
        const metaChanged: string[] = [];
        const nextManifest: Record<string, { hash: string; date?: Date }> = {};

        // Iterate deterministically (optional, but nice)
        newEntries.sort((a, b) => a.path.localeCompare(b.path));

        for (const { path, file } of newEntries) {
            const prev = base[path];
            // prev must exist if we didn't early-exit on set diff
            const bytes = await file.async('uint8array');
            const hash = await sha256(bytes);
            if (returnManifest) nextManifest[path] = { hash, date: file.date };

            if (hash !== prev.hash) {
                if (!returnManifest && stopOnFirst)
                    return { changed: true, added, removed, modified: [path], metaChanged: [] };
                modified.push(path);
                if (stopOnFirst) return { changed: true, added, removed, modified, metaChanged };
            } else if (compareMeta) {
                const t1 = prev.date?.getTime();
                const t2 = file.date?.getTime();
                if (t1 !== t2) {
                    if (!returnManifest && stopOnFirst)
                        return { changed: true, added, removed, modified: [], metaChanged: [path] };
                    metaChanged.push(path);
                    if (stopOnFirst) return { changed: true, added, removed, modified, metaChanged };
                }
            }
        }

        // If building a next manifest, include unchanged entries (they keep old meta)
        if (returnManifest) {
            for (const [p, meta] of Object.entries(base)) {
                if (include(p) && !nextManifest[p] && !removed.includes(p)) nextManifest[p] = meta;
            }
        }

        const changed = added.length + removed.length + modified.length + metaChanged.length > 0;
        return {
            changed,
            added,
            removed,
            modified,
            metaChanged,
            nextManifest: returnManifest ? nextManifest : undefined
        };
    }

    /**
     * Commit the new JSZip only if it differs; returns true if committed.
     * Efficient: reuses bytes hashed during diff (no double reads).
     */
    async commitZipIfChanged(zip: JSZip, opts?: { prefixes?: string[]; compareMeta?: boolean }): Promise<boolean> {
        // Build a full nextManifest so we can commit in one pass
        const diff = await this.diffFromZip(zip, {
            prefixes: opts?.prefixes,
            compareMeta: opts?.compareMeta ?? false,
            stopOnFirst: false,
            returnManifest: true
        });

        if (!diff.changed) return false;

        // Ensure the blob store has the bytes for any new/modified hashes
        // We only need to fetch for paths in added/modified sets.
        const needed = new Set<string>();
        for (const p of [...diff.added, ...diff.modified]) {
            const h = diff.nextManifest![p].hash;
            if (!this.store.has(h)) needed.add(p);
        }
        // Read once, store once
        await Promise.all(
            [...needed].map(async (p) => {
                const file = zip.file(p)!;
                const bytes = await file.async('uint8array');
                const h = diff.nextManifest![p].hash;
                if (!this.store.has(h)) this.store.set(h, bytes);
            })
        );

        this.commit(diff.nextManifest!);
        return true;
    }

    // ---- internals ----
    private commit(next: Manifest) {
        // drop any redo branch, append snapshot, move cursor
        this.timeline.splice(this.idx + 1);
        this.timeline.push(next);
        this.idx = this.timeline.length - 1;
    }

    /** Optional: inspect file in current snapshot without building a JSZip */
    get(path: string): Bytes | undefined {
        const meta = this.current()[path];
        return meta ? this.store.get(meta.hash) : undefined;
    }

    /** Optional: GC blobs no longer referenced by any manifest */
    gc() {
        const inUse = new Set<Hash>();
        for (const mf of this.timeline) {
            for (const { hash } of Object.values(mf)) inUse.add(hash);
        }
        for (const h of this.store.keys()) if (!inUse.has(h)) this.store.delete(h);
    }
}
