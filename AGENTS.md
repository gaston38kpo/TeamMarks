# AGENTS.md — TeamMarks

Chrome Extension MV3 (Manifest V3) + Supabase backend. **No build step, no npm, no TypeScript in the extension** — pure vanilla JS loaded via `importScripts()`.

## Stack

| Layer | Tech |
|-------|------|
| Extension | Chrome MV3, Vanilla JS |
| Auth | `chrome.identity` → Google OAuth2 → Supabase Auth |
| Backend | Supabase (Realtime + REST + RLS) |
| Token exchange | Deno Edge Function (`supabase/functions/google-token-exchange/`) |
| Supabase JS client | UMD bundle downloaded from CDN — **not npm** |

## No build, no lint, no tests

- **No bundler.** No webpack, Vite, Rollup, esbuild.
- **No package.json.** No `npm install`. Do not create one.
- **No linter or formatter.** No ESLint, Prettier, or config files.
- **No automated test suite.** Strict TDD mode is disabled for this project.
- Verification = load the extension in Chrome and test manually.

## Module load order — non-negotiable

`service-worker.js` loads modules via `importScripts()` in this exact order:

```js
importScripts(
    'lib/config.js',        // must be first — defines SUPABASE_CONFIG
    'lib/supabase-browser.js', // UMD bundle — must precede lib/supabase.js
    'lib/supabase.js',      // creates the Supabase client using the bundle global
    'auth.js',
    'team-management.js',
    'conflict-resolution.js',
    'sync-engine.js'
);
```

This order is intentional. `lib/supabase.js` expects the `supabase` global to already exist from the UMD bundle.

## Key files

| File | Role |
|------|------|
| `service-worker.js` | Entry point — bootstraps all modules, handles alarm + message routing |
| `sync-engine.js` | Bidirectional bookmark sync (Chrome ↔ Supabase), echo guard, idMap |
| `conflict-resolution.js` | Last-write-wins via `updated_at`; `applyDiff` on every full sync |
| `team-management.js` | Create/join/leave teams, folder subscription, `chrome.storage.local` cache |
| `auth.js` | `launchWebAuthFlow` → Edge Function proxy → `signInWithIdToken` |
| `lib/config.js` | **Edit this** — Supabase URL and anon key (hardcoded, not env vars) |
| `lib/supabase-browser.js` | Supabase JS v2 UMD bundle; if missing, download with `scripts/download-supabase.ps1` |
| `supabase-schema.sql` | Full DB schema — run once in Supabase SQL editor |
| `supabase/functions/google-token-exchange/index.ts` | Deno Edge Function — keeps Google Client Secret server-side |
| `popup/popup.js` | Extension popup — communicates via `chrome.runtime.sendMessage` |
| `settings/settings.js` | Options page — same message protocol |

## Message protocol

All popup/settings → service worker communication uses:

```js
// Request
{ action: 'actionName', ...data }

// Response
{ success: boolean, data?: any, error?: string }
```

See the `MESSAGE HANDLERS` comment block at the top of `service-worker.js` for the full action list.

## Critical architecture gotchas

- **Service worker is ephemeral.** It terminates when idle and wakes on events. On each wake it runs `initTeamMarks()` → `fullSync()`. Do not assume in-memory state persists.
- **Echo guard.** Programmatic writes increment a counter in `chrome.storage.local` so incoming Realtime events from our own writes are suppressed. Do not break this pattern.
- **`lib/supabase-browser.js` is not in `.gitignore`** — it is committed to the repo. Only re-download it if it's missing or you need to upgrade the Supabase JS version.
- **`GOOGLECLIENTSECRET` has no underscore between CLIENT and SECRET** — this is the actual Supabase secret name. Spelling it differently breaks the Edge Function.

## Configuration

Edit `lib/config.js` directly — there is no `.env` file. The file is committed with real project credentials (public anon key and project URL are safe to commit).

## Edge Function deployment

Only needed when deploying changes to `supabase/functions/google-token-exchange/`:

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase secrets set GOOGLE_CLIENT_ID="<your-client-id>"
supabase secrets set GOOGLECLIENTSECRET="<your-client-secret>"
supabase functions deploy google-token-exchange
```

## Loading / testing the extension

1. `chrome://extensions` → Enable **Developer mode**
2. **Load unpacked** → select the repo root folder
3. Reload the extension after any JS change

## Git / PR conventions

- Branch names: `(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)/[a-z0-9._-]+`
- Commit messages: conventional commits — `type(scope): description`
- Every PR must link a GitHub issue that has been approved with `status:approved`
- Every PR must have exactly one `type:*` label
- PRs over 400 changed lines require a `size:exception` from the maintainer
