/**
 * TeamMarks — Supabase Configuration
 *
 * Replace the placeholder values below with your actual Supabase project URL
 * and anon key. You can find these in your Supabase dashboard under
 * Settings → API.
 *
 * This file is loaded via importScripts() in the service worker.
 */

const SUPABASE_CONFIG = Object.freeze((() => {
    const url = 'https://ijkyywqtglavunczlsyz.supabase.co';
    return {
        /** Your Supabase project URL, e.g. "https://abcdefgh.supabase.co" */
        url,

        /** Base URL for Supabase Edge Functions — derived from url to stay in sync */
        edgeFunctionUrl: `${url}/functions/v1`,

        /** Your Supabase anon/public key */
        anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlqa3l5d3F0Z2xhdnVuY3psc3l6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxOTkwOTEsImV4cCI6MjA5Mzc3NTA5MX0.vEPNgBZL3qjy3LNzq5thWA8TzYZnNB_Cr9I0dtfeexs',

        /** Realtime channel name for bookmark sync events */
        channelName: 'teammarks-sync'
    };
})());