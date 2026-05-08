<div align="center">
    <img src="https://raw.githubusercontent.com/SimGus/chrome-addon-v3-starter/master/logo/logo-128.png"/>
    <h1>TeamMarks</h1>
    <h3>Sync bookmark folders with your team — in real time</h3>
</div>

TeamMarks is a Chrome extension that keeps bookmark folders synchronized across team members using Supabase as the sync backend.

When one teammate adds, moves, or deletes a bookmark, everyone else sees the change in seconds. No more shared documents full of links — just a regular bookmark folder that stays in sync.

## Features

- **Google Sign-In** — authenticate with your Google account via `chrome.identity`
- **Team-based sync** — join a team with an invite code, pick a bookmark folder, and sync
- **Real-time updates** — changes propagate instantly via Supabase Realtime
- **Conflict resolution** — last-write-wins with soft deletes; edit beats delete
- **Works offline** — service worker catches up on missed changes when it reconnects

## Installation

1. **Open [the extensions page](chrome://extensions)** in your browser.
2. **Toggle "Developer mode"** (top right).
3. **Click "Load unpacked"** and select this project's root folder.
4. The TeamMarks extension should appear in the list.

## Configuration

Before using TeamMarks, you need a Supabase project:

1. Create a project at [supabase.com](https://supabase.com).
2. Enable Google as an authentication provider in your Supabase project settings.
3. Copy your project URL and anon key into `lib/config.js`.
4. Run `supabase-schema.sql` in the Supabase SQL editor to create the required tables.
5. Download the Supabase JS client bundle:
   - **PowerShell**: `pwsh -File scripts/download-supabase.ps1`
   - **Bash**: `bash scripts/download-supabase.sh`
   - **Manual**: Download from https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js and save as `lib/supabase-browser.js`

## Development

This is a Manifest V3 extension with **no bundler, no npm, no TypeScript** — pure JavaScript loaded via `importScripts()` in the service worker.

```
├── manifest.json          Extension configuration
├── service-worker.js      Entry point — orchestrates all modules
├── auth.js                Google OAuth → Supabase Auth flow
├── lib/
│   ├── config.js          Supabase URL and anon key (edit this)
│   ├── supabase-browser.js Supabase JS client bundle (download via scripts/)
│   └── supabase.js        Supabase client wrapper (uses the bundle)
├── scripts/
│   ├── download-supabase.ps1  Download script (PowerShell)
│   └── download-supabase.sh   Download script (Bash)
├── popup/                 Extension popup UI
├── settings/              Extension options page
└── supabase-schema.sql    Database schema (run in Supabase dashboard)
```

## Architecture

- **Auth**: `chrome.identity.getAuthToken()` → Supabase Auth (Google provider) for zero-friction login.
- **Sync engine**: Chrome bookmark events → push to Supabase; Supabase Realtime → apply locally.
- **Echo guard**: Programmatic writes set a flag in `chrome.storage.local` so they don't trigger a push back to the server.
- **Service worker**: Designed for ephemeral operation — reconnects and catches up on every wake.
- **Conflict resolution**: Last-write-wins with soft deletes. If one person deletes and another edits, the edit wins.

## License

MIT