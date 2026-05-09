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
 *   signIn              → Auth.signIn()
 *   signOut             → Auth.signOut() + SyncEngine.stopAllSync()
 *   getSession          → Auth.getSession()
 *   getTeams            → TeamManagement.getMyTeams()
 *   createTeam          → TeamManagement.createTeam(orgId, name)
 *   joinTeam            → TeamManagement.joinTeam(inviteCode)
 *   leaveTeam           → TeamManagement.leaveTeam(teamId)
 *   syncStatus          → SyncEngine.getStatus()
 *   manualSync          → SyncEngine.fullSync(teamId) for all active teams
 *   resolveJoinConflict → TeamManagement.resolveJoinConflict(teamId, resolution, existingFolderId, teamName)
 *
 * REMOVED HANDLERS: selectTeam, setSyncFolder, getBookmarkTree,
 *   getTeamFolderTree, getSubscribedFolderIds, subscribeFolder, unsubscribeFolder
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

    // 1b. Migrate legacy storage keys — run before TeamManagement.init()
    //     Removed keys: teammarks_firstRun, teammarks_onboarded, teammarks_currentTeamId
    //     teammarks_lastSyncTimestamp → teammarks_lastSyncTimestamps (per-team Map)
    try {
        const legacyResult = await chrome.storage.local.get([
            'teammarks_lastSyncTimestamp',
            'teammarks_currentTeamId',
            'teammarks_firstRun',
            'teammarks_onboarded'
        ]);

        const keysToRemove = [
            'teammarks_firstRun',
            'teammarks_onboarded',
            'teammarks_currentTeamId'
        ];

        // Migrate scalar timestamp → per-team Map
        if (legacyResult['teammarks_lastSyncTimestamp']) {
            const legacyTs = legacyResult['teammarks_lastSyncTimestamp'];
            const currentTeamId = legacyResult['teammarks_currentTeamId'] || null;
            if (currentTeamId) {
                const existing = await chrome.storage.local.get('teammarks_lastSyncTimestamps');
                const tsMap = existing['teammarks_lastSyncTimestamps'] || {};
                if (!tsMap[currentTeamId]) {
                    tsMap[currentTeamId] = legacyTs;
                    await chrome.storage.local.set({ teammarks_lastSyncTimestamps: tsMap });
                }
            }
            keysToRemove.push('teammarks_lastSyncTimestamp');
        }

        await chrome.storage.local.remove(keysToRemove);
        console.info('[TeamMarks] Storage migration complete. Removed stale keys.');
    } catch (err) {
        console.warn('[TeamMarks] Storage migration failed (non-fatal):', err);
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

    // 4. If authenticated, start sync for all known teams
    if (session) {
        const teams = TeamManagement.getMyTeams();
        for (const team of teams) {
            try {
                await SyncEngine.startSync(team.id);
                console.info('[TeamMarks] Auto-resumed sync for team:', team.name);
            } catch (err) {
                console.error('[TeamMarks] Auto-resume sync failed for team', team.id, ':', err);
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

    const teams = TeamManagement.getMyTeams();
    if (teams.length === 0) {
        console.debug('[TeamMarks] No teams — skipping catch-up.');
        return;
    }

    // Sync each team independently; one failure must not block others
    for (const team of teams) {
        try {
            await SyncEngine.fullSync(team.id);
            console.info('[TeamMarks] Catch-up sync completed for team:', team.name);
        } catch (err) {
            console.error('[TeamMarks] Catch-up sync failed for team', team.id, ':', err);
        }
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

        // Start sync for all teams
        const teams = TeamManagement.getMyTeams();
        for (const team of teams) {
            try {
                await SyncEngine.startSync(team.id);
                console.info('[TeamMarks] Sync started for team:', team.name);
            } catch (err) {
                console.error('[TeamMarks] Failed to start sync for team', team.id, ':', err);
            }
        }
    } else {
        console.info('[TeamMarks] Auth state: signed out.');
        try {
            await SyncEngine.stopAllSync();
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
            await SyncEngine.stopAllSync();
            return { success: true };
        }

        // ── Teams ─────────────────────────────────────────
        case 'getTeams': {
            const teams = TeamManagement.getMyTeams();
            return { success: true, data: teams };
        }

        case 'createTeam': {
            const result = await TeamManagement.createTeam(message.orgId, message.name);
            return { success: true, data: result };
        }

        case 'joinTeam': {
            const result = await TeamManagement.joinTeam(message.inviteCode);
            return { success: true, data: result };
        }

        case 'leaveTeam': {
            await TeamManagement.leaveTeam(message.teamId);
            await SyncEngine.stopSync(message.teamId);
            return { success: true };
        }

        case 'getTeamMembers': {
            const members = await TeamManagement.getTeamMembers(message.teamId);
            return { success: true, data: members };
        }

        case 'resolveJoinConflict': {
            const { teamId, resolution, existingFolderId, teamName } = message;
            if (!teamId || !resolution || !existingFolderId) {
                return { success: false, error: 'teamId, resolution, and existingFolderId are required.' };
            }
            const result = await TeamManagement.resolveJoinConflict(teamId, resolution, existingFolderId, teamName);
            return { success: true, data: result };
        }

        // ── Sync ──────────────────────────────────────────
        case 'syncStatus': {
            const status = SyncEngine.getStatus();
            return { success: true, data: status };
        }

        case 'manualSync': {
            // Sync all active teams, collecting errors per team
            const teams = TeamManagement.getMyTeams();
            const errors = [];
            for (const team of teams) {
                try {
                    await SyncEngine.fullSync(team.id);
                } catch (err) {
                    errors.push({ teamId: team.id, error: err.message });
                }
            }
            const status = SyncEngine.getStatus();
            return { success: errors.length === 0, data: status, errors: errors.length > 0 ? errors : undefined };
        }

        // ── Session ────────────────────────────────────────
        case 'getSession': {
            const session = Auth.getSession();
            return { success: true, data: session };
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

    // On fresh install — no first-run flag needed (wizard removed in simplified flow)
    if (details.reason === 'install') {
        console.info('[TeamMarks] Fresh install detected.');
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

initTeamMarks();