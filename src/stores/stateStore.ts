/**
 * Handles state-related functionality throughout the Storylines Editor,
 * including diff tracking, ===TODO: FINISH THIS===
 */

import { StoryRampConfig, PanelType } from '@/definitions';
import { DetailedDiff, detailedDiff, diff } from 'deep-object-diff';
import { defineStore } from 'pinia';
import { deepmerge } from '@fastify/deepmerge';

interface StateChange {
    timestamp: number;
    origin: string | 'unknown';
    changes: DetailedDiff; // ??
}

export interface Save {
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

function purgeFalses(obj: any): any {
    if (Array.isArray(obj)) {
        return obj.map((item) => purgeFalses(item));
    }

    return Object.entries(obj).reduce((acc, [key, value]) => {
        if (value !== null && value !== undefined && value) {
            acc[key] = typeof value === 'object' ? purgeFalses(value) : value;
        }
        return acc;
    }, {} as Record<string, any>);
}

const deepMerge = deepmerge({ all: true, mergeArray: replaceByClonedSource });

export const useStateStore = defineStore('state', {
    state: () => ({
        /**
         * Indicates whether there are any unsaved changes.
         */
        isChanged: false,

        /**
         * The latest saved state. Things are only saved if they're in here
         * (items in stateChangesList are NOT saved).
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

        /**
         * Function that should be run whenever the application believes their may be changes. It will run a lot, so it should be fast!
         * @param newConfigs Up-to-date configs (en and fr) with all the new changes
         * @param origin A string indicating where the change come from. Useful for determining origin of changes for undo/redo functionality
         */
        handlePotentialChange(newConfigs: Save, origin?: string): boolean {
            newConfigs.en!.slides = newConfigs.en!.slides.map((slide) => {
                if (slide && Object.keys(slide)?.length) {
                    return purgeFalses(slide);
                } else {
                    return {};
                }
            });

            newConfigs.fr!.slides = newConfigs.fr!.slides.map((slide) => {
                if (slide && Object.keys(slide)?.length) {
                    return purgeFalses(slide);
                } else {
                    return {};
                }
            });

            // The last diff holds the sum of all diffs before it
            // AKA A diff at n holds the combined diffs 0 ... n - 1, plus any new changes
            const combinedPreviousDiffs = this.stateChangesList[this.currentLoc]?.changes ?? {
                added: {},
                deleted: {},
                updated: {}
            };

            // Determine all differences between the latest config and the latest save
            const newDiff = detailedDiff(this.latestSavedState, newConfigs);

            // There are no changes whatsoever from the last save. Set stuff accordingly.
            if (this.isDiffEmpty(newDiff)) {
                // Add an 'empty diff' to the list, indicating past changes have been erased.
                // Doing this allows the erasing to be undone too (bring back past changes).
                this.recordNewChange({
                    timestamp: Date.now(),
                    origin: origin ?? 'unknown',
                    changes: newDiff
                });

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

        /**
         * Delete all recorded diffs since the last save.
         * @param reconcile Whether to ask the app to 'refresh'.
         */
        resetAllChanges(reconcile: boolean = true): void {
            this.currentLoc = -1;
            this.stateChangesList = [];
            this.isChanged = false;
            if (reconcile) {
                this.reconcileAppState(true);
            }
        },

        // Reverts the diff at currentLoc. currentLoc will be placed at currentLoc - 1.
        // TODO: Proper implementation
        undo(): void {
            if (this.currentLoc === -1) return;

            this.currentLoc--;
            this.reconcileAppState();
        },

        // Re-applies the diff at currentLoc + 1, and sets currentLoc to that.
        // TODO: Proper implementation
        redo(): void {
            if (this.currentLoc === this.getNumberOfChanges() - 1) return;

            this.currentLoc++;
            this.reconcileAppState();
        },

        /**
         * Adds a new item to the list of recorded diffs. Sets currentLoc to the position of the new diff.
         * @param newChanges The diff to add
         */
        recordNewChange(newChanges: StateChange): void {
            // Stuff the new changes into the stack
            this.eraseSubsequentChanges(); // all changes after this should be erased
            this.isChanged = true;
            this.stateChangesList.push(newChanges);
            this.currentLoc++;
        },

        /**
         * Changes the app's state to be in line with the current stateChangesList and currentLoc.
         * Use this after applying some sort of change to the above variables (e.g. erasing all changes)
         * @param eraseAllSubsequent Whether all items after currentLoc on savedChangesList should be deleted.
         */
        reconcileAppState(eraseAllSubsequent?: boolean): void {
            // TODO: Determine if reconcileAppState works properly (currently not used much since undo/redo not implemented yet)

            // Basic philosophy: Take the current stateChangesList, compare to oldLoc, undo or redo the intermediate diffs
            // if eraseAllSubsequent is true, run eraseSubsequentChanges at end

            if (eraseAllSubsequent) {
                // Erase all changes after currentLoc
                this.eraseSubsequentChanges();
            }

            this.reconcileToggler = !this.reconcileToggler;
        },

        // Saves all current changes. Functionality for pressing the 'save' button.
        // Adds all current changes to latestSavedState; generates a config and pushes it; and resets the stateChangesList stack and currentLoc.
        save(savedConfigs: Save): void {
            savedConfigs.en!.slides = savedConfigs.en!.slides.map((slide) => {
                if (slide && Object.keys(slide)?.length) {
                    return purgeFalses(slide);
                } else {
                    return {};
                }
            });

            savedConfigs.fr!.slides = savedConfigs.fr!.slides.map((slide) => {
                if (slide && Object.keys(slide)?.length) {
                    return purgeFalses(slide);
                } else {
                    return {};
                }
            });

            this.latestSavedState = JSON.parse(JSON.stringify(savedConfigs));

            this.resetAllChanges(false);
        },

        // ====================================
        // UPDATERS AND HELPERS

        /**
         * Determines if a diff is empty. Also returns true if the diff has keys but all the values are empty (e.g. something like {a:{b:{}}} returns true).
         * @param diff The diff to check.
         */
        isDiffEmpty(diff: DetailedDiff): boolean {
            if (typeof diff !== 'object' || diff === null) {
                return false; // Non-object values won't be treated as "empty"
            }

            return Object.values(diff).every((value) => typeof value === 'object' && this.isDiffEmpty(value));
        },

        /**
         * Creates a new Save object based on the changes up to the given loc, and returns it. Non-mutating.
         * @param loc The location up to which you want changes considered for the save.
         */
        addChangesToNewSave(loc?: number): Save {
            loc = loc ?? this.currentLoc;

            const changesToAdd = this.stateChangesList[loc].changes;

            let newSave = JSON.parse(JSON.stringify(this.latestSavedState));

            // TODO: CHECK IF THIS ACTUALLY WORKS
            newSave = deepMerge(newSave, changesToAdd.added, changesToAdd.deleted, changesToAdd.updated);

            return newSave;
        },

        /**
         * Combines all changes in the state change array between the two indexes into a single object.
         * @param startLoc
         * @param endLoc
         */
        determineIntermediateChanges(startLoc?: number, endLoc?: number): DetailedDiff | undefined {
            startLoc = startLoc ?? 0;
            endLoc = endLoc ?? this.currentLoc;

            if (!this.getNumberOfChanges || startLoc >= endLoc) return undefined;

            const merged: DetailedDiff | {} = deepMerge(
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
