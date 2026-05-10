/**
 * TeamMarks — Auth Module
 *
 * Manages Google OAuth authentication via chrome.identity and Supabase Auth.
 * Uses launchWebAuthFlow() for cross-browser compatibility (Chrome, Edge, Brave, etc.)
 * chrome.identity.getAuthToken() does NOT work on Edge, so we use the standard
 * OAuth2 authorization code flow with launchWebAuthFlow instead.
 *
 * All state is persisted in chrome.storage.local so it survives service worker
 * restarts. The module is designed for Manifest V3's ephemeral service worker
 * lifecycle: init() restores an existing session without prompting the user.
 *
 * EXPORTS (global scope for importScripts):
 *   Auth.init()                        → Restore session from storage
 *   Auth.signIn()                       → Interactive Google sign-in
 *   Auth.signOut()                      → Clear session and revoke token
 *   Auth.getSession()                   → Returns current session or null
 *   Auth.onSessionChange(callback)      → Register listener for auth state changes
 *
 * DEPENDENCIES (load via importScripts before this file):
 *   - lib/config.js   (SUPABASE_CONFIG)
 *   - lib/supabase.js  (createSupabaseClient)
 */

const Auth = (() => {
    /** @type {object|null} Current Supabase session (accessToken, user, etc.) */
    let _session = null;

    /** @type {Function[]} Listeners called on session change */
    const _listeners = [];

    /** Storage key for the serialized session */
    const STORAGE_KEY_SESSION = 'teammarks_session';

    /** Storage key for cached Google tokens (to support sign-out revocation) */
    const STORAGE_KEY_TOKENS = 'teammarks_google_tokens';

    // ---------------------------------------------------------------
    // OAuth2 Configuration
    // ---------------------------------------------------------------

    /** Google OAuth2 endpoints */
    const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

    /**
     * Get the OAuth2 client ID from manifest or config.
     * The manifest oauth2 field is the primary source; config is fallback.
     */
    function _getClientId() {
        // Try manifest first (Chrome loads this natively)
        if (chrome.runtime && chrome.runtime.getManifest) {
            const manifest = chrome.runtime.getManifest();
            if (manifest.oauth2 && manifest.oauth2.client_id) {
                return manifest.oauth2.client_id;
            }
        }
        // Fallback: not available without manifest
        console.warn('[TeamMarks Auth] No oauth2.client_id in manifest. Google sign-in will not work.');
        return null;
    }

    /** Scopes required for Google sign-in */
    const GOOGLE_SCOPES = ['openid', 'email', 'profile'];

    /**
     * Get the redirect URI for launchWebAuthFlow.
     * Format: https://<extension-id>.chromiumapp.org/
     */
    function _getRedirectUri() {
        return `https://${chrome.runtime.id}.chromiumapp.org/`;
    }

    // ---------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------

    /**
     * Notify all registered listeners of a session change.
     * @param {object|null} session
     */
    function _notifyListeners(session) {
        for (const fn of _listeners) {
            try {
                fn(session);
            } catch (err) {
                console.error('[TeamMarks Auth] Listener error:', err);
            }
        }
    }

    /**
     * Persist the current session to chrome.storage.local.
     * @returns {Promise<void>}
     */
    async function _persistSession() {
        if (!_session) {
            await chrome.storage.local.remove(STORAGE_KEY_SESSION);
            return;
        }
        await chrome.storage.local.set({
            [STORAGE_KEY_SESSION]: {
                accessToken: _session.accessToken,
                refreshToken: _session.refreshToken,
                expiresAt: _session.expiresAt,
                userId: _session.userId,
                email: _session.email
            }
        });
    }

    /**
     * Remove persisted session from storage.
     * @returns {Promise<void>}
     */
    async function _clearPersistedSession() {
        await chrome.storage.local.remove(STORAGE_KEY_SESSION);
    }

    /**
     * Build a session object from a Supabase Auth response.
     * @param {object} supaSession - Supabase session object
     * @returns {object} Normalized session
     */
    function _buildSession(supaSession) {
        return {
            accessToken: supaSession.access_token,
            refreshToken: supaSession.refresh_token,
            expiresAt: supaSession.expires_at
                ? supaSession.expires_at * 1000 // Supabase returns seconds, we store ms
                : Date.now() + 3600 * 1000,
            userId: supaSession.user?.id || null,
            email: supaSession.user?.email || null
        };
    }

    /**
     * Check whether the session is still valid (not expired).
     * @param {object} session
     * @returns {boolean}
     */
    function _isSessionValid(session) {
        if (!session || !session.expiresAt) return false;
        // Consider session expired 60 seconds before actual expiry to avoid edge cases
        return session.expiresAt - 60 * 1000 > Date.now();
    }

    /**
     * Generate a random nonce for OpenID Connect (recommended by Google).
     * @returns {string}
     */
    function _generateNonce() {
        const array = new Uint8Array(32);
        crypto.getRandomValues(array);
        return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Exchange an authorization code for tokens via the Supabase Edge Function proxy.
     * The client_secret lives only in the Edge Function environment.
     * @param {string} code - The authorization code from the redirect
     * @param {string} redirectUri - The redirect URI used in the auth request
     * @returns {Promise<{id_token: string, access_token: string, refresh_token: string|null}>}
     */
    async function _exchangeCodeViaProxy(code, redirectUri) {
        const response = await fetch(
            `${SUPABASE_CONFIG.edgeFunctionUrl}/google-token-exchange`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${SUPABASE_CONFIG.anonKey}`
                },
                body: JSON.stringify({ code, redirect_uri: redirectUri })
            }
        );
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.message || `Token exchange failed: ${response.status}`);
        }
        return response.json();
    }

    /**
     * Revoke a Google access token (best-effort, used during sign-out).
     * @param {string} token
     * @returns {Promise<void>}
     */
    async function _revokeGoogleToken(token) {
        try {
            await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
                method: 'POST'
            });
        } catch (_) {
            // Best-effort — don't block sign-out on revocation failure
        }
    }

    // ---------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------

    /**
     * Initialize auth by restoring a previously saved session from storage.
     * Call this once when the service worker starts.
     *
     * @returns {Promise<object|null>} The restored session, or null if none
     */
    async function init() {
        try {
            const result = await chrome.storage.local.get(STORAGE_KEY_SESSION);
            const stored = result[STORAGE_KEY_SESSION];

            if (!stored) {
                console.info('[TeamMarks Auth] No stored session found.');
                return null;
            }

            const supabase = createSupabaseClient();
            if (!supabase) {
                console.warn('[TeamMarks Auth] Cannot restore session — Supabase client unavailable.');
                return null;
            }

            // Best path: token is still valid, hydrate the Supabase client directly.
            // This carries the JWT so RLS policies see auth.uid() on every query.
            if (_isSessionValid(stored)) {
                try {
                    await supabase.auth.setSession({
                        access_token: stored.accessToken,
                        refresh_token: stored.refreshToken
                    });
                    _session = stored;
                    console.info('[TeamMarks Auth] Supabase client hydrated from stored session.');
                    _notifyListeners(_session);
                    return _session;
                } catch (hydrateErr) {
                    console.warn('[TeamMarks Auth] setSession failed, attempting silent refresh:', hydrateErr);
                    // Fall through to refresh attempt — do NOT clear the session yet
                }
            } else {
                console.info('[TeamMarks Auth] Stored session expired, attempting silent refresh.');
            }

            // Token expired or setSession failed — try a silent refresh via Supabase.
            // This uses the stored refresh_token (no OAuth popup needed).
            if (stored.refreshToken) {
                try {
                    const { data, error } = await supabase.auth.refreshSession({
                        refresh_token: stored.refreshToken
                    });

                    if (error) throw error;

                    if (data.session) {
                        _session = _buildSession(data.session);
                        await _persistSession();
                        console.info('[TeamMarks Auth] Session refreshed for', _session.email);
                        _notifyListeners(_session);
                        return _session;
                    }
                } catch (refreshErr) {
                    console.warn('[TeamMarks Auth] Silent refresh failed:', refreshErr);
                }
            }

            // Everything failed — clear the session and let the user sign in again.
            console.info('[TeamMarks Auth] Could not restore or refresh session, clearing.');
            _session = null;
            await _clearPersistedSession();
            _notifyListeners(null);
            return null;
        } catch (err) {
            console.error('[TeamMarks Auth] Error restoring session:', err);
            _session = null;
            return null;
        }
    }

    /**
     * Sign in with Google using launchWebAuthFlow (cross-browser compatible).
     *
     * This works on Chrome, Edge, Brave, and all Chromium browsers.
     * It opens a Google sign-in popup, obtains an authorization code,
     * exchanges it for tokens, then sends the ID token to Supabase.
     *
     * Prerequisites in manifest.json:
     *   "oauth2": { "client_id": "<your-client-id>", "scopes": [...] }
     *
     * @param {object} [options] - Options for sign-in
     * @param {boolean} [options.interactive=true] - Whether to show the consent prompt
     * @returns {Promise<object>} The new session
     * @throws {Error} If authentication fails
     */
    async function signIn(options = {}) {
        const interactive = options.interactive !== undefined ? options.interactive : true;

        const supabase = createSupabaseClient();
        if (!supabase) {
            throw new Error('[TeamMarks Auth] Supabase client not available. Check config and bundle.');
        }

        const clientId = _getClientId();
        if (!clientId) {
            throw new Error('[TeamMarks Auth] No Google OAuth client_id configured. Add oauth2 to manifest.json or SUPABASE_CONFIG.');
        }

        const redirectUri = _getRedirectUri();

        // Step 1: Build the Google OAuth2 authorization URL
        // Note: We intentionally do NOT send a nonce parameter.
        // Supabase's signInWithIdToken doesn't accept nonce, and if Google
        // includes one in the ID token, Supabase rejects it.
        // The redirect_uri locked to our extension ID provides sufficient protection.
        const authUrl = new URL(GOOGLE_AUTH_URL);
        authUrl.searchParams.set('client_id', clientId);
        authUrl.searchParams.set('redirect_uri', redirectUri);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
        authUrl.searchParams.set('access_type', 'offline');
        authUrl.searchParams.set('prompt', interactive ? 'consent' : 'none');

        // Step 2: Open the auth flow in a popup via launchWebAuthFlow
        let redirectResponse;
        try {
            redirectResponse = await new Promise((resolve, reject) => {
                chrome.identity.launchWebAuthFlow({
                    url: authUrl.toString(),
                    interactive: interactive
                }, (responseUrl) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    if (!responseUrl) {
                        reject(new Error('No response URL returned from auth flow'));
                        return;
                    }
                    resolve(responseUrl);
                });
            });
        } catch (err) {
            console.error('[TeamMarks Auth] launchWebAuthFlow failed:', err);
            throw err;
        }

        // Step 3: Extract the authorization code from the redirect URL
        const responseUrl = new URL(redirectResponse);
        const authCode = responseUrl.searchParams.get('code');
        const errorParam = responseUrl.searchParams.get('error');

        if (errorParam) {
            throw new Error(`[TeamMarks Auth] Google auth error: ${errorParam}`);
        }

        if (!authCode) {
            throw new Error('[TeamMarks Auth] No authorization code in redirect response.');
        }

        // Step 4: Exchange the authorization code for Google tokens via the Edge Function proxy
        let googleTokens;
        try {
            googleTokens = await _exchangeCodeViaProxy(authCode, redirectUri);
        } catch (err) {
            console.error('[TeamMarks Auth] Token exchange via proxy failed:', err);
            throw err;
        }

        // Cache Google tokens for sign-out revocation
        try {
            await chrome.storage.local.set({
                [STORAGE_KEY_TOKENS]: {
                    accessToken: googleTokens.access_token,
                    refreshToken: googleTokens.refresh_token || null
                }
            });
        } catch (_) { /* non-critical */ }

        // Step 5: Exchange the Google ID token for a Supabase session
        try {
            const { data, error } = await supabase.auth.signInWithIdToken({
                provider: 'google',
                token: googleTokens.id_token
            });

            if (error) {
                console.error('[TeamMarks Auth] Supabase signInWithIdToken error:', error);
                throw error;
            }

            if (!data.session) {
                throw new Error('[TeamMarks Auth] Supabase returned no session after token exchange.');
            }

            _session = _buildSession(data.session);
            await _persistSession();
            _notifyListeners(_session);

            console.info('[TeamMarks Auth] Signed in as', _session.email);
            return _session;
        } catch (err) {
            console.error('[TeamMarks Auth] Supabase token exchange failed:', err);
            throw err;
        }
    }

    /**
     * Sign out. Clears the local session, removes it from storage,
     * revokes the Google OAuth token, and signs out from Supabase.
     *
     * @returns {Promise<void>}
     */
    async function signOut() {
        const supabase = createSupabaseClient();

        // Sign out from Supabase (best effort — don't block on failure)
        if (supabase) {
            try {
                await supabase.auth.signOut();
            } catch (err) {
                console.warn('[TeamMarks Auth] Supabase signOut error (ignored):', err);
            }
        }

        // Revoke cached Google tokens (best effort)
        try {
            const result = await chrome.storage.local.get(STORAGE_KEY_TOKENS);
            const tokens = result[STORAGE_KEY_TOKENS];
            if (tokens) {
                if (tokens.accessToken) {
                    await _revokeGoogleToken(tokens.accessToken);
                }
                await chrome.storage.local.remove(STORAGE_KEY_TOKENS);
            }
        } catch (_) { /* best effort */ }

        // Clear local state
        _session = null;
        await _clearPersistedSession();
        resetSupabaseClient();
        _notifyListeners(null);

        console.info('[TeamMarks Auth] Signed out.');
    }

    /**
     * Get the current session, if any.
     *
     * @returns {object|null} The current session, or null if not signed in
     */
    function getSession() {
        return _session;
    }

    /**
     * Register a callback to be invoked whenever the auth session changes.
     * The callback receives the new session object (or null on sign-out).
     *
     * @param {Function} callback - Called with (session|null) on auth state change
     */
    function onSessionChange(callback) {
        if (typeof callback === 'function') {
            _listeners.push(callback);
        }
    }

    /**
     * Attempt a session refresh. First tries a silent refresh via Supabase's
     * refresh token (no OAuth popup). Falls back to interactive Google OAuth
     * only when interactive=true and the silent refresh fails.
     *
     * @param {object} [options] - Refresh options
     * @param {boolean} [options.interactive=false] - Show consent popup if silent refresh fails
     * @returns {Promise<object>} The refreshed session
     * @throws {Error} If refresh fails
     */
    async function refreshSession(options = {}) {
        const interactive = options.interactive || false;

        // Step 1 — silent refresh via Supabase (no OAuth popup, uses stored refresh_token).
        // This is the fast path that works as long as the refresh token is still valid.
        if (_session && _session.refreshToken) {
            try {
                const supabase = createSupabaseClient();
                const { data, error } = await supabase.auth.refreshSession({
                    refresh_token: _session.refreshToken
                });

                if (!error && data.session) {
                    _session = _buildSession(data.session);
                    await _persistSession();
                    _notifyListeners(_session);
                    console.info('[TeamMarks Auth] Session refreshed silently.');
                    return _session;
                }
            } catch (silentErr) {
                console.warn('[TeamMarks Auth] Silent refresh failed:', silentErr);
                // Fall through to interactive auth if allowed
            }
        }

        // Step 2 — interactive fallback: full Google OAuth flow.
        // Only attempted when interactive=true (shows a consent popup).
        if (interactive) {
            try {
                return await signIn({ interactive: true });
            } catch (err) {
                console.error('[TeamMarks Auth] Interactive refresh failed:', err);

                // If refresh failed, clear the invalid session
                _session = null;
                await _clearPersistedSession();
                _notifyListeners(null);

                throw err;
            }
        }

        // Non-interactive and silent refresh failed — no session available.
        throw new Error('[TeamMarks Auth] Session refresh failed. User interaction required.');
    }

    /**
     * Check if the current session is valid, and attempt a silent refresh
     * if it's expired. This is useful before making authenticated API calls.
     *
     * @returns {Promise<object|null>} A valid session, or null if unauthenticated
     */
    async function ensureValidSession() {
        if (_isSessionValid(_session)) {
            return _session;
        }

        // Session expired or missing — try silent refresh
        try {
            return await refreshSession({ interactive: false });
        } catch (err) {
            console.warn('[TeamMarks Auth] Silent refresh failed, user interaction needed:', err.message);
            return null;
        }
    }

    // Return the public API
    return Object.freeze({
        init,
        signIn: signIn,
        signOut: signOut,
        getSession: getSession,
        onSessionChange: onSessionChange,
        refreshSession: refreshSession,
        ensureValidSession: ensureValidSession
    });
})();