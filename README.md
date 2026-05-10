<div align="center">
    <img src="logo/favicon-128x128.png"/>
    <h1>TeamMarks</h1>
    <h3>Sync bookmark folders with your team — in real time</h3>
</div>

TeamMarks is a Chrome Extension (Manifest V3) that keeps bookmark folders synchronized across team members using Supabase as the backend. When one teammate adds, moves, or deletes a bookmark, everyone else sees the change in seconds.

## Features

- **Google Sign-In** — one-click auth via `chrome.identity`, no passwords
- **Team management** — create or join teams with an invite code
- **Real-time sync** — changes propagate instantly via Supabase Realtime
- **Conflict resolution** — last-write-wins; edit always beats delete
- **Offline resilience** — service worker catches up on missed changes when it reconnects

## Prerequisites

- [Supabase](https://supabase.com) project with Google Auth enabled
- [Supabase CLI](https://supabase.com/docs/guides/cli) (for deploying the Edge Function)
- A Google OAuth 2.0 **Web application** client (Client ID + Secret)

## Setup

### 1. Database

Run `supabase-schema.sql` in the [Supabase SQL editor](https://supabase.com/dashboard) to create the required tables, RLS policies, and helper functions.

### 2. Edge Function

The Google OAuth token exchange runs server-side to keep the Client Secret out of the extension bundle.

```bash
supabase login
supabase link --project-ref <your-project-ref>

supabase secrets set GOOGLE_CLIENT_ID="<your-client-id>"
supabase secrets set GOOGLECLIENTSECRET="<your-client-secret>"

supabase functions deploy google-token-exchange
```

### 3. Extension config

Edit `lib/config.js` with your Supabase project credentials:

```js
const url = 'https://<your-project-ref>.supabase.co';
return {
    url,
    edgeFunctionUrl: `${url}/functions/v1`,
    anonKey: '<your-anon-key>',
    channelName: 'teammarks-sync'
};
```

### 4. Supabase JS client

Download the client bundle (required — not installed via npm):

```bash
# PowerShell
pwsh -File scripts/download-supabase.ps1

# Bash
bash scripts/download-supabase.sh
```

### 5. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select this folder

## Project structure

```
├── manifest.json               Extension config, permissions, OAuth client ID
├── service-worker.js           Entry point — orchestrates all modules
├── auth.js                     Google OAuth → Supabase Auth flow
├── sync-engine.js              Bidirectional bookmark sync (Chrome ↔ Supabase)
├── conflict-resolution.js      Last-write-wins conflict resolver
├── team-management.js          Create / join / leave teams
├── lib/
│   ├── config.js               Supabase URL and anon key (edit this)
│   ├── supabase.js             Supabase client wrapper
│   └── supabase-browser.js     Supabase JS bundle (downloaded via scripts/)
├── supabase/
│   └── functions/
│       └── google-token-exchange/
│           └── index.ts        Edge Function — OAuth token exchange proxy
├── popup/                      Extension popup UI
├── settings/                   Extension options page
├── scripts/                    Supabase JS download helpers
└── supabase-schema.sql         Database schema, RLS policies, helper functions
```

## Architecture

| Layer | Approach |
|-------|----------|
| **Auth** | `launchWebAuthFlow` → auth code → Edge Function proxy → `supabase.auth.signInWithIdToken` |
| **Token exchange** | Supabase Edge Function (Deno) — Client Secret never touches the extension bundle |
| **Sync** | Chrome bookmark events → Supabase; Supabase Realtime → apply locally |
| **Conflict resolution** | Last-write-wins via `updated_at` timestamp; `applyDiff` runs on every full sync |
| **Echo guard** | Programmatic writes set a counter in `chrome.storage.local` to suppress re-sync loops |
| **Service worker** | Ephemeral by design — reconnects and catches up on every wake via `fullSync` |
| **No bundler** | Pure JS loaded via `importScripts()`. No npm, no TypeScript, no build step |

## License

MIT
