# Deskpad

A Windows 11 sidebar that docks to the right edge of your display, shows your
upcoming meetings, and keeps a Workflowy-style outline of notes and tasks. Capture one from anywhere with **Ctrl+Space**.

Built with [Tauri 2](https://tauri.app) (Rust backend, WebView2 frontend).

## Features

- **Docked sidebar** pinned to the right edge of the primary monitor. By default it
  registers as a Windows AppBar, so maximized windows stop at its edge instead of
  going underneath it (toggle in Settings). Every window follows the Windows
  light/dark app theme.
- **Today's calendar** from Google Calendar (OAuth, all your checked calendars,
  with Meet/Zoom/Teams join links). The view is a day: today by default, with
  tomorrow's early meetings called out below it (Settings → "Show tomorrow's
  events that start before", default 10 AM, so a first-thing meeting never
  surprises you). Arrows in the header step through other days; "today" jumps
  back. An empty day says so.
- **Tray icon**: left-click toggles the sidebar, right-click for capture,
  settings, and quit. Hiding the sidebar releases its reserved screen space.
- **Start on sign-in** toggle in Settings (adds a Run registry entry).
- **Notes & tasks outline** persisted locally (`%APPDATA%\com.jgentes.deskpad\tasks.json`).
  Every row is a note by default. Start it with `- ` or `[]`, or put `/task` anywhere
  in the text, to make it a task (`/note` converts back, as does **Ctrl+Enter**).
  **Tab** nests a row under the one above (to any depth), **Shift+Tab** un-nests,
  **Enter** splits or creates a row, **Backspace** on an empty row deletes it.
  Click a bullet to turn a note into a task; click a checkbox to complete it.
  A bullet with nested rows folds and unfolds them instead (tasks get a chevron
  in the left gutter for that); a folded parent shows how many rows it hides.
  The row's ✕ and "archive N completed" move rows (with their nested children)
  out of the outline into the archive rather than deleting them; they stay
  visible in the journal on the day they were written.
  URLs in a row are clickable links while the row isn't being edited, and a
  small Markdown set shows as formatting then too: `**bold**`, `*italic*`,
  `~~struck~~`, `` `code` `` and `[label](url)`. Pasting rich text (from a web
  page, Google Docs, Word, …) keeps bold, italics and links as those markers,
  turns list items into nested rows and checklist items into tasks; pasting
  several plain lines makes a row per line, indented lines nested. Paste an
  image (a screenshot, a picture copied from a page) and it is stored once and
  shown in the row scaled to the sidebar's width.
- **One sign-in** (optional): Settings → Sign in with Google opens your
  browser once. That shows your Google Calendar in the sidebar and backs up
  your notes, tasks, recorded days and pictures, kept in step across devices. Everything stays
  local too and works offline. The server is `cloud/`, a Cloudflare Worker.
- **On your phone**: the same server hosts a web app with your notes and
  tasks (nesting, pictures, offline). Open its address in the phone's
  browser, sign in, and add it to the home screen.
- **Moving rows**: drag a bullet (or a task's checkbox) to move the row, with
  everything nested under it, up or down the list or into another row. A line
  shows where it will land; the pointer's horizontal position picks the nesting
  level. Escape cancels.
- **Journal**: the outline is your workspace, the journal is the record. Open
  it from the Notes header ("journal") for a resizable window with a timeline
  of days down the left and one day in the middle: that day's calendar events
  (live from Google, or as the sidebar last recorded them when Google isn't
  reachable), everything written that day (live and archived rows, nested as
  in the outline), tasks completed that day and tasks scheduled for it.
  Archived rows can be restored or permanently deleted there; live rows have
  a "show in sidebar" button. ←/→ step days, `t` jumps to today, `/` focuses
  search, which looks through every row ever written and groups hits by day.
- **Scheduled tasks**: write the time into the row and it goes on your calendar.
  "meet with tom next friday at 10am", "dentist tomorrow 2:30pm", "call mom
  tonight", "taxes on 4/15", "standup in 2 hours" all work, in the outline (on
  Enter or when you leave the row) and in the capture popup. The date phrase is
  removed, the row becomes a task, and a badge shows when it is; hover the
  badge and click its ✕ to take it off the calendar again. A time without a
  date means today (or tomorrow if it has passed); a date without a time is an
  all-day event; "for 1 hour" sets the length (default 30 minutes). Plain day
  names in the middle of a sentence ("notes from monday meeting") are left
  alone, as are `/note` rows and anything "every ...". Editing a scheduled
  row's text with a new time moves the event.
- **Add events** from the "+" in the Up next header (title, date, time, duration);
  they land on your primary Google calendar. Requires the Calendar events scope,
  so connections made before this feature need a disconnect/reconnect in Settings.
- **Meeting alerts**: 2 minutes before a timed event starts, a full-screen overlay
  covers the display with the title, countdown, Join (Meet/Zoom/Teams), Snooze
  1 or 5 minutes, and Dismiss. Esc dismisses, Enter joins.
- **Global quick capture**: press **Ctrl+Space** in any app for a floating input.
  Type, hit Enter, and it's on your list. Esc or clicking away closes it.

## Run

```bash
npm install
npm run tauri dev
```

## Build an installer

```bash
npm run tauri build
```

Output lands in `src-tauri/target/release/bundle/` (MSI and NSIS installers).

## Connecting your calendar

### Sign in with Google (recommended)

Settings → **Sign in with Google**. Your browser opens, you pick your Google
account and allow calendar access, and you confirm the code Deskpad shows.
That one step gives the sidebar your calendar and turns on backup and sync.
There is nothing to paste into the app.

This needs a Deskpad server with Google sign-in configured; setting one up
(a Cloudflare Worker and a Google OAuth client) is described in
[cloud/README.md](cloud/README.md).

### Without an account

Deskpad can also read the calendar on its own, using the OAuth desktop-app
flow with PKCE and a loopback redirect. That needs its own OAuth client.
One-time setup in [Google Cloud Console](https://console.cloud.google.com/):

1. Create a project (or pick one) and enable the **Google Calendar API**
   (APIs & Services → Library).
2. Configure the OAuth consent screen (External, add yourself as a test user
   while the app is in testing).
3. Create an OAuth client of type **Desktop app**. Copy the client ID and
   client secret.
4. In Deskpad: Settings → **Connect a calendar without an account** → paste
   both → **Connect Google Calendar**. Your browser opens for consent;
   Deskpad listens on `127.0.0.1` for the redirect.

Those tokens live in `%APPDATA%\com.jgentes.deskpad\google_tokens.json` and
refresh automatically. When you are signed in, the account's access is used
instead. Declined invites and cancelled events are hidden.

## Installing (release build)

```powershell
cd D:\deskpad; npm run tauri build
```

Produces a one-click installer at
`src-tauri/target/release/bundle/nsis/Deskpad_<version>_x64-setup.exe`.
Double-click it and it installs per user with no wizard, no admin prompt and no
shortcut/launch questions: it closes a running Deskpad, copies the new build
and relaunches it. This comes from `src-tauri/nsis/installer.nsi`, a copy of
Tauri's stock NSIS template with passive mode and relaunch forced on (see the
header comment there; re-copy it when upgrading `@tauri-apps/cli`).

Bump `version` in `src-tauri/tauri.conf.json` before building a new release.
The installed app and the dev build share the same data folder, so notes and
settings carry over.

## Your data

Everything lives in `%APPDATA%\com.jgentes.deskpad\`:

| File | Contents |
|---|---|
| `tasks.json` | the notes/tasks outline |
| `archive.json` | archived rows, with the time they were archived |
| `day_events.json` | calendar events per day as the sidebar last saw them (for the journal; newest 2 years kept) |
| `settings.json` | settings, including the Google OAuth client |
| `google_tokens.json` | Google refresh token (delete to sign out) |
| `backups\tasks-YYYY-MM-DD.json` | first copy of the outline seen each day, newest 30 kept |

Writes are atomic (temp file + rename). A file that fails to parse is moved
aside as `*.corrupt-<timestamp>` rather than overwritten, and the UI never
saves the outline until it has successfully loaded it from disk.

Deskpad refuses to start (with a message) when launched from inside a
packaged (MSIX) app's sandbox, such as a terminal embedded in another app,
because Windows would then redirect its data folder to that app's private
cache and the notes you see would not be the ones the normally launched
Deskpad uses. The installer has the same check. Start it from the Start menu
or Explorer.

## Layout

| Path | What |
| --- | --- |
| `src-tauri/src/lib.rs` | Tauri commands, window setup, global shortcut |
| `src-tauri/src/appbar.rs` | Win32 `SHAppBarMessage` docking |
| `src-tauri/src/calendar.rs` | The shared `Meeting` type |
| `src-tauri/src/google.rs` | Google OAuth (PKCE + loopback) and Calendar API |
| `src-tauri/src/store.rs` | Outline items + settings persistence, task-marker parsing |
| `src/main.ts`, `index.html` | Sidebar UI |
| `src/outline.ts` | Notes/tasks outliner and archive view |
| `src/schedule.ts` | Natural-language date/time parser shared by the outline and capture |
| `src/journal.ts`, `journal.html` | Journal window: day timeline, day view, search |
| `src/text.ts` | Link rendering and day-key helpers shared by all windows |
| `src/capture.ts`, `capture.html` | Ctrl+Space capture popup |

## License

MIT. See [LICENSE](LICENSE); the NSIS installer template is derived from Tauri (MIT/Apache-2.0).
