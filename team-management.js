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
 *   TeamManagement.createTeam(orgId, name)        → Create team, add creator as admin
 *   TeamManagement.joinTeam(inviteCode)            → Join team by invite code
 *   TeamManagement.leaveTeam(teamId)               → Leave a team
 *   TeamManagement.getMyTeams()                     → Returns cached team list (sync)
 *   TeamManagement.refreshTeams()                   → Fetch teams from Supabase
 *   TeamManagement.getTeamMembers(teamId)          → List team members
 *   TeamManagement.getTeamBookmarksFolder(teamId)  → Get local Chrome folder mapping
 *   TeamManagement.setCurrentTeam(teamId)           → Switch active team
 *   TeamManagement.getCurrentTeam()                 → Returns active team (sync)
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
    const STORAGE_KEY_CURRENT_TEAM = 'teammarks_currentTeamId';
    const STORAGE_KEY_SYNC_FOLDERS = 'teammarks_syncFolders';

    // ---------------------------------------------------------------
    // In-memory cache
    // ---------------------------------------------------------------

    /** @type {object[]} Cached list of teams the user belongs to */
    let _teams = [];

    /** @type {string|null} UUID of the currently selected team */
    let _currentTeamId = null;

    /** @type {object} Map of teamId → chromeFolderId from storage */
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
     * Save the teams list and current team to chrome.storage.local.
     * @returns {Promise<void>}
     */
    async function _persistCache() {
        await chrome.storage.local.set({
            [STORAGE_KEY_TEAMS]: _teams,
            [STORAGE_KEY_CURRENT_TEAM]: _currentTeamId,
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
                STORAGE_KEY_CURRENT_TEAM,
                STORAGE_KEY_SYNC_FOLDERS
            ]);

            _teams = result[STORAGE_KEY_TEAMS] || [];
            _currentTeamId = result[STORAGE_KEY_CURRENT_TEAM] || null;
            _syncFolders = result[STORAGE_KEY_SYNC_FOLDERS] || {};

            console.info('[TeamMarks TeamMgmt] Restored', _teams.length, 'teams from cache.');
        } catch (err) {
            console.error('[TeamMarks TeamMgmt] Failed to restore cache:', err);
            _teams = [];
            _currentTeamId = null;
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
     * Create a new team in the given organization.
     * The current user is automatically added as an admin member.
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
            role: 'admin'
        });
        await _persistCache();

        console.info('[TeamMarks TeamMgmt] Created team:', team.name, '(invite:', team.invite_code + ')');
        return team;
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

        // Step 4: Update local cache
        _teams.push({
            id: team.id,
            name: team.name,
            slug: team.slug,
            invite_code: team.invite_code,
            role: 'member'
        });
        await _persistCache();

        console.info('[TeamMarks TeamMgmt] Joined team:', team.name);
        return team;
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

        // If leaving the current team, clear the selection
        if (_currentTeamId === teamId) {
            _currentTeamId = _teams.length > 0 ? _teams[0].id : null;
        }

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
            role: row.role
        }));

        // Ensure currentTeamId is still valid
        if (_currentTeamId && !_teams.find(t => t.id === _currentTeamId)) {
            _currentTeamId = _teams.length > 0 ? _teams[0].id : null;
        }

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
     * Get the Chrome bookmark folder ID mapped to a team.
     * This is stored in chrome.storage.local under the key 'teammarks_syncFolders'.
     *
     * @param {string} teamId - UUID of the team
     * @returns {Promise<{chromeFolderId: string}|null>} The folder mapping, or null
     */
    async function getTeamBookmarksFolder(teamId) {
        if (!teamId) return null;

        // Refresh from storage in case popup updated it
        try {
            const result = await chrome.storage.local.get(STORAGE_KEY_SYNC_FOLDERS);
            _syncFolders = result[STORAGE_KEY_SYNC_FOLDERS] || {};
        } catch (_) { /* use cached value */ }

        const folderId = _syncFolders[teamId];
        if (!folderId) return null;

        return { chromeFolderId: folderId };
    }

    /**
     * Set the currently active team. Persists to chrome.storage.local.
     *
     * @param {string} teamId - UUID of the team to make active
     * @returns {Promise<void>}
     * @throws {Error} If teamId is not in the user's team list
     */
    async function setCurrentTeam(teamId) {
        if (!teamId) {
            _currentTeamId = null;
            await _persistCache();
            return;
        }

        // Validate that the team exists in the user's list
        if (!_teams.find(t => t.id === teamId)) {
            throw new Error('[TeamMarks TeamMgmt] Cannot set current team: team not found in your team list.');
        }

        _currentTeamId = teamId;
        await _persistCache();

        console.info('[TeamMarks TeamMgmt] Current team set to:', teamId);
    }

    /**
     * Get the currently active team from cache.
     * Returns null if no team is selected or if the selected team is
     * no longer in the user's team list.
     *
     * @returns {object|null} The current team object, or null
     */
    function getCurrentTeam() {
        if (!_currentTeamId) return null;
        return _teams.find(t => t.id === _currentTeamId) || null;
    }

    /**
     * Set the Chrome bookmark folder mapping for a team.
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
            _syncFolders[teamId] = folderId;
        } else {
            delete _syncFolders[teamId];
        }

        await _persistCache();
        console.info('[TeamMarks TeamMgmt] Set sync folder for team', teamId, ':', folderId || '(none)');
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
        setCurrentTeam,
        getCurrentTeam
    });
})();