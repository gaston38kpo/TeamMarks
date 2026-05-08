/**
 * TeamMarks — Supabase Client Wrapper
 *
 * This file provides a `createSupabaseClient()` factory that the service worker
 * and other modules can use to obtain a configured Supabase client instance.
 *
 * USAGE (in service-worker.js):
 *   importScripts('lib/config.js', 'lib/supabase.js');
 *   const supabase = createSupabaseClient();
 *
 * PREREQUISITE:
 *   The Supabase JS browser bundle must be loaded before this file.
 *   Download the latest UMD build from:
 *     https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js
 *   Place it as `lib/supabase-browser.js` in this project.
 *
 *   If the bundle is not present, this module will log a warning and return null.
 *   The extension will not function without it — but it won't crash either.
 */

/**
 * @typedef {object} SupabaseClient
 * A configured Supabase client instance (from @supabase/supabase-js).
 */

/**
 * Cached Supabase client singleton. Once created, the same instance is
 * returned on subsequent calls so that realtime subscriptions persist.
 * @type {SupabaseClient|null}
 * @private
 */
let _supabaseClient = null;

/**
 * Creates and returns a configured Supabase client.
 * On the first call this initializes the client; subsequent calls return
 * the cached singleton.
 *
 * Requires:
 *   - `SUPABASE_CONFIG` global object (from lib/config.js)
 *   - `supabase` global (from the UMD browser bundle)
 *
 * @returns {SupabaseClient|null} The Supabase client, or null if the
 *   browser bundle is missing or config is placeholder values.
 */
function createSupabaseClient() {
    if (_supabaseClient) {
        return _supabaseClient;
    }

    // Guard: check that SUPABASE_CONFIG was loaded via importScripts
    if (typeof SUPABASE_CONFIG === 'undefined') {
        console.error('[TeamMarks] SUPABASE_CONFIG not found. Did you importScripts("lib/config.js")?');
        return null;
    }

    // Guard: check that the Supabase browser bundle is loaded
    if (typeof supabase === 'undefined' || typeof supabase.createClient !== 'function') {
        console.error(
            '[TeamMarks] Supabase browser bundle not found. ' +
            'Download the UMD bundle from https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js ' +
            'and place it as lib/supabase-browser.js, then add importScripts("lib/supabase-browser.js") to service-worker.js.'
        );
        return null;
    }

    // Guard: refuse to connect with placeholder config
    if (
        SUPABASE_CONFIG.url === 'YOUR_SUPABASE_URL' ||
        SUPABASE_CONFIG.anonKey === 'YOUR_SUPABASE_ANON_KEY'
    ) {
        console.error(
            '[TeamMarks] Supabase config contains placeholder values. ' +
            'Edit lib/config.js with your project URL and anon key.'
        );
        return null;
    }

    _supabaseClient = supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, {
        auth: {
            // Don't auto-persist — we manage session ourselves in chrome.storage.local
            persistSession: false,
            // Don't auto-refresh — we handle token refresh via chrome.identity
            autoRefreshToken: false,
            // Detect session from URL (needed after OAuth redirect)
            detectSessionInUrl: false
        },
        realtime: {
            params: {
                eventsPerSecond: 10
            }
        }
    });

    console.info('[TeamMarks] Supabase client initialized for', SUPABASE_CONFIG.url);
    return _supabaseClient;
}

/**
 * Resets the cached client. Useful after sign-out so the next call
 * to createSupabaseClient() builds a fresh instance.
 */
function resetSupabaseClient() {
    _supabaseClient = null;
}