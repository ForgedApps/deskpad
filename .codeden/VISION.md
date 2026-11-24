# Vision

Deskpad is a calm Windows 11 sidebar that keeps the day in view: today's calendar,
a Workflowy-style outline of notes and tasks, capture from anywhere, and a warning
before every meeting. The notes sync to the cloud at deskpad.win, open on a phone as
a web app, and are kept as Markdown that AI tools can read.

## Goals
- The sidebar is always there and never in the way: docked to the right edge, fast, quiet
- Writing a note or a task takes one keystroke from anywhere (Ctrl+Space)
- No meeting is missed: a full-screen alert two minutes before it starts
- Days are the record and the outline is the workspace: the journal shows any past day
- Notes, tasks and pictures sync between devices and keep working offline
- The notes are a Markdown knowledge base in the cloud, readable by AI clients over MCP

## Target users
- One person at a Windows PC who lives in Google Calendar and wants their day and notes beside their work
- The same person on their phone, through the web app

## Principles
- Never lose user data: atomic writes, daily backups, corrupt files moved aside, merged saves, no unasked bulk deletes (see "Data safety rules" in `AGENTS.md`)
- Local files stay the working copy; the cloud is a backup and a bridge between devices
- Sign-in is Google only, one button, through a real browser flow; never a pasted token or a second way in
- Private by default: no tenant is ever taken from a request, and every data route needs a session
- Plain words in the UI, and every color comes from a theme token
- Small, tested changes; the web app reuses the sidebar's outline code rather than forking it

## Out of scope
- macOS or Linux builds of the sidebar
- Calendars other than Google (ICS support was removed on purpose)
- Teams, sharing or collaborative editing
- Accounts with passwords, or any sign-in besides Google
- Ads, tracking or telemetry

## Quality bar
- `cargo test`, `npx tsc --noEmit -p .`, `npx vite build`, `npm run test:web` and `npm --prefix cloud run check` pass
- Changes to the merge code keep `web/src/core.ts` and the Rust (`rank.rs`, `set_from_frontend`, `plan_rows`/`apply_rows`) in step
- UI changes come with screenshots in light and dark theme
- Behaviour changes update `AGENTS.md` when they change a rule written there

## Protected areas
- `src-tauri/src/store.rs`
- `src-tauri/src/sync.rs`
- `src-tauri/src/appbar.rs`
- `src-tauri/nsis/**`
- `src-tauri/tauri.conf.json`
- `src-tauri/capabilities/**`
- `cloud/src/auth.ts`
- `cloud/src/mcp.ts`
- `cloud/wrangler.jsonc`
- `web/public/_headers`
- `.github/workflows/**`
- `LICENSE`
- auth
- migrations
- payments
- licensing
