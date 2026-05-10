/**
 * TeamMarks — Team Management Module
 *
 * Manages team creation, joining via invite codes, membership, and team
 * selection. All state is cached in chrome.storage.local for offline access
 * and service worker restarts. Supabase is the source of truth; local
 * cache is refreshed on mutation and on init().
 *
 * EXPORTS (global scope for importScripts):
 *   TeamManagement.init()                        → Restore cache from storage
 *   TeamManagement.generateInviteCode()           → Generate random 6-char code
 *   TeamManagement.createTeam(orgId, name)        → Create team, auto-create folder, start sync
 *   TeamManagement.joinTeam(inviteCode)            → Join team; returns needsConflictResolution flag
 *   TeamManagement.leaveTeam(teamId)               → Leave a team
 *   TeamManagement.getMyTeams()                     → Returns cached team list (sync)
 *   TeamManagement.refreshTeams()                   → Fetch teams from Supabase
 *   TeamManagement.getTeamMembers(teamId)          → List team members
 *   TeamManagement.getTeamBookmarksFolder(teamId)  → Get local Chrome folder mapping
 *   TeamManagement.setTeamBookmarksFolder(teamId, folderId) → Set Chrome folder
 *   TeamManagement.resolveJoinConflict(teamId, resolution, existingFolderId, teamName)
 *                                                  → Resolve folder conflict after joinTeam
 *
 * REMOVED (subscription model replaced by auto-folder management):
 *   getSubscribedFolders, setSubscribedFolders, setCurrentTeam, getCurrentTeam
 *
 * DEPENDENCIES (load via importScripts before this file):
 *   - lib/config.js   (SUPABASE_CONFIG)
 *   - lib/supabase.js  (createSupabaseClient)
 *   - auth.js          (Auth.getSession)
 */

const TeamManagement = (() => {

    // ---------------------------------------------------------------
    // Storage keys
    // ---------------------------------------------------------------

    const STORAGE_KEY_TEAMS = 'teammarks_teams';
    const STORAGE_KEY_SYNC_FOLDERS = 'teammarks_syncFolders';

    // ---------------------------------------------------------------
    // In-memory cache
    // ---------------------------------------------------------------

    /** @type {object[]} Cached list of teams the user belongs to */
    let _teams = [];

    /**
     * @type {object} Map of teamId → { chromeFolderId } from storage.
     * Legacy values may still be plain strings (chromeFolderId only).
     */
    let _syncFolders = {};

    // ---------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------

    /**
     * Get the current user's ID from the Auth module.
     * @returns {string|null} User ID or null if not authenticated
     */
    function _getUserId() {
        const session = Auth.getSession();
        return session ? session.userId : null;
    }

    /**
     * Get the Supabase client, throwing if not available.
     * @returns {object} Supabase client
     * @throws {Error} If Supabase client is unavailable
     */
    function _getSupabase() {
        const supabase = createSupabaseClient();
        if (!supabase) {
            throw new Error('[TeamMarks TeamMgmt] Supabase client not available. Check config and auth.');
        }
        return supabase;
    }

    /**
     * Require authentication — throws if user is not signed in.
     * @returns {string} The current user's ID
     * @throws {Error} If not authenticated
     */
    function _requireAuth() {
        const userId = _getUserId();
        if (!userId) {
            throw new Error('[TeamMarks TeamMgmt] Not authenticated. Sign in first.');
        }
        return userId;
    }

    /**
     * Save the teams list and sync folders to chrome.storage.local.
     * Note: teammarks_currentTeamId is no longer persisted (multi-team model).
     * @returns {Promise<void>}
     */
    async function _persistCache() {
        await chrome.storage.local.set({
            [STORAGE_KEY_TEAMS]: _teams,
            [STORAGE_KEY_SYNC_FOLDERS]: _syncFolders
        });
    }

    // ---------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------

    /**
     * Initialize the module by restoring cached state from chrome.storage.local.
     * Call this once when the service worker starts, after Auth.init().
     *
     * @returns {Promise<void>}
     */
    async function init() {
        try {
            const result = await chrome.storage.local.get([
                STORAGE_KEY_TEAMS,
                STORAGE_KEY_SYNC_FOLDERS
            ]);

            _teams = (result[STORAGE_KEY_TEAMS] || []).map(t => ({
                ...t,
                sync_enabled: t.sync_enabled ?? true  // legacy rows default to ON
            }));
            _syncFolders = result[STORAGE_KEY_SYNC_FOLDERS] || {};

            console.info('[TeamMarks TeamMgmt] Restored', _teams.length, 'teams from cache.');
        } catch (err) {
            console.error('[TeamMarks TeamMgmt] Failed to restore cache:', err);
            _teams = [];
            _syncFolders = {};
        }
    }

    /**
     * Generate a short alphanumeric invite code (6 characters).
     * This is used client-side for display or regeneration.
     * The database also auto-generates invite_code on INSERT via DEFAULT,
     * so this function is not needed for createTeam — the DB handles it.
     *
     * @returns {string} A random 6-character alphanumeric code (uppercase + digits)
     */
    function generateInviteCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I,O,0,1 to avoid confusion
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return code;
    }

    /**
     * Ensure the [TeamMarks] parent folder exists at the Bookmarks Bar level.
     * Searches before creating to avoid duplicates (race-safe: search-first wins).
     *
     * @returns {Promise<string>} Chrome folder ID of the [TeamMarks] folder
     */
    async function _ensureParentFolder() {
        const PARENT_TITLE = '[TeamMarks]';
        const BOOKMARKS_BAR_ID = '1';

        // Search children of Bookmarks Bar for existing [TeamMarks] folder
        try {
            const children = await chrome.bookmarks.getChildren(BOOKMARKS_BAR_ID);
            const existing = children.find(n => n.title === PARENT_TITLE && !n.url);
            if (existing) {
                return existing.id;
            }
        } catch (err) {
            console.warn('[TeamMarks TeamMgmt] Failed to search Bookmarks Bar children:', err);
        }

        // Not found — create it
        const folder = await chrome.bookmarks.create({
            parentId: BOOKMARKS_BAR_ID,
            title: PARENT_TITLE
        });
        console.info('[TeamMarks TeamMgmt] Created [TeamMarks] parent folder:', folder.id);
        return folder.id;
    }

    /**
     * Ensure [TeamMarks]/<teamName> exists. Creates it if absent.
     * Returns { folderId, existed } so callers can detect conflicts.
     *
     * @param {string} teamName - Display name of the team
     * @returns {Promise<{ folderId: string, existed: boolean }>}
     */
    async function _ensureTeamFolder(teamName) {
        const parentId = await _ensureParentFolder();

        // Search children for existing team folder
        try {
            const children = await chrome.bookmarks.getChildren(parentId);
            const existing = children.find(n => n.title === teamName && !n.url);
            if (existing) {
                return { folderId: existing.id, existed: true };
            }
        } catch (err) {
            console.warn('[TeamMarks TeamMgmt] Failed to search [TeamMarks] children:', err);
        }

        // Not found — create it
        const folder = await chrome.bookmarks.create({ parentId, title: teamName });
        console.info('[TeamMarks TeamMgmt] Created team folder:', teamName, '->', folder.id);
        return { folderId: folder.id, existed: false };
    }

    /**
     * Create a new team in the given organization.
     * The current user is automatically added as an admin member.
     * Auto-creates [TeamMarks]/<name> in the Bookmarks Bar and starts sync.
     *
     * @param {string} orgId - UUID of the organization to create the team in
     * @param {string} name - Display name for the team
     * @returns {Promise<object>} The newly created team (includes invite_code)
     * @throws {Error} If not authenticated, or if Supabase insert fails
     */
    /**
     * Ensure the Supabase client carries the current auth session.
     * After a service worker restart the singleton client exists but has no
     * JWT loaded, so every DB request goes out unauthenticated.
     *
     * @param {object} supabase - The Supabase client singleton
     * @returns {Promise<void>}
     */
    async function _ensureSession(supabase) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) return; // already hydrated

        // No session in the client — inject it from our own storage
        const stored = Auth.getSession();
        if (!stored || !stored.accessToken) {
            throw new Error('[TeamMarks TeamMgmt] No auth session available. Sign in first.');
        }

        console.warn('[TeamMarks TeamMgmt] Supabase client had no session — hydrating from Auth cache.');
        const { error } = await supabase.auth.setSession({
            access_token: stored.accessToken,
            refresh_token: stored.refreshToken || ''
        });
        if (error) {
            console.error('[TeamMarks TeamMgmt] setSession failed:', error);
            throw new Error(`Failed to hydrate Supabase session: ${error.message}`);
        }
    }

    async function createTeam(orgId, name) {
        const userId = _requireAuth();
        const supabase = _getSupabase();
        await _ensureSession(supabase);

        if (!orgId) {
            throw new Error('[TeamMarks TeamMgmt] Organization ID is required to create a team.');
        }
        if (!name || !name.trim()) {
            throw new Error('[TeamMarks TeamMgmt] Team name is required.');
        }

        const slug = name.trim().toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');

        // Generate the team ID client-side so we can reference it without
        // needing RETURNING (which would fail the SELECT RLS policy because
        // the creator is not yet a member of the team they just created).
        const teamId = crypto.randomUUID();

        // Step 1: Insert the team (no .select() — avoids RETURNING RLS check)
        const { error: teamError } = await supabase
            .from('teams')
            .insert({
                id: teamId,
                organization_id: orgId,
                name: name.trim(),
                slug: slug || `team-${Date.now()}`
            });

        if (teamError) {
            console.error('[TeamMarks TeamMgmt] Failed to create team:', teamError);
            throw new Error(`Failed to create team: ${teamError.message}`);
        }

        // Step 2: Add creator as admin
        const { error: memberError } = await supabase
            .from('team_members')
            .insert({
                team_id: teamId,
                user_id: userId,
                role: 'admin'
            });

        if (memberError) {
            console.error('[TeamMarks TeamMgmt] Failed to add creator as admin:', memberError);
            // Attempt to clean up the orphaned team
            try {
                await supabase.from('teams').delete().eq('id', teamId);
            } catch (_) { /* best effort cleanup */ }
            throw new Error(`Failed to add team admin: ${memberError.message}`);
        }

        // Step 3: Fetch the team (now passes SELECT RLS because user is a member)
        const { data: team, error: fetchError } = await supabase
            .from('teams')
            .select('*')
            .eq('id', teamId)
            .single();

        if (fetchError || !team) {
            console.error('[TeamMarks TeamMgmt] Failed to fetch created team:', fetchError);
            throw new Error(`Team created but could not be fetched: ${(fetchError || {}).message || 'unknown'}`);
        }

        // Step 4: Update local cache
        _teams.push({
            id: team.id,
            name: team.name,
            slug: team.slug,
            invite_code: team.invite_code,
            role: 'admin',
            sync_enabled: true
        });
        await _persistCache();

        // Step 5: Auto-create [TeamMarks]/<name> and start sync
        try {
            const { folderId } = await _ensureTeamFolder(name.trim());
            await setTeamBookmarksFolder(team.id, folderId);
            // SyncEngine is loaded after TeamManagement in importScripts order,
            // so we call it via the global — it's available by the time createTeam is invoked.
            await SyncEngine.startSync(team.id);
        } catch (folderErr) {
            console.warn('[TeamMarks TeamMgmt] createTeam: folder/sync setup failed (non-fatal):', folderErr);
        }

        console.info('[TeamMarks TeamMgmt] Created team:', team.name, '(invite:', team.invite_code + ')');
        return { team };
    }

    /**
     * Join an existing team using its invite code.
     *
     * @param {string} inviteCode - The team's invite code (6-char alphanumeric)
     * @returns {Promise<object>} The joined team
     * @throws {Error} If not authenticated, invite code not found, or already a member
     */
    async function joinTeam(inviteCode) {
        const userId = _requireAuth();
        const supabase = _getSupabase();
        await _ensureSession(supabase);

        if (!inviteCode || !inviteCode.trim()) {
            throw new Error('[TeamMarks TeamMgmt] Invite code is required.');
        }

        // Step 1: Find the team by invite code via SECURITY DEFINER RPC
        // (Direct SELECT on teams filtered by invite_code is blocked by RLS for non-members)
        const { data: teams, error: findError } = await supabase
            .rpc('find_team_by_invite_code', { code: inviteCode.trim().toUpperCase() });

        if (findError) {
            console.error('[TeamMarks TeamMgmt] Failed to look up invite code:', findError);
            throw new Error(`Failed to look up invite code: ${findError.message}`);
        }

        if (!teams || teams.length === 0) {
            throw new Error('[TeamMarks TeamMgmt] Invalid invite code. No team found.');
        }

        const team = teams[0];

        // Step 2: Check if already a member
        const { data: existingMembership } = await supabase
            .from('team_members')
            .select('id')
            .eq('team_id', team.id)
            .eq('user_id', userId)
            .maybeSingle();

        if (existingMembership) {
            throw new Error('[TeamMarks TeamMgmt] You are already a member of this team.');
        }

        // Step 3: Join the team
        const { error: joinError } = await supabase
            .from('team_members')
            .insert({
                team_id: team.id,
                user_id: userId,
                role: 'member'
            });

        if (joinError) {
            console.error('[TeamMarks TeamMgmt] Failed to join team:', joinError);
            throw new Error(`Failed to join team: ${joinError.message}`);
        }

        // Step 4: Refresh cache from Supabase — now that we're a member the
        // normal team_members query returns the full team row including invite_code.
        await refreshTeams();

        // Step 5: Check for local folder conflict
        const teamObj = _teams.find(t => t.id === team.id) || team;
        const teamName = teamObj.name || team.name;

        const { folderId: existingFolderId, existed } = await _ensureTeamFolder(teamName);

        if (existed) {
            // Folder already exists locally — caller must resolve before sync starts
            console.info('[TeamMarks TeamMgmt] Join conflict detected for team:', teamName);
            return {
                team: teamObj,
                needsConflictResolution: true,
                existingFolderId,
                teamName
            };
        }

        // No conflict — set folder and start sync
        await setTeamBookmarksFolder(team.id, existingFolderId);
        try {
            await SyncEngine.startSync(team.id);
        } catch (syncErr) {
            console.warn('[TeamMarks TeamMgmt] joinTeam: startSync failed (non-fatal):', syncErr);
        }

        console.info('[TeamMarks TeamMgmt] Joined team:', teamName);
        return { team: teamObj, needsConflictResolution: false };
    }

    /**
     * Leave a team by removing the current user's membership.
     *
     * @param {string} teamId - UUID of the team to leave
     * @returns {Promise<void>}
     * @throws {Error} If not authenticated or deletion fails
     */
    async function leaveTeam(teamId) {
        const userId = _requireAuth();
        const supabase = _getSupabase();
        await _ensureSession(supabase);

        if (!teamId) {
            throw new Error('[TeamMarks TeamMgmt] Team ID is required.');
        }

        // Remove membership
        const { error } = await supabase
            .from('team_members')
            .delete()
            .eq('team_id', teamId)
            .eq('user_id', userId);

        if (error) {
            console.error('[TeamMarks TeamMgmt] Failed to leave team:', error);
            throw new Error(`Failed to leave team: ${error.message}`);
        }

        // Update local cache
        _teams = _teams.filter(t => t.id !== teamId);

        // Clean up sync folder mapping
        delete _syncFolders[teamId];

        await _persistCache();

        console.info('[TeamMarks TeamMgmt] Left team:', teamId);
    }

    /**
     * Get the cached list of teams the current user belongs to.
     * Returns from in-memory cache — call refreshTeams() first for fresh data.
     *
     * @returns {object[]} Array of team objects with id, name, slug, invite_code, role
     */
    function getMyTeams() {
        return _teams;
    }

    /**
     * Refresh the team list from Supabase and update the local cache.
     * Call this on service worker startup and periodically for freshness.
     *
     * @returns {Promise<object[]>} The refreshed team list
     */
    async function refreshTeams() {
        const userId = _requireAuth();
        const supabase = _getSupabase();
        await _ensureSession(supabase);

        // Query teams where the current user is a member
        const { data, error } = await supabase
            .from('team_members')
            .select('team_id, role, teams(id, name, slug, invite_code)')
            .eq('user_id', userId);

        if (error) {
            console.error('[TeamMarks TeamMgmt] Failed to refresh teams:', error);
            throw new Error(`Failed to refresh teams: ${error.message}`);
        }

        _teams = (data || []).map(row => ({
            id: row.teams.id,
            name: row.teams.name,
            slug: row.teams.slug,
            invite_code: row.teams.invite_code,
            role: row.role,
            sync_enabled: _teams.find(t => t.id === row.teams.id)?.sync_enabled ?? true
        }));

        await _persistCache();

        console.info('[TeamMarks TeamMgmt] Refreshed', _teams.length, 'teams.');
        return _teams;
    }

    /**
     * Get the list of members in a team.
     * Requires that the current user is a member of the team (enforced by RLS).
     *
     * @param {string} teamId - UUID of the team
     * @returns {Promise<object[]>} Array of member objects
     * @throws {Error} If not authenticated or query fails
     */
    async function getTeamMembers(teamId) {
        _requireAuth();
        const supabase = _getSupabase();
        await _ensureSession(supabase);

        if (!teamId) {
            throw new Error('[TeamMarks TeamMgmt] Team ID is required.');
        }

        const { data, error } = await supabase
            .from('team_members')
            .select('user_id, role, joined_at')
            .eq('team_id', teamId)
            .order('joined_at', { ascending: true });

        if (error) {
            console.error('[TeamMarks TeamMgmt] Failed to get team members:', error);
            throw new Error(`Failed to get team members: ${error.message}`);
        }

        return data || [];
    }

    /**
     * Normalize a raw storage entry for a team to the new object shape.
     * Legacy format was a plain string (chromeFolderId only) or had subscribedFolderIds.
     * New format: { chromeFolderId: string }
     *
     * @param {any} raw - Raw value from _syncFolders[teamId]
     * @returns {{ chromeFolderId: string }|null}
     */
    function _normalizeFolderEntry(raw) {
        if (!raw) return null;
        // Legacy: plain string
        if (typeof raw === 'string') {
            return { chromeFolderId: raw };
        }
        // Object shape (new or old with subscribedFolderIds)
        if (typeof raw === 'object' && raw.chromeFolderId) {
            return { chromeFolderId: raw.chromeFolderId };
        }
        return null;
    }

    /**
     * Get the Chrome bookmark folder ID mapped to a team.
     * This is stored in chrome.storage.local under the key 'teammarks_syncFolders'.
     * Normalizes legacy plain-string values on read.
     *
     * @param {string} teamId - UUID of the team
     * @returns {Promise<{chromeFolderId: string, subscribedFolderIds: string[]}|null>}
     */
    async function getTeamBookmarksFolder(teamId) {
        if (!teamId) return null;

        // Refresh from storage in case popup updated it
        try {
            const result = await chrome.storage.local.get(STORAGE_KEY_SYNC_FOLDERS);
            _syncFolders = result[STORAGE_KEY_SYNC_FOLDERS] || {};
        } catch (_) { /* use cached value */ }

        return _normalizeFolderEntry(_syncFolders[teamId]);
    }

    /**
     * Set the Chrome bookmark folder mapping for a team.
     * Writes the new object shape { chromeFolderId, subscribedFolderIds[] },
     * preserving any existing subscribedFolderIds.
     * When folderId is null/undefined, the mapping is removed.
     *
     * @param {string} teamId - UUID of the team
     * @param {string|null} folderId - Chrome bookmark folder ID, or null to clear
     * @returns {Promise<void>}
     */
    async function setTeamBookmarksFolder(teamId, folderId) {
        if (!teamId) {
            throw new Error('[TeamMarks TeamMgmt] Team ID is required.');
        }

        if (folderId) {
            _syncFolders[teamId] = { chromeFolderId: folderId };
        } else {
            delete _syncFolders[teamId];
        }

        await _persistCache();
        console.info('[TeamMarks TeamMgmt] Set sync folder for team', teamId, ':', folderId || '(none)');
    }

    /**
     * Resolve a folder conflict that arose during joinTeam.
     * Called by the popup after the user selects a resolution in the conflict modal.
     *
     * Resolutions:
     *   keep          - Rename existing folder to "<name> (backup)", create fresh folder, pull remote
     *   replace-local - Use existing folder as-is; fullSync will push local content up
     *   replace-remote - Clear existing folder contents; fullSync will pull remote content down
     *   combine       - Use existing folder; applyDiff (LWW) merges both sets
     *
     * After any resolution, SyncEngine.startSync(teamId) is called to begin sync.
     *
     * @param {string} teamId - UUID of the team
     * @param {'keep'|'replace-local'|'replace-remote'|'combine'} resolution
     * @param {string} existingFolderId - Chrome ID of the conflicting local folder
     * @param {string} teamName - Display name of the team (used for folder naming)
     * @returns {Promise<{ folderId: string }>}
     */
    async function resolveJoinConflict(teamId, resolution, existingFolderId, teamName) {
        if (!teamId || !resolution || !existingFolderId) {
            throw new Error('[TeamMarks TeamMgmt] resolveJoinConflict: teamId, resolution, and existingFolderId are required.');
        }

        let folderId = existingFolderId;

        switch (resolution) {
            case 'keep': {
                // Rename the old folder to "<name> (backup)"
                await chrome.bookmarks.update(existingFolderId, { title: `${teamName} (backup)` });
                // Create a fresh team folder
                const { folderId: newFolderId } = await _ensureTeamFolder(teamName);
                folderId = newFolderId;
                await setTeamBookmarksFolder(teamId, folderId);
                // fullSync will pull remote content into the fresh folder
                break;
            }

            case 'replace-local': {
                // Use existing folder; fullSync will push local bookmarks up to remote
                await setTeamBookmarksFolder(teamId, existingFolderId);
                break;
            }

            case 'replace-remote': {
                // Clear all children of the existing folder, then fullSync pulls remote down
                try {
                    const children = await chrome.bookmarks.getChildren(existingFolderId);
                    for (const child of children) {
                        try {
                            await chrome.bookmarks.removeTree(child.id);
                        } catch (_) {
                            try { await chrome.bookmarks.remove(child.id); } catch (__) { /* best effort */ }
                        }
                    }
                } catch (err) {
                    console.warn('[TeamMarks TeamMgmt] resolveJoinConflict replace-remote: could not clear folder:', err);
                }
                await setTeamBookmarksFolder(teamId, existingFolderId);
                break;
            }

            case 'combine': {
                // Use existing folder; fullSync runs applyDiff which merges by LWW
                await setTeamBookmarksFolder(teamId, existingFolderId);
                break;
            }

            default:
                throw new Error(`[TeamMarks TeamMgmt] resolveJoinConflict: unknown resolution "${resolution}"`);
        }

        // Start sync — will run fullSync which applies the chosen strategy
        try {
            await SyncEngine.startSync(teamId);
        } catch (syncErr) {
            console.warn('[TeamMarks TeamMgmt] resolveJoinConflict: startSync failed (non-fatal):', syncErr);
        }

        console.info('[TeamMarks TeamMgmt] Join conflict resolved:', resolution, 'for team', teamId);
        return { folderId };
    }

    /**
     * Toggle sync on/off for a team.
     *
     * When enabled=false: sets the flag, persists, calls stopSync.
     * When enabled=true:  sets the flag, persists, then checks for a folder
     * mapping.  If _syncFolders[teamId] already exists the folder was already
     * created — skip conflict detection and start sync directly.  Otherwise
     * _ensureTeamFolder() checks for a pre-existing local folder.
     *
     * @param {string} teamId - UUID of the team
     * @param {boolean} enabled - Desired toggle state (true=ON, false=OFF)
     * @returns {Promise<{ needsConflictResolution: boolean, existingFolderId?: string, teamName?: string }>}
     * @throws {Error} If team is not found in the local cache
     */
    async function toggleTeamSync(teamId, enabled) {
        if (!teamId) {
            throw new Error('[TeamMarks TeamMgmt] toggleTeamSync: teamId is required.');
        }

        const idx = _teams.findIndex(t => t.id === teamId);
        if (idx === -1) {
            throw new Error('[TeamMarks TeamMgmt] toggleTeamSync: team not found in cache.');
        }

        const team = _teams[idx];
        team.sync_enabled = !!enabled;
        await _persistCache();

        if (!enabled) {
            // OFF — stop sync, nothing more to do
            try { await SyncEngine.stopSync(teamId); } catch (err) {
                console.warn('[TeamMarks TeamMgmt] toggleTeamSync OFF: stopSync failed (non-fatal):', err);
            }
            console.info('[TeamMarks TeamMgmt] Sync toggled OFF for team:', team.name);
            return { needsConflictResolution: false };
        }

        // ON — start sync if folder already mapped, else detect conflict
        if (_syncFolders[teamId]) {
            try { await SyncEngine.startSync(teamId); } catch (err) {
                console.warn('[TeamMarks TeamMgmt] toggleTeamSync ON: startSync failed (non-fatal):', err);
            }
            console.info('[TeamMarks TeamMgmt] Sync toggled ON for team (already mapped):', team.name);
            return { needsConflictResolution: false };
        }

        // No folder mapping yet — check for existing local folder
        const { folderId, existed } = await _ensureTeamFolder(team.name);

        if (!existed) {
            await setTeamBookmarksFolder(teamId, folderId);
            try { await SyncEngine.startSync(teamId); } catch (err) {
                console.warn('[TeamMarks TeamMgmt] toggleTeamSync ON: startSync failed (non-fatal):', err);
            }
            console.info('[TeamMarks TeamMgmt] Sync toggled ON for team (new folder):', team.name);
            return { needsConflictResolution: false };
        }

        // Conflict — existing local folder, caller must resolve before sync
        console.info('[TeamMarks TeamMgmt] Toggle ON conflict detected for team:', team.name);
        return {
            needsConflictResolution: true,
            existingFolderId: folderId,
            teamName: team.name
        };
    }

    // Return the public API
    return Object.freeze({
        init,
        generateInviteCode,
        createTeam,
        joinTeam,
        leaveTeam,
        getMyTeams,
        refreshTeams,
        getTeamMembers,
        getTeamBookmarksFolder,
        setTeamBookmarksFolder,
        resolveJoinConflict,
        toggleTeamSync
    });
})();