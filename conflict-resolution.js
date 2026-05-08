/**
 * TeamMarks — Conflict Resolution Module
 *
 * Implements Last-Write-Wins (LWW) conflict resolution for bookmark sync.
 * When two users modify the same bookmark, or when a remote deletion conflicts
 * with a local edit, this module decides which version wins.
 *
 * Identity Key: url + title + parent_path (NOT Chrome bookmark IDs)
 * Chrome IDs are per-profile and not stable across users, so we use
 * content-based identity for matching bookmarks between local and remote.
 *
 * EXPORTS (global scope for importScripts):
 *   ConflictResolver.resolve(local, remote)            → LWW winner
 *   ConflictResolver.resolveDelete(local, remoteDel)    → { undelete, winner }
 *   ConflictResolver.applyDiff(localTree, changes)      → resolved actions
 *   ConflictResolver.deduplicateByURL(bookmarks)        → deduped list
 *   ConflictResolver.identityKey(bookmark)               → string key
 */

const ConflictResolver = (() => {

    // ---------------------------------------------------------------
    // Identity Key
    // ---------------------------------------------------------------

    /**
     * Generate a content-based identity key for a bookmark.
     * Uses url + title + parent_path instead of Chrome bookmark IDs,
     * which are per-profile and not stable across users.
     *
     * @param {object} bookmark - Bookmark object with url, title, parent_path
     * @returns {string} Identity key string (empty string for null/undefined)
     */
    function identityKey(bookmark) {
        if (!bookmark) return '';
        const url = bookmark.url || '';
        const title = bookmark.title || '';
        const parentPath = bookmark.parent_path || '';
        return `${url}|${title}|${parentPath}`;
    }

    // ---------------------------------------------------------------
    // LWW Resolution
    // ---------------------------------------------------------------

    /**
     * Resolve a conflict between a local and remote bookmark using
     * Last-Write-Wins (LWW).
     *
     * Compares updated_at timestamps and returns the bookmark with the
     * later timestamp. If timestamps are equal (within 1ms tolerance),
     * the remote version wins as a systematic tiebreaker.
     *
     * @param {object|null} local - Local bookmark with updated_at (ISO string or Date)
     * @param {object|null} remote - Remote bookmark with updated_at (ISO string or Date)
     * @returns {object|null} The winning bookmark (local or remote), or null if both null
     */
    function resolve(local, remote) {
        if (!local && !remote) return null;
        if (!local) return remote;
        if (!remote) return local;

        const localTime = local.updated_at ? new Date(local.updated_at).getTime() : 0;
        const remoteTime = remote.updated_at ? new Date(remote.updated_at).getTime() : 0;

        // If timestamps are within 1ms, remote wins as tiebreaker
        if (remoteTime >= localTime) return remote;
        return local;
    }

    // ---------------------------------------------------------------
    // Delete/Edit Conflict Resolution
    // ---------------------------------------------------------------

    /**
     * Resolve a conflict between a local edit and a remote deletion.
     *
     * If the local bookmark was edited AFTER the remote deletion time,
     * the local edit wins (bookmark should be undeleted/restored).
     * Otherwise, the remote deletion wins (bookmark should be removed).
     *
     * @param {object|null} local - Local bookmark with updated_at timestamp
     * @param {object} remoteDel - Remote deletion record with deleted_at timestamp
     * @returns {{ undelete: boolean, winner: object }}
     *   undelete=true  → keep local version, re-upload to undelete remotely
     *   undelete=false → apply the deletion locally
     */
    function resolveDelete(local, remoteDel) {
        if (!remoteDel || !remoteDel.deleted_at) {
            // No valid deletion record — keep local
            return { undelete: true, winner: local };
        }

        if (!local) {
            // No local version — nothing to undelete, deletion wins
            return { undelete: false, winner: remoteDel };
        }

        const editedAt = local.updated_at ? new Date(local.updated_at).getTime() : 0;
        const deletedAt = new Date(remoteDel.deleted_at).getTime();

        // If local was edited after the remote delete, local wins (undelete)
        if (editedAt > deletedAt) {
            return { undelete: true, winner: local };
        }

        // Remote delete is newer or same time — delete wins
        return { undelete: false, winner: remoteDel };
    }

    // ---------------------------------------------------------------
    // Batch Diff Application
    // ---------------------------------------------------------------

    /**
     * Apply a batch of remote changes to local bookmarks, resolving
     * conflicts using LWW. Returns a list of actions that the sync
     * engine should execute against the Chrome bookmarks API.
     *
     * Each remote change can result in:
     *   - 'create'         — new remote bookmark, no local match → create locally
     *   - 'update'         — local match exists, remote is newer → update locally
     *   - 'keep-local'     — local match exists, local is newer → skip remote change
     *   - 'delete'         — remote deleted, no local edit after → delete locally
     *   - 'undelete'       — remote deleted, but local edited after → keep local, re-upload
     *   - 'skip-deleted-no-local' — remote deleted, no local copy → nothing to do
     *
     * @param {object[]} localBookmarks - Flat array of local bookmarks, each with
     *   url, title, parent_path, updated_at
     * @param {object[]} remoteChanges - Flat array of remote bookmark changes,
     *   each with url, title, parent_path, updated_at, and optionally deleted_at
     * @returns {object[]} Array of resolved actions, each with:
     *   { type: string, key: string, remote?: object, local?: object }
     */
    function applyDiff(localBookmarks, remoteChanges) {
        if (!Array.isArray(localBookmarks)) localBookmarks = [];
        if (!Array.isArray(remoteChanges)) return [];

        // Index local bookmarks by identity key for O(1) lookup
        const localByKey = new Map();
        for (const bm of localBookmarks) {
            const key = identityKey(bm);
            if (key) {
                localByKey.set(key, bm);
            }
        }

        const actions = [];

        for (const remote of remoteChanges) {
            const key = identityKey(remote);
            if (!key) continue;

            const local = localByKey.get(key);
            const isRemoteDeleted = !!(remote.deleted_at);

            if (!local) {
                // No local match
                if (isRemoteDeleted) {
                    // Remote says deleted, no local copy — nothing to do
                    actions.push({ type: 'skip-deleted-no-local', key, remote });
                } else {
                    // New remote bookmark — create locally
                    actions.push({ type: 'create', key, remote });
                }
            } else {
                // Local match found — resolve conflict
                if (isRemoteDeleted) {
                    const result = resolveDelete(local, remote);
                    if (result.undelete) {
                        // Local was edited after the remote delete — keep local, re-upload
                        actions.push({ type: 'undelete', key, local, remote });
                    } else {
                        // Remote delete wins — delete locally
                        actions.push({ type: 'delete', key, local, remote });
                    }
                } else {
                    // Both exist — Last-Write-Wins
                    const winner = resolve(local, remote);
                    if (winner === remote) {
                        actions.push({ type: 'update', key, local, remote });
                    } else {
                        actions.push({ type: 'keep-local', key, local, remote });
                    }
                }
            }
        }

        return actions;
    }

    // ---------------------------------------------------------------
    // URL Deduplication
    // ---------------------------------------------------------------

    /**
     * Deduplicate bookmarks that share the same URL and parent_path.
     * Keeps the most recently updated bookmark and discards older duplicates.
     *
     * This is useful when the same URL appears under the same parent folder
     * in multiple sync events — common when two users bookmark the same page.
     *
     * @param {object[]} bookmarks - Array of bookmarks to deduplicate
     * @returns {object[]} Deduplicated array, keeping the most recent of each group
     */
    function deduplicateByURL(bookmarks) {
        if (!Array.isArray(bookmarks) || bookmarks.length === 0) return [];

        const byKey = new Map();

        for (const bm of bookmarks) {
            // Use URL + parent_path as dedup key (title can differ for same URL)
            const key = `${bm.url || ''}|${bm.parent_path || ''}`;

            if (!byKey.has(key)) {
                byKey.set(key, bm);
            } else {
                // Keep the one with the later updated_at
                const existing = byKey.get(key);
                const existingTime = existing.updated_at
                    ? new Date(existing.updated_at).getTime()
                    : 0;
                const bmTime = bm.updated_at
                    ? new Date(bm.updated_at).getTime()
                    : 0;

                if (bmTime > existingTime) {
                    byKey.set(key, bm);
                }
            }
        }

        return Array.from(byKey.values());
    }

    // Return the public API
    return Object.freeze({
        resolve,
        resolveDelete,
        applyDiff,
        deduplicateByURL,
        identityKey
    });
})();