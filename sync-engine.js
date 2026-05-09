/**
 * TeamMarks — Sync Engine Module
 *
 * Core bidirectional bookmark sync between Chrome bookmarks and Supabase.
 * Handles real-time updates via Supabase Realtime, Chrome bookmark events,
 * echo guards to prevent feedback loops, and full catch-up sync on reconnect.
 *
 * Architecture:
 *   Local Change  → Chrome event → guard check → push to Supabase
 *   Remote Change  → Supabase Realtime → conflict resolve → apply to Chrome (with guard)
 *
 * EXPORTS (global scope for importScripts):
 *   SyncEngine.init()                        → Set up Chrome bookmark listeners
 *   SyncEngine.startSync(teamId)              → Subscribe to Realtime, begin sync (idempotent)
 *   SyncEngine.stopSync(teamId)               → Unsubscribe one team
 *   SyncEngine.stopAllSync()                  → Unsubscribe all teams (sign-out path)
 *   SyncEngine.fullSync(teamId)              → Full catch-up sync for a team
 *   SyncEngine.getStatus()                    → Return { teams: [...], connected, lastSync }
 *   SyncEngine.onStatusChange(callback)       → Register status listener
 *   SyncEngine.destroy()                      → Full cleanup (calls stopAllSync)
 *
 * DEPENDENCIES (load via importScripts before this file):
 *   - lib/config.js        (SUPABASE_CONFIG)
 *   - lib/supabase.js      (createSupabaseClient)
 *   - auth.js              (Auth.getSession, Auth.ensureValidSession)
 *   - team-management.js   (TeamManagement.getTeamBookmarksFolder)
 *   - conflict-resolution.js (ConflictResolver)
 */

/* global SUPABASE_CONFIG, createSupabaseClient, Auth, TeamManagement, ConflictResolver */

const SyncEngine = (() => {

    // ---------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------

    /** Storage key for ID mappings (chrome ↔ supabase) */
    const STORAGE_KEY_ID_MAP = 'teammarks_idMap';

    /** Storage key prefix for per-team last sync timestamp */
    const STORAGE_KEY_LAST_SYNC_PREFIX = 'teammarks_lastSyncTimestamp_';

    /** Storage key for per-team timestamps map */
    const STORAGE_KEY_LAST_SYNC_TIMESTAMPS = 'teammarks_lastSyncTimestamps';

    /** Storage key for echo-guard flag in chrome.storage.session */
    const SESSION_KEY_SYNCING = 'teammarks_syncing';

    /** Supabase Realtime channel name prefix */
    const CHANNEL_PREFIX = 'teammarks:';

    // ---------------------------------------------------------------
    // Multi-team state (Maps keyed by teamId)
    // ---------------------------------------------------------------

    /** @type {Set<string>} Set of currently active team IDs */
    let _activeTeamIds = new Set();

    /** @type {Map<string, string>} teamId → Chrome bookmark folder ID */
    let _teamRootFolderIds = new Map();

    /** @type {Map<string, object>} teamId → Supabase Realtime channel */
    let _realtimeChannels = new Map();

    /** @type {Map<string, boolean>} teamId → connection status */
    let _isConnected = new Map();

    /** @type {Map<string, string>} teamId → ISO timestamp of last sync */
    let _lastSyncTimestamps = new Map();

    /** @type {Map<string, string>} teamId → last error message */
    let _lastErrors = new Map();

    /** @type {Map<string, Promise>} teamId → serial sync queue */
    let _syncQueues = new Map();

    // ---------------------------------------------------------------
    // Global state (not per-team)
    // ---------------------------------------------------------------

    /**
     * @type {number} In-memory echo guard counter.
     * Incremented before programmatic Chrome bookmark writes,
     * decremented after. Event handlers skip when counter > 0.
     * Must remain global — Chrome bookmark events have no team context.
     */
    let _syncWriteDepth = 0;

    /** @type {Function[]} Status change listeners */
    const _statusListeners = [];

    /** @type {Function[]} Chrome bookmark listener removal functions */
    let _chromeListenerRemovers = [];

    /** @type {boolean} Whether init() has been called */
    let _initialized = false;

    /**
     * @type {{ chromeToSupabase: object, supabaseToChrome: object }}
     * ID mapping between Chrome bookmark IDs and Supabase bookmark UUIDs.
     * Global (Chrome IDs are globally unique; no namespacing needed per team).
     * Persisted in chrome.storage.local.
     */
    let _idMap = { chromeToSupabase: {}, supabaseToChrome: {} };

    // ---------------------------------------------------------------
    // Private helpers — Status notifications
    // ---------------------------------------------------------------

    /**
     * Notify all registered status listeners of a state change.
     * @param {object} status - The current sync status
     */
    function _notifyStatusListeners(status) {
        for (const fn of _statusListeners) {
            try {
                fn(status);
            } catch (err) {
                console.error('[TeamMarks Sync] Status listener error:', err);
            }
        }
    }

    /**
     * Update internal status for a team and notify listeners.
     * @param {string} teamId
     * @param {object} overrides - Status fields to update
     */
    function _updateStatus(teamId, overrides = {}) {
        if (overrides.connected !== undefined) _isConnected.set(teamId, overrides.connected);
        if (overrides.lastSync !== undefined) _lastSyncTimestamps.set(teamId, overrides.lastSync);
        if (overrides.error !== undefined) {
            if (overrides.error === null) {
                _lastErrors.delete(teamId);
            } else {
                _lastErrors.set(teamId, overrides.error);
            }
        }

        const status = getStatus();
        _notifyStatusListeners(status);
    }

    // ---------------------------------------------------------------
    // Private helpers — Supabase & Auth
    // ---------------------------------------------------------------

    /**
     * Get a Supabase client, throwing if unavailable.
     * @returns {object} Supabase client
     * @throws {Error} If client is unavailable
     */
    function _getSupabase() {
        const supabase = createSupabaseClient();
        if (!supabase) {
            throw new Error('[TeamMarks Sync] Supabase client not available. Check config and auth.');
        }
        return supabase;
    }

    /**
     * Get the current user's ID from Auth module.
     * @returns {string|null} User ID or null
     */
    function _getUserId() {
        const session = Auth.getSession();
        return session ? session.userId : null;
    }

    // ---------------------------------------------------------------
    // Private helpers — Echo guard (global — Chrome events have no team context)
    // ---------------------------------------------------------------

    /**
     * Set the echo guard flag (in-memory + chrome.storage.session).
     * Must be called BEFORE any programmatic Chrome bookmark writes.
     * @returns {Promise<void>}
     */
    async function _setEchoGuard() {
        _syncWriteDepth++;
        try {
            await chrome.storage.session.set({ [SESSION_KEY_SYNCING]: true });
        } catch (err) {
            console.warn('[TeamMarks Sync] Failed to set session echo guard:', err);
        }
    }

    /**
     * Clear the echo guard flag.
     * Must be called AFTER all programmatic Chrome bookmark writes complete.
     * @returns {Promise<void>}
     */
    async function _clearEchoGuard() {
        _syncWriteDepth = Math.max(0, _syncWriteDepth - 1);
        try {
            if (_syncWriteDepth === 0) {
                await chrome.storage.session.remove(SESSION_KEY_SYNCING);
            }
        } catch (err) {
            console.warn('[TeamMarks Sync] Failed to clear session echo guard:', err);
        }
    }

    /**
     * Check whether an event should be skipped due to the echo guard.
     * Checks both in-memory flag and chrome.storage.session.
     * @returns {Promise<boolean>} true if event should be skipped
     */
    async function _isEchoGuarded() {
        // Fast path: in-memory check (synchronous)
        if (_syncWriteDepth > 0) return true;

        // Slow path: session storage check (for cases where SW restarted mid-write)
        try {
            const result = await chrome.storage.session.get(SESSION_KEY_SYNCING);
            return !!result[SESSION_KEY_SYNCING];
        } catch (_) {
            return false;
        }
    }

    // ---------------------------------------------------------------
    // Private helpers — Per-team serial sync queue
    // ---------------------------------------------------------------

    /**
     * Enqueue a sync operation onto the per-team serial Promise queue.
     * Prevents fullSync operations for the same team from interleaving.
     *
     * @param {string} teamId
     * @param {Function} fn - Async function to run in sequence
     * @returns {Promise<any>}
     */
    function _enqueueSyncOp(teamId, fn) {
        const current = _syncQueues.get(teamId) || Promise.resolve();
        const next = current.then(() => fn()).catch(err => {
            console.error(`[TeamMarks Sync] Queued sync op failed for team ${teamId}:`, err);
        });
        _syncQueues.set(teamId, next);
        return next;
    }

    // ---------------------------------------------------------------
    // Private helpers — ID mapping
    // ---------------------------------------------------------------

    /**
     * Load the ID map from chrome.storage.local.
     * @returns {Promise<void>}
     */
    async function _loadIdMap() {
        try {
            const result = await chrome.storage.local.get(STORAGE_KEY_ID_MAP);
            _idMap = result[STORAGE_KEY_ID_MAP] || { chromeToSupabase: {}, supabaseToChrome: {} };
        } catch (err) {
            console.error('[TeamMarks Sync] Failed to load ID map:', err);
            _idMap = { chromeToSupabase: {}, supabaseToChrome: {} };
        }
    }

    /**
     * Persist the ID map to chrome.storage.local.
     * @returns {Promise<void>}
     */
    async function _saveIdMap() {
        try {
            await chrome.storage.local.set({ [STORAGE_KEY_ID_MAP]: _idMap });
        } catch (err) {
            console.error('[TeamMarks Sync] Failed to save ID map:', err);
        }
    }

    /**
     * Record a mapping between a Chrome bookmark ID and a Supabase bookmark ID.
     * @param {string} chromeId - Chrome bookmark tree node ID
     * @param {string} supabaseId - Supabase bookmarks table UUID
     * @returns {Promise<void>}
     */
    async function _addIdMapping(chromeId, supabaseId) {
        _idMap.chromeToSupabase[chromeId] = supabaseId;
        _idMap.supabaseToChrome[supabaseId] = chromeId;
        await _saveIdMap();
    }

    /**
     * Remove a mapping by Chrome bookmark ID.
     * @param {string} chromeId - Chrome bookmark node ID
     * @returns {Promise<void>}
     */
    async function _removeIdMappingByChromeId(chromeId) {
        const supabaseId = _idMap.chromeToSupabase[chromeId];
        if (supabaseId) {
            delete _idMap.supabaseToChrome[supabaseId];
        }
        delete _idMap.chromeToSupabase[chromeId];
        await _saveIdMap();
    }

    /**
     * Remove a mapping by Supabase bookmark ID.
     * @param {string} supabaseId - Supabase bookmarks table UUID
     * @returns {Promise<void>}
     */
    async function _removeIdMappingBySupabaseId(supabaseId) {
        const chromeId = _idMap.supabaseToChrome[supabaseId];
        if (chromeId) {
            delete _idMap.chromeToSupabase[chromeId];
        }
        delete _idMap.supabaseToChrome[supabaseId];
        await _saveIdMap();
    }

    /**
     * Look up the Supabase UUID for a Chrome bookmark ID.
     * @param {string} chromeId - Chrome bookmark node ID
     * @returns {string|undefined} Supabase UUID or undefined
     */
    function _getSupabaseId(chromeId) {
        return _idMap.chromeToSupabase[chromeId];
    }

    /**
     * Look up the Chrome bookmark ID for a Supabase UUID.
     * @param {string} supabaseId - Supabase bookmarks table UUID
     * @returns {string|undefined} Chrome bookmark ID or undefined
     */
    function _getChromeId(supabaseId) {
        return _idMap.supabaseToChrome[supabaseId];
    }

    // ---------------------------------------------------------------
    // Private helpers — Bookmark tree utilities
    // ---------------------------------------------------------------

    /**
     * Check whether a Chrome bookmark is inside the team's sync folder.
     * Walks up the Chrome ancestry and returns true if the team root is found.
     *
     * @param {string} chromeId - The bookmark ID to check
     * @param {string} teamId - The team whose root folder to check against
     * @returns {Promise<boolean>}
     */
    async function _isInTeamTree(chromeId, teamId) {
        const rootId = _teamRootFolderIds.get(teamId);
        if (!rootId) return false;

        let currentId = chromeId;
        const maxDepth = 20;

        for (let i = 0; i < maxDepth; i++) {
            if (currentId === rootId) return true;
            if (!currentId || currentId === '0') return false;

            try {
                const nodes = await chrome.bookmarks.get(currentId);
                if (!nodes || nodes.length === 0) return false;
                currentId = nodes[0].parentId;
            } catch (_) {
                return false;
            }
        }

        return false;
    }

    /**
     * Find which active team (if any) owns the given Chrome bookmark.
     * Checks each active team's root folder ancestry.
     *
     * @param {string} chromeId - The bookmark ID to check
     * @returns {Promise<string|null>} teamId or null
     */
    async function _findTeamForChrome(chromeId) {
        for (const teamId of _activeTeamIds) {
            if (await _isInTeamTree(chromeId, teamId)) {
                return teamId;
            }
        }
        return null;
    }

    /**
     * Flatten a Chrome bookmark tree node into a flat array.
     * Each item gets a parentPath computed relative to the sync folder root.
     * @param {object} node - A Chrome bookmark tree node
     * @param {string} teamId - The team whose root folder defines the boundary
     * @param {string} parentPath - Path of the parent (empty for root)
     * @returns {object[]} Flat array of bookmark items with parentPath
     */
    function _flattenBookmarkTree(node, teamId, parentPath = '') {
        const teamRootFolderId = _teamRootFolderIds.get(teamId);
        const results = [];
        const isFolder = !node.url; // Chrome folders have no url property

        if (node.id !== teamRootFolderId) {
            // Only add non-root items
            results.push({
                chromeId: node.id,
                parentId: node.parentId,
                title: node.title || '',
                url: node.url || null,
                isFolder: isFolder,
                parentPath: parentPath
            });
        }

        // Recurse into children if this is a folder
        if (isFolder && node.children) {
            const childPath = node.id === teamRootFolderId
                ? '/'
                : (parentPath === '/' ? `/${node.title}` : `${parentPath}/${node.title}`);

            for (const child of node.children) {
                results.push(..._flattenBookmarkTree(child, teamId, childPath));
            }
        }

        return results;
    }

    /**
     * Build a Supabase bookmark object from a Chrome bookmark.
     * Includes parent_id resolution via the ID map.
     * @param {object} chromeBookmark - A Chrome bookmark node
     * @param {string} teamId - The team this bookmark belongs to
     * @returns {object} Supabase-compatible bookmark object
     */
    function _chromeBookmarkToSupabase(chromeBookmark, teamId) {
        const isFolder = !chromeBookmark.url;
        const teamRootFolderId = _teamRootFolderIds.get(teamId);

        // Resolve parent_id
        let parentId = null;
        if (chromeBookmark.parentId && chromeBookmark.parentId !== teamRootFolderId) {
            parentId = _getSupabaseId(chromeBookmark.parentId) || null;
        }

        return {
            team_id: teamId,
            parent_id: parentId,
            title: chromeBookmark.title || '',
            url: chromeBookmark.url || null,
            is_folder: isFolder,
            sort_order: chromeBookmark.index || 0,
            last_modified_by: _getUserId()
        };
    }

    /**
     * Resolve the Chrome parentId for a Supabase bookmark.
     * If parent_id is null, the bookmark goes under the sync folder root.
     * Otherwise, looks up the Chrome ID from the ID map.
     * @param {string|null} supabaseParentId - Supabase parent UUID
     * @param {string} teamId - The team this belongs to
     * @returns {string} Chrome parentId (the sync folder ID or a mapped folder ID)
     */
    function _resolveChromeParentId(supabaseParentId, teamId) {
        const teamRootFolderId = _teamRootFolderIds.get(teamId);
        if (!supabaseParentId) {
            return teamRootFolderId;
        }
        return _getChromeId(supabaseParentId) || teamRootFolderId;
    }

    // ---------------------------------------------------------------
    // Chrome bookmark event handlers (Local → Remote)
    // ---------------------------------------------------------------

    /**
     * Handle chrome.bookmarks.onCreated.
     * Pushes the new bookmark to Supabase if it's in an active team's folder.
     * @param {string} id - Chrome bookmark ID
     * @param {object} bookmark - Chrome bookmark tree node
     */
    async function _onBookmarkCreated(id, bookmark) {
        if (_activeTeamIds.size === 0) return;

        const guarded = await _isEchoGuarded();
        if (guarded) {
            console.debug('[TeamMarks Sync] Skipping onCreated (echo guard):', id);
            return;
        }

        const teamId = await _findTeamForChrome(id);
        if (!teamId) return;

        console.info('[TeamMarks Sync] Local bookmark created:', bookmark.title || id);

        try {
            const supabase = _getSupabase();

            // Check if we already have a mapping (e.g., from a previous partial sync)
            const existingSupabaseId = _getSupabaseId(id);
            if (existingSupabaseId) {
                const updateData = _chromeBookmarkToSupabase(bookmark, teamId);
                const { error } = await supabase
                    .from('bookmarks')
                    .update({ ...updateData, updated_at: new Date().toISOString() })
                    .eq('id', existingSupabaseId);

                if (error) {
                    console.error('[TeamMarks Sync] Failed to update bookmark on create:', error);
                    _updateStatus(teamId, { error: error.message });
                }
                return;
            }

            const insertData = _chromeBookmarkToSupabase(bookmark, teamId);
            const { data, error } = await supabase
                .from('bookmarks')
                .insert(insertData)
                .select()
                .single();

            if (error) {
                console.error('[TeamMarks Sync] Failed to push new bookmark:', error);
                _updateStatus(teamId, { error: error.message });
                return;
            }

            if (data && data.id) {
                await _addIdMapping(id, data.id);
            }

            console.info('[TeamMarks Sync] Pushed bookmark to Supabase:', data?.id);
        } catch (err) {
            console.error('[TeamMarks Sync] Error in onBookmarkCreated:', err);
            _updateStatus(teamId, { error: err.message });
        }
    }

    /**
     * Handle chrome.bookmarks.onChanged.
     * Pushes the change to Supabase if the bookmark is in an active team folder.
     * @param {string} id - Chrome bookmark ID
     * @param {object} changeInfo - Object with changed properties (title, url)
     */
    async function _onBookmarkChanged(id, changeInfo) {
        if (_activeTeamIds.size === 0) return;

        const guarded = await _isEchoGuarded();
        if (guarded) {
            console.debug('[TeamMarks Sync] Skipping onChanged (echo guard):', id);
            return;
        }

        const teamId = await _findTeamForChrome(id);
        if (!teamId) return;

        const supabaseId = _getSupabaseId(id);
        if (!supabaseId) {
            console.debug('[TeamMarks Sync] Changed bookmark not mapped, treating as create:', id);
            try {
                const nodes = await chrome.bookmarks.get(id);
                if (nodes && nodes.length > 0) {
                    await _onBookmarkCreated(id, nodes[0]);
                }
            } catch (_) { /* best effort */ }
            return;
        }

        console.info('[TeamMarks Sync] Local bookmark changed:', changeInfo.title || id);

        try {
            const supabase = _getSupabase();
            const updateData = {
                title: changeInfo.title !== undefined ? changeInfo.title : undefined,
                url: changeInfo.url !== undefined ? changeInfo.url : undefined,
                last_modified_by: _getUserId(),
                updated_at: new Date().toISOString()
            };

            Object.keys(updateData).forEach(key =>
                updateData[key] === undefined && delete updateData[key]
            );

            const { error } = await supabase
                .from('bookmarks')
                .update(updateData)
                .eq('id', supabaseId);

            if (error) {
                console.error('[TeamMarks Sync] Failed to push bookmark change:', error);
                _updateStatus(teamId, { error: error.message });
            }
        } catch (err) {
            console.error('[TeamMarks Sync] Error in onBookmarkChanged:', err);
            _updateStatus(teamId, { error: err.message });
        }
    }

    /**
     * Handle chrome.bookmarks.onMoved.
     * Pushes the move (parent change) to Supabase.
     * @param {string} id - Chrome bookmark ID
     * @param {object} moveInfo - { parentId, index, oldParentId, oldIndex }
     */
    async function _onBookmarkMoved(id, moveInfo) {
        if (_activeTeamIds.size === 0) return;

        const guarded = await _isEchoGuarded();
        if (guarded) {
            console.debug('[TeamMarks Sync] Skipping onMoved (echo guard):', id);
            return;
        }

        // Determine team context from either the old or new parent
        const teamIdFromNew = await _findTeamForChrome(id);
        const teamIdFromOld = await _findTeamForChrome(moveInfo.oldParentId);
        const teamId = teamIdFromNew || teamIdFromOld;

        if (!teamId) return;

        const wasInFolder = !!teamIdFromOld;
        const isInFolder = !!teamIdFromNew;

        console.info('[TeamMarks Sync] Local bookmark moved:', id);

        try {
            const supabaseId = _getSupabaseId(id);

            if (!supabaseId) {
                if (isInFolder) {
                    const nodes = await chrome.bookmarks.get(id);
                    if (nodes && nodes.length > 0) {
                        await _onBookmarkCreated(id, nodes[0]);
                    }
                }
                return;
            }

            if (!isInFolder) {
                // Moved OUT of our folder — soft-delete on Supabase
                const supabase = _getSupabase();
                const { error } = await supabase
                    .from('bookmarks')
                    .update({
                        deleted_at: new Date().toISOString(),
                        last_modified_by: _getUserId(),
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', supabaseId);

                if (error) {
                    console.error('[TeamMarks Sync] Failed to soft-delete moved-out bookmark:', error);
                }

                await _removeIdMappingByChromeId(id);
                return;
            }

            // Moved within our folder — update parent and sort order
            const supabase = _getSupabase();
            const nodes = await chrome.bookmarks.get(id);
            if (!nodes || nodes.length === 0) return;

            const bookmark = nodes[0];
            const teamRootFolderId = _teamRootFolderIds.get(teamId);
            const updateData = {
                parent_id: bookmark.parentId === teamRootFolderId
                    ? null
                    : (_getSupabaseId(bookmark.parentId) || null),
                sort_order: moveInfo.index,
                last_modified_by: _getUserId(),
                updated_at: new Date().toISOString()
            };

            const { error } = await supabase
                .from('bookmarks')
                .update(updateData)
                .eq('id', supabaseId);

            if (error) {
                console.error('[TeamMarks Sync] Failed to push bookmark move:', error);
                _updateStatus(teamId, { error: error.message });
            }
        } catch (err) {
            console.error('[TeamMarks Sync] Error in onBookmarkMoved:', err);
            _updateStatus(teamId, { error: err.message });
        }
    }

    /**
     * Handle chrome.bookmarks.onRemoved.
     * Soft-deletes the bookmark on Supabase.
     * @param {string} id - Chrome bookmark ID
     * @param {object} removeInfo - { parentId, index, node }
     */
    async function _onBookmarkRemoved(id, removeInfo) {
        if (_activeTeamIds.size === 0) return;

        const guarded = await _isEchoGuarded();
        if (guarded) {
            console.debug('[TeamMarks Sync] Skipping onRemoved (echo guard):', id);
            return;
        }

        const supabaseId = _getSupabaseId(id);
        if (!supabaseId) {
            return;
        }

        // Find team by looking up the supabase ID (already mapped)
        // We can't walk Chrome ancestry since the node is removed; use idMap to find team
        let teamId = null;
        for (const tid of _activeTeamIds) {
            // Best effort: use whatever active team we have since the bookmark is already gone
            teamId = tid;
            break;
        }

        console.info('[TeamMarks Sync] Local bookmark removed:', id);

        try {
            const supabase = _getSupabase();
            const { error } = await supabase
                .from('bookmarks')
                .update({
                    deleted_at: new Date().toISOString(),
                    last_modified_by: _getUserId(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', supabaseId);

            if (error) {
                console.error('[TeamMarks Sync] Failed to soft-delete bookmark:', error);
                if (teamId) _updateStatus(teamId, { error: error.message });
            }

            await _removeIdMappingByChromeId(id);
        } catch (err) {
            console.error('[TeamMarks Sync] Error in onBookmarkRemoved:', err);
            if (teamId) _updateStatus(teamId, { error: err.message });
        }
    }

    /**
     * Handle chrome.bookmarks.onChildrenReordered.
     * Updates sort_order for all children on Supabase.
     * @param {string} id - Chrome bookmark folder ID
     * @param {object} reorderInfo - { childIds }
     */
    async function _onBookmarkChildrenReordered(id, reorderInfo) {
        if (_activeTeamIds.size === 0) return;

        const guarded = await _isEchoGuarded();
        if (guarded) {
            console.debug('[TeamMarks Sync] Skipping onChildrenReordered (echo guard):', id);
            return;
        }

        const teamId = await _findTeamForChrome(id);
        if (!teamId) return;

        console.info('[TeamMarks Sync] Local bookmark children reordered:', id);

        try {
            const supabase = _getSupabase();

            for (let index = 0; index < reorderInfo.childIds.length; index++) {
                const childId = reorderInfo.childIds[index];
                const supabaseId = _getSupabaseId(childId);
                if (!supabaseId) continue;

                await supabase
                    .from('bookmarks')
                    .update({
                        sort_order: index,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', supabaseId);
            }
        } catch (err) {
            console.error('[TeamMarks Sync] Error in onBookmarkChildrenReordered:', err);
            _updateStatus(teamId, { error: err.message });
        }
    }

    /**
     * Register Chrome bookmark event listeners.
     * Stores removal functions for cleanup.
     */
    function _registerChromeListeners() {
        _unregisterChromeListeners();

        const listeners = {
            onCreated: _onBookmarkCreated,
            onChanged: _onBookmarkChanged,
            onMoved: _onBookmarkMoved,
            onRemoved: _onBookmarkRemoved,
            onChildrenReordered: _onBookmarkChildrenReordered
        };

        chrome.bookmarks.onCreated.addListener(listeners.onCreated);
        chrome.bookmarks.onChanged.addListener(listeners.onChanged);
        chrome.bookmarks.onMoved.addListener(listeners.onMoved);
        chrome.bookmarks.onRemoved.addListener(listeners.onRemoved);
        chrome.bookmarks.onChildrenReordered.addListener(listeners.onChildrenReordered);

        _chromeListenerRemovers = [
            () => chrome.bookmarks.onCreated.removeListener(listeners.onCreated),
            () => chrome.bookmarks.onChanged.removeListener(listeners.onChanged),
            () => chrome.bookmarks.onMoved.removeListener(listeners.onMoved),
            () => chrome.bookmarks.onRemoved.removeListener(listeners.onRemoved),
            () => chrome.bookmarks.onChildrenReordered.removeListener(listeners.onChildrenReordered)
        ];
    }

    /**
     * Remove all Chrome bookmark event listeners.
     */
    function _unregisterChromeListeners() {
        for (const remover of _chromeListenerRemovers) {
            try { remover(); } catch (_) { /* best effort */ }
        }
        _chromeListenerRemovers = [];
    }

    // ---------------------------------------------------------------
    // Supabase Realtime handler (Remote → Local)
    // ---------------------------------------------------------------

    /**
     * Handle a Supabase Realtime postgres_changes event for a specific team.
     * @param {string} teamId - The team this channel belongs to
     * @param {object} payload - Supabase Realtime payload
     */
    async function _handleRealtimeEvent(teamId, payload) {
        const { eventType, new: newRecord, old: oldRecord } = payload;

        const teamRootFolderId = _teamRootFolderIds.get(teamId);
        if (!teamRootFolderId) {
            console.debug('[TeamMarks Sync] Ignoring Realtime event — no folder for team:', teamId);
            return;
        }

        // Verify the event is for our team
        const recordTeamId = (newRecord && newRecord.team_id) || (oldRecord && oldRecord.team_id);
        if (recordTeamId && recordTeamId !== teamId) {
            return;
        }

        // Skip our own writes (compare last_modified_by)
        const userId = _getUserId();
        if (newRecord && newRecord.last_modified_by === userId) {
            const chromeId = _getChromeId(newRecord.id);
            if (chromeId) {
                console.debug('[TeamMarks Sync] Skipping Realtime event (own write):', newRecord.id);
                return;
            }
        }

        console.info('[TeamMarks Sync] Realtime event:', eventType, newRecord?.id || oldRecord?.id);

        try {
            switch (eventType) {
                case 'INSERT':
                    await _applyRemoteInsert(newRecord, teamId);
                    break;
                case 'UPDATE':
                    await _applyRemoteUpdate(newRecord, oldRecord, teamId);
                    break;
                case 'DELETE':
                    await _applyRemoteDelete(oldRecord);
                    break;
                default:
                    console.warn('[TeamMarks Sync] Unknown Realtime event type:', eventType);
            }
        } catch (err) {
            console.error('[TeamMarks Sync] Error handling Realtime event:', err);
            _updateStatus(teamId, { error: err.message });
        }
    }

    /**
     * Apply a remote INSERT by creating a Chrome bookmark.
     * @param {object} record - The new Supabase bookmark record
     * @param {string} teamId - The team this belongs to
     */
    async function _applyRemoteInsert(record, teamId) {
        if (!record) return;

        if (record.deleted_at) return;

        const existingChromeId = _getChromeId(record.id);
        if (existingChromeId) {
            try {
                const nodes = await chrome.bookmarks.get(existingChromeId);
                if (nodes && nodes.length > 0) {
                    console.debug('[TeamMarks Sync] Local bookmark already exists for:', record.id);
                    return;
                }
            } catch (_) {
                await _removeIdMappingBySupabaseId(record.id);
            }
        }

        const chromeParentId = _resolveChromeParentId(record.parent_id, teamId);

        await _setEchoGuard();
        try {
            const createParams = {
                parentId: chromeParentId,
                title: record.title || '',
                index: record.sort_order || 0
            };

            if (!record.is_folder && record.url) {
                createParams.url = record.url;
            }

            const chromeResult = await chrome.bookmarks.create(createParams);

            if (chromeResult && chromeResult.id) {
                await _addIdMapping(chromeResult.id, record.id);
                console.info('[TeamMarks Sync] Created local bookmark from remote:', chromeResult.id);
            }
        } finally {
            await _clearEchoGuard();
        }
    }

    /**
     * Apply a remote UPDATE by modifying a Chrome bookmark.
     * @param {object} newRecord - The updated Supabase record
     * @param {object} oldRecord - The previous Supabase record
     * @param {string} teamId - The team this belongs to
     */
    async function _applyRemoteUpdate(newRecord, oldRecord, teamId) {
        if (!newRecord) return;

        if (newRecord.deleted_at) {
            await _applyRemoteDelete(oldRecord || newRecord);
            return;
        }

        const recordId = newRecord.id;
        let chromeId = _getChromeId(recordId);

        if (!chromeId) {
            console.debug('[TeamMarks Sync] Update for unmapped bookmark, applying as insert:', recordId);
            await _applyRemoteInsert(newRecord, teamId);
            return;
        }

        try {
            const nodes = await chrome.bookmarks.get(chromeId);
            if (!nodes || nodes.length === 0) {
                await _removeIdMappingBySupabaseId(recordId);
                await _applyRemoteInsert(newRecord, teamId);
                return;
            }
        } catch (_) {
            await _removeIdMappingBySupabaseId(recordId);
            await _applyRemoteInsert(newRecord, teamId);
            return;
        }

        await _setEchoGuard();
        try {
            const updateParams = { title: newRecord.title || '' };
            if (!newRecord.is_folder && newRecord.url) {
                updateParams.url = newRecord.url;
            }
            await chrome.bookmarks.update(chromeId, updateParams);

            const newChromeParentId = _resolveChromeParentId(newRecord.parent_id, teamId);
            const currentBookmark = (await chrome.bookmarks.get(chromeId))[0];
            if (currentBookmark.parentId !== newChromeParentId || currentBookmark.index !== newRecord.sort_order) {
                await chrome.bookmarks.move(chromeId, {
                    parentId: newChromeParentId,
                    index: newRecord.sort_order || 0
                });
            }

            console.info('[TeamMarks Sync] Updated local bookmark from remote:', chromeId);
        } finally {
            await _clearEchoGuard();
        }
    }

    /**
     * Apply a remote DELETE by removing a Chrome bookmark.
     * @param {object} record - The deleted Supabase record (old values)
     */
    async function _applyRemoteDelete(record) {
        if (!record) return;

        const recordId = record.id;
        const chromeId = _getChromeId(recordId);

        if (!chromeId) {
            return;
        }

        await _setEchoGuard();
        try {
            try {
                await chrome.bookmarks.removeTree(chromeId);
                console.info('[TeamMarks Sync] Removed local bookmark tree from remote delete:', chromeId);
            } catch (_) {
                try {
                    await chrome.bookmarks.remove(chromeId);
                    console.info('[TeamMarks Sync] Removed local bookmark from remote delete:', chromeId);
                } catch (__) {
                    console.debug('[TeamMarks Sync] Bookmark already removed:', chromeId);
                }
            }

            await _removeIdMappingBySupabaseId(recordId);
        } finally {
            await _clearEchoGuard();
        }
    }

    // ---------------------------------------------------------------
    // Supabase Realtime subscription management
    // ---------------------------------------------------------------

    /**
     * Subscribe to Supabase Realtime postgres_changes for a specific team.
     * @param {string} teamId
     * @returns {Promise<void>}
     */
    async function _subscribeToRealtime(teamId) {
        // Unsubscribe from existing channel for this team if any
        await _unsubscribeFromRealtime(teamId);

        const supabase = _getSupabase();

        const channelName = `${CHANNEL_PREFIX}${teamId}`;
        console.info('[TeamMarks Sync] Subscribing to Realtime channel:', channelName);

        const channel = supabase
            .channel(channelName)
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'bookmarks',
                filter: `team_id=eq.${teamId}`
            }, (payload) => _handleRealtimeEvent(teamId, payload))
            .subscribe((status, err) => {
                if (status === 'SUBSCRIBED') {
                    console.info('[TeamMarks Sync] Realtime subscribed to:', channelName);
                    _updateStatus(teamId, { connected: true, error: null });
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    console.error('[TeamMarks Sync] Realtime error:', status, err);
                    _updateStatus(teamId, { connected: false, error: `Realtime ${status}` });
                } else if (status === 'CLOSED') {
                    console.info('[TeamMarks Sync] Realtime channel closed for team:', teamId);
                    _updateStatus(teamId, { connected: false });
                }
            });

        _realtimeChannels.set(teamId, channel);
    }

    /**
     * Unsubscribe from the Supabase Realtime channel for a specific team.
     * @param {string} teamId
     * @returns {Promise<void>}
     */
    async function _unsubscribeFromRealtime(teamId) {
        const channel = _realtimeChannels.get(teamId);
        if (channel) {
            try {
                const supabase = _getSupabase();
                if (supabase) {
                    await supabase.removeChannel(channel);
                }
            } catch (err) {
                console.warn('[TeamMarks Sync] Error removing Realtime channel for team', teamId, ':', err);
            }
            _realtimeChannels.delete(teamId);
        }
        _isConnected.set(teamId, false);
    }

    // ---------------------------------------------------------------
    // Full sync (catch-up)
    // ---------------------------------------------------------------

    /**
     * Build a map of supabaseId → full folder path for all remote folders.
     * Used by fullSync to resolve parent_path before calling applyDiff.
     *
     * Performs two passes to handle folders arriving out of order.
     *
     * @param {object[]} remoteFolders - Remote bookmark records where is_folder=true
     * @returns {Map<string, string>} supabaseId → path string
     */
    function _buildRemotePathMap(remoteFolders) {
        const pathMap = new Map();

        const remaining = [];
        for (const folder of remoteFolders) {
            if (!folder.parent_id) {
                pathMap.set(folder.id, `/${folder.title}`);
            } else if (pathMap.has(folder.parent_id)) {
                const parentPath = pathMap.get(folder.parent_id);
                pathMap.set(folder.id, `${parentPath}/${folder.title}`);
            } else {
                remaining.push(folder);
            }
        }

        for (const folder of remaining) {
            const parentPath = pathMap.get(folder.parent_id);
            if (parentPath !== undefined) {
                pathMap.set(folder.id, `${parentPath}/${folder.title}`);
            } else {
                console.debug('[TeamMarks Sync] _buildRemotePathMap: orphaned folder, placing at root:', folder.id);
                pathMap.set(folder.id, `/${folder.title}`);
            }
        }

        return pathMap;
    }

    /**
     * Perform a full catch-up sync for a specific team:
     * 1. Pull all bookmarks for the team from Supabase
     * 2. Get all Chrome bookmarks in the team's sync folder
     * 3. Compare using ConflictResolver.applyDiff
     * 4. Apply the resulting actions
     *
     * @param {string} teamId - UUID of the team to sync
     * @returns {Promise<void>}
     */
    async function fullSync(teamId) {
        if (!teamId) {
            console.warn('[TeamMarks Sync] Cannot fullSync — teamId is required.');
            return;
        }

        const teamRootFolderId = _teamRootFolderIds.get(teamId);
        if (!teamRootFolderId) {
            console.warn('[TeamMarks Sync] Cannot fullSync for team', teamId, '— no folder mapped.');
            return;
        }

        console.info('[TeamMarks Sync] Starting full sync for team:', teamId);
        _updateStatus(teamId, { error: null });

        try {
            const supabase = _getSupabase();

            // 1. Pull all active (non-deleted) bookmarks for the team from Supabase
            const { data: remoteBookmarks, error: fetchError } = await supabase
                .from('bookmarks')
                .select('*')
                .eq('team_id', teamId)
                .is('deleted_at', null)
                .order('sort_order', { ascending: true });

            if (fetchError) {
                throw new Error(`Failed to fetch remote bookmarks: ${fetchError.message}`);
            }

            // 2. Get all Chrome bookmarks in the team's sync folder
            let localBookmarks = [];
            try {
                const subtree = await chrome.bookmarks.getSubTree(teamRootFolderId);
                if (subtree && subtree.length > 0) {
                    localBookmarks = _flattenBookmarkTree(subtree[0], teamId);
                }
            } catch (err) {
                console.error('[TeamMarks Sync] Failed to get local bookmarks:', err);
                throw new Error(`Failed to read local bookmarks: ${err.message}`);
            }

            // 3. Prepare data for ConflictResolver
            const remoteFolderRecords = (remoteBookmarks || []).filter(bm => bm.is_folder);
            const pathMap = _buildRemotePathMap(remoteFolderRecords);

            const remoteChanges = (remoteBookmarks || []).map(bm => ({
                id: bm.id,
                url: bm.url,
                title: bm.title,
                is_folder: bm.is_folder,
                parent_id: bm.parent_id,
                sort_order: bm.sort_order,
                updated_at: bm.updated_at,
                deleted_at: bm.deleted_at,
                parent_path: bm.parent_id ? (pathMap.get(bm.parent_id) || '/') : '/'
            }));

            const localItems = localBookmarks.map(bm => ({
                chromeId: bm.chromeId,
                parentId: bm.parentId,
                url: bm.url,
                title: bm.title,
                is_folder: bm.isFolder,
                parent_path: bm.parentPath,
                updated_at: null,
                identity_key: ConflictResolver.identityKey(bm)
            }));

            // Sort remote: folders first
            const remoteFoldersForSort = remoteChanges.filter(bm => bm.is_folder);
            const remoteUrlsForSort = remoteChanges.filter(bm => !bm.is_folder);
            const sortedRemote = [...remoteFoldersForSort, ...remoteUrlsForSort];

            const actions = ConflictResolver.applyDiff(localItems, sortedRemote);

            await _setEchoGuard();
            try {
                for (const action of actions) {
                    switch (action.type) {
                        case 'create':
                            await _applyRemoteInsert(action.remote, teamId);
                            break;

                        case 'update': {
                            const localChromeId = action.local && action.local.chromeId;
                            if (localChromeId && !_getChromeId(action.remote.id)) {
                                const staleSupabaseId = _getSupabaseId(localChromeId);
                                if (staleSupabaseId && staleSupabaseId !== action.remote.id) {
                                    await _removeIdMappingBySupabaseId(staleSupabaseId);
                                }
                                await _addIdMapping(localChromeId, action.remote.id);
                            }
                            await _applyRemoteUpdate(action.remote, action.local, teamId);
                            break;
                        }

                        case 'keep-local':
                            break;

                        case 'delete':
                            await _applyRemoteDelete(action.remote);
                            break;

                        case 'undelete':
                            try {
                                const nodes = await chrome.bookmarks.get(action.local.chromeId);
                                if (nodes && nodes.length > 0) {
                                    await _onBookmarkCreated(action.local.chromeId, nodes[0]);
                                }
                            } catch (err) {
                                console.warn('[TeamMarks Sync] Undelete failed for:', action.local.chromeId, err);
                            }
                            break;

                        default:
                            break;
                    }
                }

                // Push local bookmarks that don't exist remotely
                for (const local of localItems) {
                    const supabaseId = _getSupabaseId(local.chromeId);
                    if (!supabaseId) {
                        try {
                            const nodes = await chrome.bookmarks.get(local.chromeId);
                            if (nodes && nodes.length > 0) {
                                if (await _isInTeamTree(local.chromeId, teamId)) {
                                    await _onBookmarkCreated(local.chromeId, nodes[0]);
                                }
                            }
                        } catch (_) { /* bookmark may have been removed */ }
                    }
                }
            } finally {
                await _clearEchoGuard();
            }

            // Update per-team last sync timestamp
            const ts = new Date().toISOString();
            _lastSyncTimestamps.set(teamId, ts);
            try {
                const existing = await chrome.storage.local.get(STORAGE_KEY_LAST_SYNC_TIMESTAMPS);
                const tsMap = existing[STORAGE_KEY_LAST_SYNC_TIMESTAMPS] || {};
                tsMap[teamId] = ts;
                await chrome.storage.local.set({ [STORAGE_KEY_LAST_SYNC_TIMESTAMPS]: tsMap });
            } catch (_) { /* best effort */ }

            _updateStatus(teamId, { lastSync: ts, error: null });
            console.info('[TeamMarks Sync] Full sync completed for team', teamId, 'at', ts);

        } catch (err) {
            console.error('[TeamMarks Sync] Full sync failed for team', teamId, ':', err);
            _updateStatus(teamId, { error: err.message });
        }
    }

    // ---------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------

    /**
     * Initialize the sync engine.
     * Restores per-team sync timestamps from storage.
     * Does NOT start syncing — call startSync(teamId) to begin.
     *
     * @returns {Promise<void>}
     */
    async function init() {
        if (_initialized) {
            console.warn('[TeamMarks Sync] Already initialized.');
            return;
        }

        console.info('[TeamMarks Sync] Initializing…');

        // Restore per-team sync timestamps
        try {
            const result = await chrome.storage.local.get(STORAGE_KEY_LAST_SYNC_TIMESTAMPS);
            const tsMap = result[STORAGE_KEY_LAST_SYNC_TIMESTAMPS] || {};
            for (const [teamId, ts] of Object.entries(tsMap)) {
                _lastSyncTimestamps.set(teamId, ts);
            }
        } catch (err) {
            console.warn('[TeamMarks Sync] Could not restore sync timestamps:', err);
        }

        await _loadIdMap();
        _registerChromeListeners();

        _initialized = true;
        console.info('[TeamMarks Sync] Initialized. Teams with prior sync:', _lastSyncTimestamps.size);
    }

    /**
     * Start syncing for a specific team. Idempotent — safe to call multiple times.
     * Subscribes to Supabase Realtime, resolves the sync folder, and runs fullSync.
     *
     * @param {string} teamId - UUID of the team to sync
     * @returns {Promise<void>}
     */
    async function startSync(teamId) {
        if (!teamId) {
            throw new Error('[TeamMarks Sync] teamId is required.');
        }

        // Idempotent: if already subscribed for this team, no-op
        if (_realtimeChannels.has(teamId)) {
            console.debug('[TeamMarks Sync] startSync is idempotent — already syncing team:', teamId);
            return;
        }

        // Resolve the sync folder for this team
        const folderInfo = await TeamManagement.getTeamBookmarksFolder(teamId);
        if (folderInfo && folderInfo.chromeFolderId) {
            _teamRootFolderIds.set(teamId, folderInfo.chromeFolderId);
        } else {
            console.warn('[TeamMarks Sync] No bookmark folder mapped for team', teamId, '— sync will be limited.');
            _teamRootFolderIds.set(teamId, null);
        }

        // Load ID map to keep it current
        await _loadIdMap();

        _activeTeamIds.add(teamId);

        // Subscribe to Supabase Realtime for this team
        await _subscribeToRealtime(teamId);

        console.info('[TeamMarks Sync] Sync started for team:', teamId, 'folder:', _teamRootFolderIds.get(teamId) || '(none)');

        // Run an initial full sync via the team's serial queue
        _enqueueSyncOp(teamId, () => fullSync(teamId)).catch(err => {
            console.error('[TeamMarks Sync] Initial full sync failed for team:', teamId, err);
        });
    }

    /**
     * Stop syncing for a specific team.
     * Unsubscribes from Realtime and removes that team from all Maps.
     *
     * @param {string} teamId - UUID of the team to stop
     * @returns {Promise<void>}
     */
    async function stopSync(teamId) {
        if (!teamId) {
            console.warn('[TeamMarks Sync] stopSync called without teamId — use stopAllSync() to stop all teams.');
            return;
        }

        console.info('[TeamMarks Sync] Stopping sync for team:', teamId);

        await _unsubscribeFromRealtime(teamId);

        _activeTeamIds.delete(teamId);
        _teamRootFolderIds.delete(teamId);
        _isConnected.delete(teamId);
        _lastErrors.delete(teamId);
        _syncQueues.delete(teamId);

        _notifyStatusListeners(getStatus());
        console.info('[TeamMarks Sync] Sync stopped for team:', teamId);
    }

    /**
     * Stop syncing for ALL teams. Used on sign-out.
     *
     * @returns {Promise<void>}
     */
    async function stopAllSync() {
        console.info('[TeamMarks Sync] Stopping all team syncs…');

        const teamIds = [..._activeTeamIds];
        for (const teamId of teamIds) {
            await stopSync(teamId);
        }

        console.info('[TeamMarks Sync] All syncs stopped.');
    }

    /**
     * Get the current sync status for all active teams.
     * Also exposes legacy `.connected` and `.lastSync` from the first team
     * for backward compatibility with existing consumers.
     *
     * @returns {{ teams: Array, connected: boolean, lastSync: string|null, error: string|null }}
     */
    function getStatus() {
        const teams = [];
        for (const teamId of _activeTeamIds) {
            teams.push({
                teamId,
                connected: _isConnected.get(teamId) || false,
                lastSync: _lastSyncTimestamps.get(teamId) || null,
                error: _lastErrors.get(teamId) || null
            });
        }

        // Legacy compat: expose first team's values at the top level
        const first = teams[0] || {};
        return {
            teams,
            connected: first.connected || false,
            lastSync: first.lastSync || null,
            error: first.error || null,
            // Legacy field — first active team ID (may be null)
            teamId: first.teamId || null
        };
    }

    /**
     * Register a callback to be invoked when the sync status changes.
     * The callback receives the status object from getStatus().
     *
     * @param {Function} callback - Called with (status) on status change
     */
    function onStatusChange(callback) {
        if (typeof callback === 'function') {
            _statusListeners.push(callback);
        }
    }

    /**
     * Fully clean up the sync engine.
     * Stops all syncs, removes Chrome listeners, clears all state.
     *
     * @returns {Promise<void>}
     */
    async function destroy() {
        console.info('[TeamMarks Sync] Destroying sync engine…');

        await stopAllSync();
        _unregisterChromeListeners();
        _statusListeners.length = 0;
        _idMap = { chromeToSupabase: {}, supabaseToChrome: {} };
        _lastSyncTimestamps.clear();
        _lastErrors.clear();
        _syncQueues.clear();
        _initialized = false;

        console.info('[TeamMarks Sync] Destroyed.');
    }

    // Return the public API
    return Object.freeze({
        init,
        startSync,
        stopSync,
        stopAllSync,
        fullSync,
        getStatus,
        onStatusChange,
        destroy,
        // Exposed for SW handlers
        getChromeId: _getChromeId,
        addIdMapping: _addIdMapping,
        removeIdMappingByChromeId: _removeIdMappingByChromeId
    });
})();
