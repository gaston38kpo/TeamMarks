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
 *   SyncEngine.startSync(teamId)              → Subscribe to Realtime, begin sync
 *   SyncEngine.stopSync()                     → Unsubscribe, remove listeners
 *   SyncEngine.fullSync()                     → Full catch-up sync (alias: syncNow)
 *   SyncEngine.getStatus()                    → Return { connected, lastSync, error }
 *   SyncEngine.onStatusChange(callback)       → Register status listener
 *   SyncEngine.destroy()                      → Full cleanup
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

    /** Storage key for last sync timestamp */
    const STORAGE_KEY_LAST_SYNC = 'teammarks_lastSyncTimestamp';

    /** Storage key for echo-guard flag in chrome.storage.session */
    const SESSION_KEY_SYNCING = 'teammarks_syncing';

    /** Supabase Realtime channel name prefix */
    const CHANNEL_PREFIX = 'teammarks:';

    // ---------------------------------------------------------------
    // State
    // ---------------------------------------------------------------

    /** @type {string|null} UUID of the currently syncing team */
    let _currentTeamId = null;

    /** @type {string|null} Chrome bookmark folder ID for the sync root */
    let _currentFolderId = null;

    /** @type {object|null} Supabase Realtime channel subscription */
    let _realtimeChannel = null;

    /** @type {boolean} Whether Realtime is connected and subscribed */
    let _isConnected = false;

    /** @type {string|null} ISO timestamp of the last successful sync */
    let _lastSyncTimestamp = null;

    /** @type {string|null} Last error message, null if healthy */
    let _lastError = null;

    /**
     * @type {number} In-memory echo guard counter.
     * Incremented before programmatic Chrome bookmark writes,
     * decremented after. Event handlers skip when counter > 0.
     */
    let _syncWriteDepth = 0;

    /** @type {Function[]} Status change listeners */
    const _statusListeners = [];

    /** @type {Function[]} Chrome bookmark listener removal functions */
    let _chromeListenerRemovers = [];

    /** @type {boolean} Whether init() has been called */
    let _initialized = false;

    /** @type {boolean} Whether currently syncing (startSync called and not stopSync'd) */
    let _isSyncing = false;

    /**
     * @type {{ chromeToSupabase: object, supabaseToChrome: object }}
     * ID mapping between Chrome bookmark IDs and Supabase bookmark UUIDs.
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
     * Update internal status and notify listeners.
     * @param {object} overrides - Status fields to update
     */
    function _updateStatus(overrides = {}) {
        if (overrides.connected !== undefined) _isConnected = overrides.connected;
        if (overrides.lastSync !== undefined) _lastSyncTimestamp = overrides.lastSync;
        if (overrides.error !== undefined) _lastError = overrides.error;

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
    // Private helpers — Echo guard
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
     * Check whether a Chrome bookmark is inside the current sync folder
     * (directly or recursively).
     * @param {string} chromeId - The bookmark ID to check
     * @returns {Promise<boolean>}
     */
    async function _isInSyncFolder(chromeId) {
        if (!_currentFolderId) return false;

        let currentId = chromeId;
        const maxDepth = 20; // Safety guard against infinite loops

        for (let i = 0; i < maxDepth; i++) {
            if (currentId === _currentFolderId) return true;

            // Root folders can't have parents
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
     * Flatten a Chrome bookmark tree node into a flat array.
     * Each item gets a parentPath computed relative to the sync folder root.
     * @param {object} node - A Chrome bookmark tree node
     * @param {string} parentPath - Path of the parent (empty for root)
     * @returns {object[]} Flat array of bookmark items with parentPath
     */
    function _flattenBookmarkTree(node, parentPath = '') {
        const results = [];
        const isFolder = !node.url; // Chrome folders have no url property

        if (node.id !== _currentFolderId) {
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
            const childPath = node.id === _currentFolderId
                ? '/'
                : (parentPath === '/' ? `/${node.title}` : `${parentPath}/${node.title}`);

            for (const child of node.children) {
                results.push(..._flattenBookmarkTree(child, childPath));
            }
        }

        return results;
    }

    /**
     * Build a Supabase bookmark object from a Chrome bookmark.
     * Includes parent_id resolution via the ID map.
     * @param {object} chromeBookmark - A Chrome bookmark node
     * @param {object} [chromeParent] - The parent Chrome node (for parent resolution)
     * @returns {object} Supabase-compatible bookmark object
     */
    function _chromeBookmarkToSupabase(chromeBookmark, chromeParent) {
        const isFolder = !chromeBookmark.url;

        // Resolve parent_id
        let parentId = null;
        if (chromeBookmark.parentId && chromeBookmark.parentId !== _currentFolderId) {
            parentId = _getSupabaseId(chromeBookmark.parentId) || null;
        }

        return {
            team_id: _currentTeamId,
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
     * @returns {string} Chrome parentId (the sync folder ID or a mapped folder ID)
     */
    function _resolveChromeParentId(supabaseParentId) {
        if (!supabaseParentId) {
            return _currentFolderId;
        }
        return _getChromeId(supabaseParentId) || _currentFolderId;
    }

    // ---------------------------------------------------------------
    // Chrome bookmark event handlers (Local → Remote)
    // ---------------------------------------------------------------

    /**
     * Handle chrome.bookmarks.onCreated.
     * Pushes the new bookmark to Supabase if it's in the sync folder.
     * @param {string} id - Chrome bookmark ID
     * @param {object} bookmark - Chrome bookmark tree node
     */
    async function _onBookmarkCreated(id, bookmark) {
        if (_isSyncing === false && !_currentTeamId) return;

        const guarded = await _isEchoGuarded();
        if (guarded) {
            console.debug('[TeamMarks Sync] Skipping onCreated (echo guard):', id);
            return;
        }

        const inFolder = await _isInSyncFolder(id);
        if (!inFolder) return;

        console.info('[TeamMarks Sync] Local bookmark created:', bookmark.title || id);

        try {
            const supabase = _getSupabase();

            // Check if we already have a mapping (e.g., from a previous partial sync)
            const existingSupabaseId = _getSupabaseId(id);
            if (existingSupabaseId) {
                // Already mapped — this might be a duplicate event or a move.
                // Update instead of insert.
                const updateData = _chromeBookmarkToSupabase(bookmark);
                const { error } = await supabase
                    .from('bookmarks')
                    .update({ ...updateData, updated_at: new Date().toISOString() })
                    .eq('id', existingSupabaseId);

                if (error) {
                    console.error('[TeamMarks Sync] Failed to update bookmark on create:', error);
                    _updateStatus({ error: error.message });
                }
                return;
            }

            const insertData = _chromeBookmarkToSupabase(bookmark);
            const { data, error } = await supabase
                .from('bookmarks')
                .insert(insertData)
                .select()
                .single();

            if (error) {
                console.error('[TeamMarks Sync] Failed to push new bookmark:', error);
                _updateStatus({ error: error.message });
                return;
            }

            // Store the ID mapping
            if (data && data.id) {
                await _addIdMapping(id, data.id);
            }

            console.info('[TeamMarks Sync] Pushed bookmark to Supabase:', data?.id);
        } catch (err) {
            console.error('[TeamMarks Sync] Error in onBookmarkCreated:', err);
            _updateStatus({ error: err.message });
        }
    }

    /**
     * Handle chrome.bookmarks.onChanged.
     * Pushes the change to Supabase if the bookmark is in the sync folder.
     * @param {string} id - Chrome bookmark ID
     * @param {object} changeInfo - Object with changed properties (title, url)
     */
    async function _onBookmarkChanged(id, changeInfo) {
        if (_isSyncing === false && !_currentTeamId) return;

        const guarded = await _isEchoGuarded();
        if (guarded) {
            console.debug('[TeamMarks Sync] Skipping onChanged (echo guard):', id);
            return;
        }

        const inFolder = await _isInSyncFolder(id);
        if (!inFolder) return;

        const supabaseId = _getSupabaseId(id);
        if (!supabaseId) {
            // Not mapped yet — this might be a bookmark we haven't synced.
            // Treat it like a create.
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

            // Remove undefined fields so Supabase doesn't null them
            Object.keys(updateData).forEach(key =>
                updateData[key] === undefined && delete updateData[key]
            );

            const { error } = await supabase
                .from('bookmarks')
                .update(updateData)
                .eq('id', supabaseId);

            if (error) {
                console.error('[TeamMarks Sync] Failed to push bookmark change:', error);
                _updateStatus({ error: error.message });
            }
        } catch (err) {
            console.error('[TeamMarks Sync] Error in onBookmarkChanged:', err);
            _updateStatus({ error: err.message });
        }
    }

    /**
     * Handle chrome.bookmarks.onMoved.
     * Pushes the move (parent change) to Supabase.
     * @param {string} id - Chrome bookmark ID
     * @param {object} moveInfo - { parentId, index, oldParentId, oldIndex }
     */
    async function _onBookmarkMoved(id, moveInfo) {
        if (_isSyncing === false && !_currentTeamId) return;

        const guarded = await _isEchoGuarded();
        if (guarded) {
            console.debug('[TeamMarks Sync] Skipping onMoved (echo guard):', id);
            return;
        }

        // Check if the bookmark was moved INTO or OUT OF the sync folder
        const wasInFolder = await _isInSyncFolder(moveInfo.oldParentId);
        const isInFolder = await _isInSyncFolder(id);

        if (!wasInFolder && !isInFolder) return; // Not our concern

        console.info('[TeamMarks Sync] Local bookmark moved:', id);

        try {
            const supabaseId = _getSupabaseId(id);

            if (!supabaseId) {
                // Moved into our folder from outside — treat as create
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
            const updateData = {
                parent_id: bookmark.parentId === _currentFolderId
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
                _updateStatus({ error: error.message });
            }
        } catch (err) {
            console.error('[TeamMarks Sync] Error in onBookmarkMoved:', err);
            _updateStatus({ error: err.message });
        }
    }

    /**
     * Handle chrome.bookmarks.onRemoved.
     * Soft-deletes the bookmark on Supabase.
     * @param {string} id - Chrome bookmark ID
     * @param {object} removeInfo - { parentId, index, node }
     */
    async function _onBookmarkRemoved(id, removeInfo) {
        if (_isSyncing === false && !_currentTeamId) return;

        const guarded = await _isEchoGuarded();
        if (guarded) {
            console.debug('[TeamMarks Sync] Skipping onRemoved (echo guard):', id);
            return;
        }

        const supabaseId = _getSupabaseId(id);
        if (!supabaseId) {
            // Not a synced bookmark — nothing to do
            return;
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
                _updateStatus({ error: error.message });
            }

            await _removeIdMappingByChromeId(id);
        } catch (err) {
            console.error('[TeamMarks Sync] Error in onBookmarkRemoved:', err);
            _updateStatus({ error: err.message });
        }
    }

    /**
     * Handle chrome.bookmarks.onChildrenReordered.
     * Updates sort_order for all children on Supabase.
     * @param {string} id - Chrome bookmark folder ID
     * @param {object} reorderInfo - { childIds }
     */
    async function _onBookmarkChildrenReordered(id, reorderInfo) {
        if (_isSyncing === false && !_currentTeamId) return;

        const guarded = await _isEchoGuarded();
        if (guarded) {
            console.debug('[TeamMarks Sync] Skipping onChildrenReordered (echo guard):', id);
            return;
        }

        const inFolder = await _isInSyncFolder(id);
        if (!inFolder) return;

        console.info('[TeamMarks Sync] Local bookmark children reordered:', id);

        try {
            const supabase = _getSupabase();

            // Update sort_order for each child
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
            _updateStatus({ error: err.message });
        }
    }

    /**
     * Register Chrome bookmark event listeners.
     * Stores removal functions for cleanup.
     */
    function _registerChromeListeners() {
        // Remove any existing listeners first
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

        // Store references for removal
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
     * Handle a Supabase Realtime postgres_changes event.
     * @param {object} payload - Supabase Realtime payload
     */
    async function _handleRealtimeEvent(payload) {
        const { eventType, new: newRecord, old: oldRecord } = payload;

        if (!_currentTeamId || !_currentFolderId) {
            console.debug('[TeamMarks Sync] Ignoring Realtime event — no active sync.');
            return;
        }

        // Verify the event is for our team
        const recordTeamId = (newRecord && newRecord.team_id) || (oldRecord && oldRecord.team_id);
        if (recordTeamId && recordTeamId !== _currentTeamId) {
            return; // Not for our team
        }

        // Skip our own writes if possible (compare last_modified_by)
        const userId = _getUserId();
        if (newRecord && newRecord.last_modified_by === userId) {
            // This might be our own write echoed back. Check if we already have it.
            const chromeId = _getChromeId(newRecord.id);
            if (chromeId) {
                // Already mapped — likely our own write. Skip.
                console.debug('[TeamMarks Sync] Skipping Realtime event (own write):', newRecord.id);
                return;
            }
        }

        console.info('[TeamMarks Sync] Realtime event:', eventType, newRecord?.id || oldRecord?.id);

        try {
            switch (eventType) {
                case 'INSERT':
                    await _applyRemoteInsert(newRecord);
                    break;
                case 'UPDATE':
                    await _applyRemoteUpdate(newRecord, oldRecord);
                    break;
                case 'DELETE':
                    await _applyRemoteDelete(oldRecord);
                    break;
                default:
                    console.warn('[TeamMarks Sync] Unknown Realtime event type:', eventType);
            }
        } catch (err) {
            console.error('[TeamMarks Sync] Error handling Realtime event:', err);
            _updateStatus({ error: err.message });
        }
    }

    /**
     * Apply a remote INSERT by creating a Chrome bookmark.
     * @param {object} record - The new Supabase bookmark record
     */
    async function _applyRemoteInsert(record) {
        if (!record) return;

        // Skip soft-deleted records
        if (record.deleted_at) return;

        // Check if we already have this bookmark mapped
        const existingChromeId = _getChromeId(record.id);
        if (existingChromeId) {
            // Already exists locally — verify it's still there
            try {
                const nodes = await chrome.bookmarks.get(existingChromeId);
                if (nodes && nodes.length > 0) {
                    console.debug('[TeamMarks Sync] Local bookmark already exists for:', record.id);
                    return;
                }
            } catch (_) {
                // Chrome bookmark was removed — we need to recreate it
                await _removeIdMappingBySupabaseId(record.id);
            }
        }

        // Resolve the parent folder in Chrome
        const chromeParentId = _resolveChromeParentId(record.parent_id);

        // Set echo guard BEFORE creating the Chrome bookmark
        await _setEchoGuard();
        try {
            const createParams = {
                parentId: chromeParentId,
                title: record.title || '',
                index: record.sort_order || 0
            };

            // Only include url for non-folder bookmarks
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
     * @param {object} oldRecord - The previous Supabase record (for ID mapping)
     */
    async function _applyRemoteUpdate(newRecord, oldRecord) {
        if (!newRecord) return;

        // Handle soft delete — if updated to have deleted_at, remove locally
        if (newRecord.deleted_at) {
            await _applyRemoteDelete(oldRecord || newRecord);
            return;
        }

        // Find the Chrome bookmark
        const recordId = newRecord.id;
        let chromeId = _getChromeId(recordId);

        if (!chromeId) {
            // Not mapped yet — might be a new bookmark we haven't synced
            // Try to apply as an insert instead
            console.debug('[TeamMarks Sync] Update for unmapped bookmark, applying as insert:', recordId);
            await _applyRemoteInsert(newRecord);
            return;
        }

        // Verify the Chrome bookmark still exists
        try {
            const nodes = await chrome.bookmarks.get(chromeId);
            if (!nodes || nodes.length === 0) {
                // Chrome bookmark gone — recreate as insert
                await _removeIdMappingBySupabaseId(recordId);
                await _applyRemoteInsert(newRecord);
                return;
            }
        } catch (_) {
            // Chrome bookmark gone — recreate
            await _removeIdMappingBySupabaseId(recordId);
            await _applyRemoteInsert(newRecord);
            return;
        }

        // Set echo guard BEFORE updating
        await _setEchoGuard();
        try {
            // Update title and URL
            const updateParams = { title: newRecord.title || '' };
            if (!newRecord.is_folder && newRecord.url) {
                updateParams.url = newRecord.url;
            }
            await chrome.bookmarks.update(chromeId, updateParams);

            // Move if parent changed
            const newChromeParentId = _resolveChromeParentId(newRecord.parent_id);
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
     * Apply a remote DELETE by removing (or soft-deleting) a Chrome bookmark.
     * @param {object} record - The deleted Supabase record (old values)
     */
    async function _applyRemoteDelete(record) {
        if (!record) return;

        // Find the Chrome bookmark
        const recordId = record.id;
        const chromeId = _getChromeId(recordId);

        if (!chromeId) {
            // Not mapped — nothing to delete locally
            return;
        }

        // Set echo guard BEFORE removing
        await _setEchoGuard();
        try {
            try {
                await chrome.bookmarks.removeTree(chromeId);
                console.info('[TeamMarks Sync] Removed local bookmark tree from remote delete:', chromeId);
            } catch (_) {
                // removeTree might fail if it's not a folder; try remove
                try {
                    await chrome.bookmarks.remove(chromeId);
                    console.info('[TeamMarks Sync] Removed local bookmark from remote delete:', chromeId);
                } catch (__) {
                    // Already gone — that's fine
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
     * Subscribe to Supabase Realtime postgres_changes for the current team.
     * @returns {Promise<void>}
     */
    async function _subscribeToRealtime() {
        if (!_currentTeamId) {
            console.warn('[TeamMarks Sync] Cannot subscribe — no team selected.');
            return;
        }

        // Unsubscribe from existing channel if any
        await _unsubscribeFromRealtime();

        const supabase = _getSupabase();
        if (!supabase) return;

        const channelName = `${CHANNEL_PREFIX}${_currentTeamId}`;

        console.info('[TeamMarks Sync] Subscribing to Realtime channel:', channelName);

        _realtimeChannel = supabase
            .channel(channelName)
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'bookmarks',
                filter: `team_id=eq.${_currentTeamId}`
            }, _handleRealtimeEvent)
            .subscribe((status, err) => {
                if (status === 'SUBSCRIBED') {
                    console.info('[TeamMarks Sync] Realtime subscribed to:', channelName);
                    _isConnected = true;
                    _updateStatus({ connected: true, error: null });
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    console.error('[TeamMarks Sync] Realtime error:', status, err);
                    _isConnected = false;
                    _updateStatus({ connected: false, error: `Realtime ${status}` });
                } else if (status === 'CLOSED') {
                    console.info('[TeamMarks Sync] Realtime channel closed.');
                    _isConnected = false;
                    _updateStatus({ connected: false });
                }
            });
    }

    /**
     * Unsubscribe from the Supabase Realtime channel.
     * @returns {Promise<void>}
     */
    async function _unsubscribeFromRealtime() {
        if (_realtimeChannel) {
            try {
                const supabase = _getSupabase();
                if (supabase) {
                    await supabase.removeChannel(_realtimeChannel);
                }
            } catch (err) {
                console.warn('[TeamMarks Sync] Error removing Realtime channel:', err);
            }
            _realtimeChannel = null;
        }
        _isConnected = false;
    }

    // ---------------------------------------------------------------
    // Full sync (catch-up)
    // ---------------------------------------------------------------

    /**
     * Build a map of supabaseId → full folder path for all remote folders.
     * Used by fullSync to resolve parent_path before calling applyDiff.
     *
     * Performs two passes to handle folders arriving out of order
     * (child before parent). Orphaned folders (parent not in set) are
     * placed at root (path = '/foldertitle') — this never throws.
     *
     * @param {object[]} remoteFolders - Remote bookmark records where is_folder=true
     * @returns {Map<string, string>} supabaseId → path string (e.g. '/Work/Projects')
     */
    function _buildRemotePathMap(remoteFolders) {
        const pathMap = new Map();

        // First pass — process folders whose parent is already in the map (or root)
        const remaining = [];
        for (const folder of remoteFolders) {
            if (!folder.parent_id) {
                // Root-level folder
                pathMap.set(folder.id, `/${folder.title}`);
            } else if (pathMap.has(folder.parent_id)) {
                const parentPath = pathMap.get(folder.parent_id);
                pathMap.set(folder.id, `${parentPath}/${folder.title}`);
            } else {
                remaining.push(folder);
            }
        }

        // Second pass — handle folders whose parent was not yet processed
        for (const folder of remaining) {
            const parentPath = pathMap.get(folder.parent_id);
            if (parentPath !== undefined) {
                pathMap.set(folder.id, `${parentPath}/${folder.title}`);
            } else {
                // Parent not in remote set — place at root as fallback
                console.debug('[TeamMarks Sync] _buildRemotePathMap: orphaned folder, placing at root:', folder.id);
                pathMap.set(folder.id, `/${folder.title}`);
            }
        }

        return pathMap;
    }

    /**
     * Perform a full catch-up sync:
     * 1. Pull all bookmarks for the current team from Supabase
     * 2. Get all Chrome bookmarks in the sync folder
     * 3. Compare using ConflictResolver.applyDiff
     * 4. Apply the resulting actions
     *
     * @returns {Promise<void>}
     */
    async function fullSync() {
        if (!_currentTeamId || !_currentFolderId) {
            console.warn('[TeamMarks Sync] Cannot fullSync — no team or folder selected.');
            return;
        }

        console.info('[TeamMarks Sync] Starting full sync for team:', _currentTeamId);
        _updateStatus({ error: null });

        try {
            const supabase = _getSupabase();

            // 1. Pull all active (non-deleted) bookmarks for the team from Supabase
            const { data: remoteBookmarks, error: fetchError } = await supabase
                .from('bookmarks')
                .select('*')
                .eq('team_id', _currentTeamId)
                .is('deleted_at', null)
                .order('sort_order', { ascending: true });

            if (fetchError) {
                throw new Error(`Failed to fetch remote bookmarks: ${fetchError.message}`);
            }

            // 2. Get all Chrome bookmarks in the sync folder
            let localBookmarks = [];
            try {
                const subtree = await chrome.bookmarks.getSubTree(_currentFolderId);
                if (subtree && subtree.length > 0) {
                    localBookmarks = _flattenBookmarkTree(subtree[0]);
                }
            } catch (err) {
                console.error('[TeamMarks Sync] Failed to get local bookmarks:', err);
                throw new Error(`Failed to read local bookmarks: ${err.message}`);
            }

            // 3. Prepare data for ConflictResolver
            // Build supabaseId → fullPath map from remote folder tree
            const remoteFolderRecords = (remoteBookmarks || []).filter(bm => bm.is_folder);
            const pathMap = _buildRemotePathMap(remoteFolderRecords);

            // Map remote bookmarks to a format applyDiff expects,
            // resolving parent_path from the folder path map
            const remoteChanges = (remoteBookmarks || []).map(bm => ({
                id: bm.id,
                url: bm.url,
                title: bm.title,
                is_folder: bm.is_folder,
                parent_id: bm.parent_id,
                sort_order: bm.sort_order,
                updated_at: bm.updated_at,
                deleted_at: bm.deleted_at,
                parent_path: bm.parent_id ? (pathMap.get(bm.parent_id) || '/') : ''
            }));

            // Map local bookmarks with their parent paths
            const localItems = localBookmarks.map(bm => ({
                chromeId: bm.chromeId,
                parentId: bm.parentId,
                url: bm.url,
                title: bm.title,
                is_folder: bm.isFolder,
                parent_path: bm.parentPath,
                updated_at: null, // Chrome bookmarks don't have timestamps
                identity_key: ConflictResolver.identityKey(bm)
            }));

            // 4. Process remote bookmarks that need to be created or updated locally
            //    and local bookmarks that need to be pushed to Supabase

            // Sort remote: folders first (so parent folders exist before their children)
            const remoteFoldersForSort = remoteChanges.filter(bm => bm.is_folder);
            const remoteUrlsForSort = remoteChanges.filter(bm => !bm.is_folder);
            const sortedRemote = [...remoteFoldersForSort, ...remoteUrlsForSort];

            // Resolve conflicts: applyDiff compares local vs remote using LWW
            const actions = ConflictResolver.applyDiff(localItems, sortedRemote);

            await _setEchoGuard();
            try {
                // Dispatch each action returned by the conflict resolver
                for (const action of actions) {
                    switch (action.type) {
                        case 'create':
                            await _applyRemoteInsert(action.remote);
                            break;

                        case 'update':
                            await _applyRemoteUpdate(action.remote, action.local);
                            break;

                        case 'keep-local':
                            // Local wins (LWW) — no action needed
                            break;

                        case 'delete':
                            await _applyRemoteDelete(action.remote);
                            break;

                        case 'undelete':
                            // Local was edited after remote deletion — re-upload to Supabase
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
                            // 'skip-deleted-no-local' and other skip-* variants — noop
                            break;
                    }
                }

                // Push local bookmarks that don't exist remotely
                for (const local of localItems) {
                    const supabaseId = _getSupabaseId(local.chromeId);
                    if (!supabaseId) {
                        // Not on Supabase yet — push it
                        try {
                            const nodes = await chrome.bookmarks.get(local.chromeId);
                            if (nodes && nodes.length > 0) {
                                // Only push if it's still in the sync folder
                                if (await _isInSyncFolder(local.chromeId)) {
                                    await _onBookmarkCreated(local.chromeId, nodes[0]);
                                }
                            }
                        } catch (_) { /* bookmark may have been removed */ }
                    }
                }
            } finally {
                await _clearEchoGuard();
            }

            // Update last sync timestamp
            _lastSyncTimestamp = new Date().toISOString();
            try {
                await chrome.storage.local.set({
                    [STORAGE_KEY_LAST_SYNC]: _lastSyncTimestamp
                });
            } catch (_) { /* best effort */ }

            _updateStatus({ lastSync: _lastSyncTimestamp, error: null });
            console.info('[TeamMarks Sync] Full sync completed at', _lastSyncTimestamp);

        } catch (err) {
            console.error('[TeamMarks Sync] Full sync failed:', err);
            _updateStatus({ error: err.message });
        }
    }

    // ---------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------

    /**
     * Initialize the sync engine.
     * Restores the last sync timestamp from storage.
     * Does NOT start syncing — call startSync() to begin.
     *
     * @returns {Promise<void>}
     */
    async function init() {
        if (_initialized) {
            console.warn('[TeamMarks Sync] Already initialized.');
            return;
        }

        console.info('[TeamMarks Sync] Initializing…');

        // Restore last sync timestamp
        try {
            const result = await chrome.storage.local.get(STORAGE_KEY_LAST_SYNC);
            _lastSyncTimestamp = result[STORAGE_KEY_LAST_SYNC] || null;
        } catch (err) {
            console.warn('[TeamMarks Sync] Could not restore last sync timestamp:', err);
        }

        // Load ID map
        await _loadIdMap();

        // Register Chrome bookmark listeners (always active, but guarded)
        _registerChromeListeners();

        _initialized = true;
        console.info('[TeamMarks Sync] Initialized. Last sync:', _lastSyncTimestamp || 'never');
    }

    /**
     * Start syncing for a specific team.
     * Subscribes to Supabase Realtime and sets the sync folder.
     *
     * @param {string} teamId - UUID of the team to sync
     * @param {string} [folderId] - Chrome bookmark folder ID for the sync root.
     *   If omitted, looks up the folder from TeamManagement.
     * @returns {Promise<void>}
     */
    async function startSync(teamId, folderId) {
        if (!teamId) {
            throw new Error('[TeamMarks Sync] teamId is required.');
        }

        // Stop existing sync if any
        if (_isSyncing) {
            await stopSync();
        }

        _currentTeamId = teamId;

        // Resolve the sync folder
        if (folderId) {
            _currentFolderId = folderId;
        } else {
            const folderInfo = await TeamManagement.getTeamBookmarksFolder(teamId);
            if (folderInfo && folderInfo.chromeFolderId) {
                _currentFolderId = folderInfo.chromeFolderId;
            } else {
                // No folder mapped yet — sync will be limited until folder is set
                console.warn('[TeamMarks Sync] No bookmark folder mapped for team. Sync will be limited.');
                _currentFolderId = null;
            }
        }

        // Reload ID map for this team
        await _loadIdMap();

        // Subscribe to Supabase Realtime
        await _subscribeToRealtime();

        _isSyncing = true;
        _isConnected = true;

        console.info('[TeamMarks Sync] Sync started for team:', teamId, 'folder:', _currentFolderId || '(none)');

        // Run a full sync to catch up on any missed changes
        try {
            await fullSync();
        } catch (err) {
            console.error('[TeamMarks Sync] Initial full sync failed:', err);
            // Don't throw — sync is still operational, just might be behind
        }
    }

    /**
     * Stop syncing. Unsubscribes from Realtime and clears sync state.
     *
     * @returns {Promise<void>}
     */
    async function stopSync() {
        console.info('[TeamMarks Sync] Stopping sync…');

        await _unsubscribeFromRealtime();

        _currentTeamId = null;
        _currentFolderId = null;
        _isSyncing = false;
        _isConnected = false;

        _updateStatus({ connected: false });
        console.info('[TeamMarks Sync] Sync stopped.');
    }

    /**
     * Alias for fullSync(). Provided for backward compatibility
     * with the design contract interface.
     *
     * @returns {Promise<void>}
     */
    async function syncNow() {
        return fullSync();
    }

    /**
     * Get the current sync status.
     *
     * @returns {{ connected: boolean, lastSync: string|null, error: string|null, teamId: string|null }}
     */
    function getStatus() {
        return {
            connected: _isConnected,
            lastSync: _lastSyncTimestamp,
            error: _lastError,
            teamId: _currentTeamId
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
     * Stops syncing, removes all listeners, clears state.
     *
     * @returns {Promise<void>}
     */
    async function destroy() {
        console.info('[TeamMarks Sync] Destroying sync engine…');

        await stopSync();
        _unregisterChromeListeners();
        _statusListeners.length = 0;
        _idMap = { chromeToSupabase: {}, supabaseToChrome: {} };
        _lastSyncTimestamp = null;
        _lastError = null;
        _initialized = false;

        console.info('[TeamMarks Sync] Destroyed.');
    }

    // Return the public API
    return Object.freeze({
        init,
        startSync,
        stopSync,
        fullSync,
        syncNow,
        getStatus,
        onStatusChange,
        destroy
    });
})();