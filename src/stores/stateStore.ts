import { StoryRampConfig, PanelType } from '@/definitions';
import { DetailedDiff, detailedDiff, diff } from 'deep-object-diff';
import { defineStore } from 'pinia';

interface StateChange {
    timestamp: number;
    origin: PanelType | 'unknown';
    changes: DetailedDiff; // ??
}

interface Save {
    en: StoryRampConfig | undefined;
    fr: StoryRampConfig | undefined;
}

// @ts-ignore
function replaceByClonedSource(options) {
    const clone = options.clone;
    // @ts-ignore
    return function (target, source) {
        return clone(source);
    };
}

export const useStateStore = defineStore('state', {
    state: () => ({
        // AVOID ACCESSING STATE DIRECTLY! Instead, use the available functions in `actions`.

        deepmerge: require('@fastify/deepmerge')({ all: true, mergeArray: replaceByClonedSource }),

        /**
         * Indicates whether there are any unsaved changes.
         */
        isChanged: false,

        /**
         * The latest saved state. Things are only saved if they're in here (items in stateChangesList are NOT saved)
         */
        latestSavedState: { en: undefined, fr: undefined } as Save,

        /**
         * All current change diffs. Nothing in here is saved.
         * Each diff contains the cumulative changes from all previous diffs,
         * making a lot of internal operations easier.
         */
        stateChangesList: [] as StateChange[],

        /**
         * Current location in stateChangesList. Might not be equal to stateChangesList.length - 1,
         * to allow for undo AND REDO operations. -1 indicates there are no changes.
         * May be obvious, but: it's equal to the INDEX value (0-index), not the .length value (1-index).
         */
        currentLoc: -1,

        /**
         * Variable used to flag if the state store wants the app to refresh its config variables.
         * The value itself (true/false) doesn't matter, only the change event itself.
         * When this changes, outside listeners should run `addChangesToNewSave` with `loc` = `getCurrentChangeLocation()`
         * to get the latest save, and replace the various non-save config variables (e.g. `configs` in the editor, for now)
         * with its values.
         */
        reconcileToggler: false
    }),
    actions: {
        // ================================
        // ACTIONS

        // Function that should run when app thinks there might be new changes.
        // Will run a lot, so it should be fast!
        handlePotentialChange(newConfigs: Save, origin?: PanelType): boolean {
            // All previous diffs merged into one, for easy comparison
            // const combinedPreviousDiffs: DetailedDiff = this.deepmerge(
            //     ...this.stateChangesList.map((stateChange) => stateChange.changes).slice(0, this.currentLoc + 1)
            // );
            // const combinedPreviousDiffs: DetailedDiff = this.determineIntermediateChanges() ?? {
            //     added: {},
            //     deleted: {},
            //     updated: {}
            // };

            const combinedPreviousDiffs = this.stateChangesList[this.currentLoc].changes ?? {
                added: {},
                deleted: {},
                updated: {}
            };

            // Determine all differences between the latest config and the latest save
            const newDiff = detailedDiff(this.latestSavedState, newConfigs);

            // There are no changes whatsoever from the last save. Set stuff accordingly.
            if (!Object.keys(newDiff).length) {
                this.isChanged = false;
                return false;
            }
            // Check if there are any additional changes beyond the last recorded change. If there isn't, exit
            else if (!Object.keys(diff(combinedPreviousDiffs, newDiff)).length) {
                return false;
            }

            // Save new diff to stateChangesList
            this.recordNewChange({
                timestamp: Date.now(),
                origin: origin ?? 'unknown',
                // Considered saving the diff between the combinedPreviousDiffs and the newDiffs,
                // but I think this pointlessly increases the number of operations for detecting
                // new changes (we'd need to merge all preceding entries in stateChangesList every
                // single time) in exchange for a negligible decrease in memory usage.
                // If anyone disagrees, feel free to @ me.
                changes: newDiff
            });

            this.isChanged = true;
            return true;
        },

        // Delete all changes
        resetAllChanges(): void {
            const oldLoc = this.currentLoc;
            this.currentLoc = -1;
            this.isChanged = false;
            this.reconcileAppState(oldLoc, true);
        },

        // Reverts the diff at currentLoc. currentLoc will be placed at currentLoc - 1.
        // TODO: Proper implementation
        undo(): void {
            if (this.currentLoc === -1) return;

            this.currentLoc--;
            this.reconcileAppState(this.currentLoc + 1);
        },

        // Re-applies the diff at currentLoc + 1, and sets currentLoc to that.
        // TODO: Proper implementation
        redo(): void {
            if (this.currentLoc === this.getNumberOfChanges() - 1) return;

            this.currentLoc++;
            this.reconcileAppState(this.currentLoc - 1);
        },

        // Adds all current changes since the last diff to a new diff in stateChangesList.
        // Sets currentLoc to the position of the new function
        recordNewChange(newChanges: StateChange): void {
            // const newChanges = this.determineNewChanges();

            // Check whatever needs to be checked

            // Stuff the new changes into the stack
            this.eraseSubsequentChanges(); // all changes after this should be erased
            this.isChanged = true;
            this.stateChangesList.push(newChanges);
            this.currentLoc++;
        },

        /**
         * Changes the app's state to be in line with the current stateChangesList and currentLoc.
         * Use this after applying some sort of change to the above variables (e.g. erasing all changes)
         * @param oldLoc
         * @param eraseAllSubsequent Whether all items after currentLoc on savedChangesList should be deleted.
         */
        reconcileAppState(oldLoc?: number, eraseAllSubsequent?: boolean): void {
            // Basic philosophy: Take the current stateChangesList, compare to oldLoc, undo or redo the intermediate diffs
            // if eraseAllSubsequent is true, run eraseSubsequentChanges at end

            if (eraseAllSubsequent) {
                this.eraseSubsequentChanges();
            }

            this.reconcileToggler = !this.reconcileToggler;
        },

        // Saves all current changes. Functionality for pressing the 'save' button.
        // Adds all current changes to latestSavedState; generates a config and pushes it; and resets the stateChangesList stack and currentLoc.
        // save(savedConfigs: Save): void

        // TEMPORARY SOLUTION UNTIL METADATA EDITOR IS REFACTORED
        // Allows an external function to 'pass in' a completed save (configFileStructure).
        // ** This should be replaced with save() once the refactor is complete.
        // passCompletedSave(save: configFileStructure): void

        // ====================================
        // UPDATERS AND HELPERS

        addChangesToNewSave(loc?: number): Save {
            loc = loc ?? this.currentLoc;

            const changesToAdd = this.stateChangesList[loc].changes;

            let newSave = JSON.parse(JSON.stringify(this.latestSavedState));

            // TODO: CHECK IF THIS ACTUALLY WORKS

            newSave = this.deepmerge(newSave, changesToAdd.added, changesToAdd.deleted, changesToAdd.updated);

            return newSave;
        },

        // Detects all current changes since the last diff, and packages it into a StateChange package.
        determineNewChanges(): StateChange {
            return { timestamp: -1, origin: PanelType.Text, changes: { added: {}, deleted: {}, updated: {} } };
        },

        // Internal function.
        // QUICKLY creates a "config-like" object allowing comparisons between diffs.
        // Likely to be a bottleneck, so must be efficient.
        // configify(): Save {},

        /**
         * Combines all changes in the state change array between the two indexes into a single object.
         * @param startLoc
         * @param endLoc
         */
        determineIntermediateChanges(startLoc?: number, endLoc?: number): DetailedDiff | undefined {
            startLoc = startLoc ?? 0;
            endLoc = endLoc ?? this.currentLoc;

            if (!this.getNumberOfChanges || startLoc >= endLoc) return undefined;

            const merged: DetailedDiff | {} = this.deepmerge(
                ...this.stateChangesList.map((stateChange) => stateChange.changes).slice(startLoc, endLoc + 1)
            );

            if (Object.keys(merged).length === 0) {
                return {
                    added: {},
                    deleted: {},
                    updated: {}
                };
            } else {
                return merged as DetailedDiff;
            }
        },

        // Erases all changes after the change at currentLoc.
        // (If currentLoc != stateChangesList.length, and you make a change, a stateChange is added overwriting the previous items in the list).
        // This function ONLY handles the erasing part. Use other functions for anything else you need
        eraseSubsequentChanges(): void {
            this.stateChangesList.splice(this.currentLoc + 1, Infinity);
        },

        // ===============================
        // GETTERS

        /**
         * Returns a boolean indicating if there are any unsaved changes.
         */
        getIsChanged(): boolean {
            // return this.stateChangesList.length !== 0;
            return this.isChanged;
        },

        getNumberOfChanges(): number {
            return this.stateChangesList.length;
        },

        getChangeAtIndex(index: number): StateChange | undefined {
            return this.stateChangesList[index];
        },

        getAllCurrentChanges(): StateChange[] {
            return this.stateChangesList;
        },

        getLatestChange(): StateChange | undefined {
            // Just in case, ensures function returns 'undefined' if current position is negative
            if (this.currentLoc === -1) return undefined;

            return this.stateChangesList[this.currentLoc];
        },

        getCurrentChangeLocation(): number {
            return this.currentLoc;
        }
    }
});
