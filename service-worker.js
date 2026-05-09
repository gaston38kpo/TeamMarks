/**
 * TeamMarks — Service Worker (Manifest V3)
 *
 * Entry point for the extension's background logic.
 * Orchestrates all modules: auth, team management, conflict resolution,
 * and sync engine. Handles lifecycle events, alarms for keepalive,
 * and message passing from popup/settings pages.
 *
 * Module load order matters — config and lib first, then features.
 *
 * MESSAGE HANDLERS (chrome.runtime.onMessage):
 *   signIn         → Auth.signIn()
 *   signOut        → Auth.signOut()
 *   getSession     → Auth.getSession()
 *   getTeams       → TeamManagement.getMyTeams()
 *   createTeam     → TeamManagement.createTeam(orgId, name)
 *   joinTeam       → TeamManagement.joinTeam(inviteCode)
 *   leaveTeam      → TeamManagement.leaveTeam(teamId)
 *   selectTeam     → SyncEngine.startSync(teamId)
 *   setSyncFolder  → TeamManagement.setTeamBookmarksFolder(teamId, folderId) + SyncEngine.startSync
 *   getBookmarkTree → chrome.bookmarks.getTree()
 *   syncStatus     → SyncEngine.getStatus()
 *   manualSync     → SyncEngine.fullSync()
 *   getTeamFolderTree → Query Supabase for team's folder list [{id, title, parent_id}]
 *   getSubscribedFolderIds → TeamManagement.getSubscribedFolders(teamId)
 *   subscribeFolder → Add supabaseFolderId to subscriptions, rebuild, fullSync
 *   unsubscribeFolder → Remove supabaseFolderId, remove Chrome subtree, clean idMap
 */

importScripts(
    'lib/config.js',
    'lib/supabase-browser.js',
    'lib/supabase.js',
    'auth.js',
    'team-management.js',
    'conflict-resolution.js',
    'sync-engine.js'
);

// ==============================================================
// Bootstrap
// ==============================================================

/**
 * Bootstrap the extension when the service worker starts.
 * Runs on install, browser restart, and after idle termination.
 *
 * Sequence:
 *   1. Restore auth session from storage (non-interactive)
 *   2. Initialize team management cache
 *   3. Initialize sync engine (listeners only, no Realtime yet)
 *   4. If authenticated and team selected → start sync
 *   5. Register periodic alarm for keepalive
 */
async function initTeamMarks() {
    console.info('[TeamMarks] Service worker starting…');

    // 1. Restore auth session from storage
    let session = null;
    try {
        session = await Auth.init();
        if (session) {
            console.info('[TeamMarks] Authenticated as', session.email);
        } else {
            console.info('[TeamMarks] No active session — user needs to sign in.');
        }
    } catch (err) {
        console.error('[TeamMarks] Auth init failed:', err);
    }

    // 2. Initialize team management cache from storage
    try {
        await TeamManagement.init();
        const teams = TeamManagement.getMyTeams();
        if (teams.length > 0) {
            console.info('[TeamMarks] Restored', teams.length, 'team(s).');
        } else {
            console.info('[TeamMarks] No teams found — user needs to create or join one.');
        }
    } catch (err) {
        console.error('[TeamMarks] Team management init failed:', err);
    }

    // 3. Initialize sync engine (registers Chrome bookmark listeners)
    try {
        await SyncEngine.init();
        console.info('[TeamMarks] Sync engine initialized.');
    } catch (err) {
        console.error('[TeamMarks] Sync engine init failed:', err);
    }

    // 4. If authenticated and have a current team, start sync
    if (session) {
        const currentTeam = TeamManagement.getCurrentTeam();
        if (currentTeam) {
            try {
                const folderInfo = await TeamManagement.getTeamBookmarksFolder(currentTeam.id);
                const folderId = folderInfo ? folderInfo.chromeFolderId : undefined;
                await SyncEngine.startSync(currentTeam.id, folderId);
                console.info('[TeamMarks] Auto-resumed sync for team:', currentTeam.name);
            } catch (err) {
                console.error('[TeamMarks] Auto-resume sync failed:', err);
            }
        }
    }

    // 5. Register the periodic catch-up alarm (Manifest V3 minimum: ~1 minute)
    try {
        chrome.alarms.create('teammarks-catchup', { periodInMinutes: 5 });
        console.info('[TeamMarks] Catch-up alarm registered (every 5 min).');
    } catch (err) {
        console.error('[TeamMarks] Alarm registration failed:', err);
    }

    console.info('[TeamMarks] Service worker ready.');
}

// ==============================================================
// Alarm handler — keepalive and health check
// ==============================================================

/**
 * Handle the catch-up alarm.
 * - Fires every 5 minutes (configurable via chrome.alarms).
 * - Ensures the Supabase Realtime connection is still alive.
 * - Reconnects if disconnected.
 * - Runs a full sync to catch up on any missed changes.
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== 'teammarks-catchup') return;

    console.info('[TeamMarks] Catch-up alarm fired.');

    const status = SyncEngine.getStatus();

    // If not syncing, nothing to do
    if (!status.teamId) {
        console.debug('[TeamMarks] Not syncing — skipping catch-up.');
        return;
    }

    // If disconnected, try to reconnect
    if (!status.connected) {
        console.info('[TeamMarks] Realtime disconnected — reconnecting…');
        try {
            const session = await Auth.ensureValidSession();
            if (session) {
                const folderInfo = await TeamManagement.getTeamBookmarksFolder(status.teamId);
                const folderId = folderInfo ? folderInfo.chromeFolderId : undefined;
                await SyncEngine.startSync(status.teamId, folderId);
                console.info('[TeamMarks] Reconnected successfully.');
            } else {
                console.warn('[TeamMarks] Cannot reconnect — no valid session.');
            }
        } catch (err) {
            console.error('[TeamMarks] Reconnect failed:', err);
        }
        return;
    }

    // Connected — run a catch-up sync
    try {
        await SyncEngine.fullSync();
        console.info('[TeamMarks] Catch-up sync completed.');
    } catch (err) {
        console.error('[TeamMarks] Catch-up sync failed:', err);
    }
});

// ==============================================================
// Auth state change handler
// ==============================================================

/**
 * Listen for auth state changes.
 * Triggered by Auth.init() restoring a session or by
 * sign-in / sign-out actions from popup/settings pages.
 */
Auth.onSessionChange(async (session) => {
    if (session) {
        console.info('[TeamMarks] Auth state: signed in as', session.email);

        // Refresh team list from server
        try {
            await TeamManagement.refreshTeams();
        } catch (err) {
            console.error('[TeamMarks] Failed to refresh teams on auth:', err);
        }

        // Auto-select last team and start sync
        const currentTeam = TeamManagement.getCurrentTeam();
        if (currentTeam) {
            try {
                const folderInfo = await TeamManagement.getTeamBookmarksFolder(currentTeam.id);
                const folderId = folderInfo ? folderInfo.chromeFolderId : undefined;
                await SyncEngine.startSync(currentTeam.id, folderId);
                console.info('[TeamMarks] Sync started for team:', currentTeam.name);
            } catch (err) {
                console.error('[TeamMarks] Failed to start sync after sign-in:', err);
            }
        }
    } else {
        console.info('[TeamMarks] Auth state: signed out.');
        // Stop sync and clean up
        try {
            await SyncEngine.stopSync();
        } catch (err) {
            console.error('[TeamMarks] Failed to stop sync after sign-out:', err);
        }
    }
});

// ==============================================================
// Message handler — communication from popup/settings
// ==============================================================

/**
 * Handle messages from the extension popup and settings pages.
 * All messages follow the convention: { action: string, ...data }
 *
 * Responses are sent via sendResponse({ success: boolean, data?: any, error?: string })
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Wrap in an async IIFE so we can use await
    (async () => {
        try {
            const result = await handleMessage(message, sender);
            sendResponse(result);
        } catch (err) {
            console.error('[TeamMarks] Message handler error:', err);
            sendResponse({ success: false, error: err.message || 'Unknown error' });
        }
    })();

    // Return true to indicate we'll call sendResponse asynchronously
    return true;
});

/**
 * Route messages to the appropriate handler.
 * @param {object} message - The message object: { action, ...data }
 * @param {object} sender - The sender info
 * @returns {Promise<object>} Response object: { success, data?, error? }
 */
async function handleMessage(message, sender) {
    const { action } = message;

    switch (action) {
        // ── Auth ──────────────────────────────────────────
        case 'signIn': {
            const session = await Auth.signIn({ interactive: message.interactive !== false });
            return { success: true, data: session };
        }

        case 'signOut': {
            await Auth.signOut();
            await SyncEngine.stopSync();
            return { success: true };
        }

        // ── Teams ─────────────────────────────────────────
        case 'getTeams': {
            const teams = TeamManagement.getMyTeams();
            return { success: true, data: teams };
        }

        case 'createTeam': {
            const team = await TeamManagement.createTeam(message.orgId, message.name);
            return { success: true, data: team };
        }

        case 'joinTeam': {
            const team = await TeamManagement.joinTeam(message.inviteCode);
            return { success: true, data: team };
        }

        case 'leaveTeam': {
            await TeamManagement.leaveTeam(message.teamId);
            return { success: true };
        }

        case 'selectTeam': {
            const { teamId } = message;
            if (!teamId) {
                return { success: false, error: 'teamId is required.' };
            }

            // Set current team
            await TeamManagement.setCurrentTeam(teamId);

            // Get the sync folder mapping
            const folderInfo = await TeamManagement.getTeamBookmarksFolder(teamId);
            const folderId = folderInfo ? folderInfo.chromeFolderId : undefined;

            // Start syncing
            await SyncEngine.startSync(teamId, folderId);

            return { success: true, data: { teamId, folderId } };
        }

        // ── Sync ──────────────────────────────────────────
        case 'syncStatus': {
            const status = SyncEngine.getStatus();
            return { success: true, data: status };
        }

        case 'manualSync': {
            await SyncEngine.fullSync();
            const status = SyncEngine.getStatus();
            return { success: true, data: status };
        }

        // ── Session ────────────────────────────────────────
        case 'getSession': {
            const session = Auth.getSession();
            return { success: true, data: session };
        }

        // ── Bookmarks ──────────────────────────────────────
        case 'getBookmarkTree': {
            const tree = await chrome.bookmarks.getTree();
            return { success: true, data: tree };
        }

        case 'setSyncFolder': {
            const { teamId: tid, folderId: fid } = message;
            if (!tid) {
                return { success: false, error: 'teamId is required.' };
            }
            await TeamManagement.setTeamBookmarksFolder(tid, fid || null);
            // Restart sync with the new folder (or stop if cleared)
            if (fid) {
                const folderInfo = await TeamManagement.getTeamBookmarksFolder(tid);
                await SyncEngine.startSync(tid, folderInfo ? folderInfo.chromeFolderId : undefined);
            } else {
                await SyncEngine.stopSync();
            }
            return { success: true, data: { teamId: tid, folderId: fid || null } };
        }

        // ── Folder Subscriptions ───────────────────────────

        case 'getTeamFolderTree': {
            // Returns flat array of Supabase folder records for the current team
            const status = SyncEngine.getStatus();
            const teamId = message.teamId || status.teamId;
            if (!teamId) {
                return { success: false, error: 'No active team.' };
            }

            const supabase = createSupabaseClient();
            if (!supabase) {
                return { success: false, error: 'Supabase client not available.' };
            }

            const { data, error } = await supabase
                .from('bookmarks')
                .select('id, title, parent_id')
                .eq('team_id', teamId)
                .eq('is_folder', true)
                .is('deleted_at', null)
                .order('title', { ascending: true });

            if (error) {
                console.error('[TeamMarks] getTeamFolderTree failed:', error);
                return { success: false, error: error.message };
            }

            return { success: true, data: data || [] };
        }

        case 'getSubscribedFolderIds': {
            const status = SyncEngine.getStatus();
            const teamId = message.teamId || status.teamId;
            if (!teamId) {
                return { success: false, error: 'No active team.' };
            }
            const ids = await TeamManagement.getSubscribedFolders(teamId);
            return { success: true, data: ids };
        }

        case 'subscribeFolder': {
            const status = SyncEngine.getStatus();
            const teamId = message.teamId || status.teamId;
            const { supabaseFolderId } = message;
            if (!teamId || !supabaseFolderId) {
                return { success: false, error: 'teamId and supabaseFolderId are required.' };
            }

            // Add to subscriptions
            const current = await TeamManagement.getSubscribedFolders(teamId);
            if (!current.includes(supabaseFolderId)) {
                await TeamManagement.setSubscribedFolders(teamId, [...current, supabaseFolderId]);
            }

            // Ensure the Chrome folder exists under the team root before syncing
            const existingChromeId = SyncEngine.getChromeId(supabaseFolderId);
            if (!existingChromeId) {
                // Fetch the folder title from Supabase so we can create it in Chrome
                const supabase = createSupabaseClient();
                if (supabase) {
                    const { data: folderRecord, error: fetchErr } = await supabase
                        .from('bookmarks')
                        .select('title')
                        .eq('id', supabaseFolderId)
                        .single();

                    if (fetchErr) {
                        console.warn('[TeamMarks] subscribeFolder: could not fetch folder record:', fetchErr);
                    } else if (folderRecord) {
                        const syncStatus = SyncEngine.getStatus();
                        // teamRootFolderId is not directly exposed; get it via the folder mapping
                        const folderInfo = await TeamManagement.getTeamBookmarksFolder(teamId);
                        const teamRootId = folderInfo ? folderInfo.chromeFolderId : null;
                        if (teamRootId) {
                            try {
                                const newFolder = await chrome.bookmarks.create({
                                    parentId: teamRootId,
                                    title: folderRecord.title || ''
                                });
                                await SyncEngine.addIdMapping(newFolder.id, supabaseFolderId);
                                console.info('[TeamMarks] subscribeFolder: created Chrome folder', newFolder.id, 'for', supabaseFolderId);
                            } catch (createErr) {
                                console.warn('[TeamMarks] subscribeFolder: could not create Chrome folder:', createErr);
                            }
                        }
                    }
                }
            }

            // Enqueue a fullSync so the subscribed subtree is pulled down
            SyncEngine.enqueueSyncOp(() => SyncEngine.fullSync());

            return { success: true };
        }

        case 'unsubscribeFolder': {
            const status = SyncEngine.getStatus();
            const teamId = message.teamId || status.teamId;
            const { supabaseFolderId } = message;
            if (!teamId || !supabaseFolderId) {
                return { success: false, error: 'teamId and supabaseFolderId are required.' };
            }

            // Enqueue the entire unsubscribe operation to avoid races
            SyncEngine.enqueueSyncOp(async () => {
                // 1. Remove from subscriptions
                const ids = await TeamManagement.getSubscribedFolders(teamId);
                await TeamManagement.setSubscribedFolders(teamId, ids.filter(id => id !== supabaseFolderId));

                // 2. Find Chrome folder via idMap and remove subtree
                const chromeId = SyncEngine.getChromeId(supabaseFolderId);
                if (chromeId) {
                    // Collect all descendant Chrome IDs before removal
                    const allChromeIds = [];
                    try {
                        const subTree = await chrome.bookmarks.getSubTree(chromeId);
                        if (subTree && subTree.length > 0) {
                            collectChromeIds(subTree[0], allChromeIds);
                        }
                    } catch (err) {
                        console.warn('[TeamMarks] getSubTree failed during unsubscribe:', err);
                        allChromeIds.push(chromeId);
                    }

                    // Remove the Chrome subtree
                    try {
                        await chrome.bookmarks.removeTree(chromeId);
                    } catch (err) {
                        console.warn('[TeamMarks] removeTree failed during unsubscribe (continuing cleanup):', err);
                    }

                    // Clear all idMap entries
                    for (const cid of allChromeIds) {
                        await SyncEngine.removeIdMappingByChromeId(cid);
                    }
                }
            });

            return { success: true };
        }

        default:
            console.warn('[TeamMarks] Unknown message action:', action);
            return { success: false, error: `Unknown action: ${action}` };
    }
}

// ==============================================================
// Lifecycle events
// ==============================================================

/**
 * On install: ensure alarms are registered.
 * This fires when the extension is first installed or updated.
 */
chrome.runtime.onInstalled.addListener((details) => {
    console.info('[TeamMarks] Extension installed/updated:', details.reason);

    // On fresh install: set the first-run flag so the settings wizard shows
    if (details.reason === 'install') {
        chrome.storage.local.set({ teammarks_firstRun: true });
        console.info('[TeamMarks] First-run flag set.');
    }

    // Register the catch-up alarm immediately on install
    try {
        chrome.alarms.create('teammarks-catchup', { periodInMinutes: 5 });
        console.info('[TeamMarks] Catch-up alarm registered on install.');
    } catch (err) {
        console.error('[TeamMarks] Alarm registration on install failed:', err);
    }
});

// ==============================================================
// Initialize
// ==============================================================

/**
 * Recursively collect all Chrome bookmark IDs from a subtree node.
 * Used by the unsubscribeFolder handler to clean up idMap entries.
 *
 * @param {object} node - Chrome bookmark tree node
 * @param {string[]} result - Accumulator array
 */
function collectChromeIds(node, result) {
    result.push(node.id);
    if (node.children) {
        for (const child of node.children) {
            collectChromeIds(child, result);
        }
    }
}

initTeamMarks();