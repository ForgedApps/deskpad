# Deskpad — notes for AI agents and contributors

Deskpad is a Windows 11 sidebar built with **Tauri 2** (Rust backend, vanilla
TypeScript + Vite frontend). It docks to the right screen edge as a Win32
AppBar, shows today's Google Calendar events (with tomorrow's early ones), keeps a
Workflowy-style outline of notes and tasks, captures notes from anywhere with
Ctrl+Space, and throws a full-screen alert two minutes before a meeting.

## Layout

| Path | What |
| --- | --- |
| `src-tauri/src/lib.rs` | Tauri commands, window setup, tray, global shortcut, alert window |
| `src-tauri/src/appbar.rs` | Win32 `SHAppBarMessage` docking and native hide/show |
| `src-tauri/src/store.rs` | `Item`/`Settings` persistence, task-marker parsing, archive, atomic writes, backups |
| `src-tauri/src/calendar.rs` | The shared `Meeting` type (ICS support was removed; Google only) |
| `src-tauri/src/google.rs` | Google OAuth (PKCE + loopback), Calendar read, event creation |
| `src-tauri/nsis/installer.nsi` | Custom NSIS installer template (see below) |
| `src/main.ts` | Sidebar: clock, meetings, add-event form, alert scheduler, settings |
| `src/outline.ts` | Notes/tasks outliner (any nesting depth, pre-order list) |
| `src/paste.ts` | Clipboard HTML/plain text → rows with nesting and Markdown markers |
| `src/images.ts` | Pasted images: `save_image` upload, `image_dir` + asset-protocol URLs for `renderInline` |
| `src/journal.ts`, `journal.html` | Journal window: timeline of days, one day's events/notes/completed/scheduled, search, restore/delete of archived rows |
| `src/text.ts` | `renderInline` (Markdown subset + links), `stripInline`, `dayKey` and other helpers shared by all windows |
| `src/schedule.ts` | Natural-language date/time parser (`parseSchedule`) and the shared marker parser |
| `src/capture.ts`, `src/tab.ts`, `src/alert.ts` | Capture popup, collapsed edge tab, alert overlay |
| `index.html`, `capture.html`, `tab.html`, `alert.html` | One page per window (Vite multi-page) |

Windows are declared in `src-tauri/tauri.conf.json`; every window label must
also be listed in `src-tauri/capabilities/default.json`.

## Working on it

- This is a **Windows** project in a PowerShell terminal. Give commands as
  `cd D:\deskpad; npm run tauri dev`, not Unix paths. Rust lives at
  `~/.cargo/bin`; in Git Bash export that onto `PATH` first.
- `npm run tauri dev` serves the frontend on port 1420 and rebuilds the Rust
  side on change. **Only one Deskpad can run at a time**: a second instance
  fights the first for the right edge and the Ctrl+Space shortcut. Quit the
  installed app from its tray icon before running dev, and vice versa.
- Checks: `cargo test` in `src-tauri` (marker parsing, store safety, archive), `npx tsc --noEmit -p .` and `npx vite build` at the root.
- UI changes can be exercised without the native app by opening
  `http://localhost:1420/` in a browser and installing a mock
  `window.__TAURI_INTERNALS__` whose `invoke` implements the commands the page
  calls. `alert.html` exposes `window.__alertShow(meeting)` for the same reason.
- Never send synthetic keyboard input to test the app; it lands in whatever
  window has focus. Synthetic mouse clicks on Deskpad's own window are fine.
- **Never start Deskpad, `npm run tauri dev`, or the installer from a shell
  that runs inside a packaged (MSIX) app**, such as the terminal embedded in
  the Claude desktop app. See "Packaged-app sandboxes" below. To launch from
  such a shell anyway, hand the exe to Explorer, which starts it outside the
  sandbox: `explorer.exe "D:\path\to\Deskpad_x.y.z_x64-setup.exe"`. Both
  the app and the installer refuse to run when they detect the sandbox.

## Packaged-app sandboxes (why data once "reverted")

A process that runs inside an MSIX-packaged app's process tree inherits that
package's identity, and Windows then redirects its `%APPDATA%`,
`%LOCALAPPDATA%` and Start Menu writes into
`%LOCALAPPDATA%\Packages\<package>\LocalCache\{Roaming,Local}`. Reads fall
through to the real folders until a file has been written there, after which
the private copy wins. Deskpad is not packaged, so this only happens when it
is launched from such a shell. The effects, all seen on 2026-10-31/11-01 after
the installer was run from the Claude desktop app's terminal:

- the installer put `deskpad.exe` and its uninstaller under
  `...\LocalCache\Local\Deskpad\` while the real `%LOCALAPPDATA%\Deskpad`
  stayed empty, and the Start Menu shortcut went to the redirected Start Menu;
- the relaunched app read and wrote `...\LocalCache\Roaming\com.jgentes.deskpad\`,
  a private fork of `tasks.json`, `archive.json` and `settings.json`;
- its autostart code wrote the *real* HKCU Run entry (that key is not
  redirected) pointing at the hidden exe, so the next sign-in launched that
  exe outside the sandbox, which read the real, now stale, data folder: the
  outline "reverted" to before the archive, and settings to older values.

Guards, keep them: `refuse_if_sandboxed` in `lib.rs` runs before anything is
loaded and exits with a message box, and the NSIS template's `.onInit` does
the same check and aborts. Both detect the sandbox behaviourally (write a
probe file, look for it under `Packages\*\LocalCache`), because a process in
this state reports no package identity (`GetCurrentPackageFullName` returns
APPMODEL_ERROR_NO_PACKAGE) even though its writes are redirected. If
you ever need to inspect the real folders from a sandboxed shell, a UNC path
(`\\localhost\C$\Users\<user>\AppData\...`) bypasses the redirection, and
`Invoke-CimMethod -ClassName StdRegProv` reads the real registry.

## Data safety rules (keep these intact)

User data lives in `%APPDATA%\com.jgentes.deskpad\` (`tasks.json`,
`archive.json`, `day_events.json`, `settings.json`, `google_tokens.json`,
`backups\`, `images\`). The installed app and the dev build share it.

1. **Register state before windows exist.** `Store` and `Google` are loaded in
   `run()` before `tauri::Builder` runs, because config windows are created
   before the `setup` hook and the webview can call commands in that gap.
2. **The frontend never saves before a successful load.** `outline.ts` sets
   `loaded` only after `list_items` succeeds; `flushSave` is a no-op before
   that. Startup loads retry instead of falling back to defaults.
3. **Writes are atomic** (`write_atomic`: temp file + rename), the outline gets
   a daily backup (`backup_daily`, newest 30 kept), and a file that fails to
   parse is moved aside as `*.corrupt-<timestamp>` rather than overwritten.
4. **Debug builds never touch autostart.** `apply_autostart` returns early
   under `cfg!(debug_assertions)`; otherwise the Run key ends up pointing at
   `target\debug\deskpad.exe`, which needs the Vite server. On every launch
   `sync_autostart_on_launch` makes the release build re-assert its Run entry
   when autostart is on, and makes a debug build delete a Run entry that
   points at a `target\debug` path (left behind by builds older than the
   guard). Keep both halves.

If you add a new persisted file, use `load_json` and `write_atomic`.

## Installer: one click, no prompts

`npm run tauri build` produces a single NSIS installer,
`src-tauri/target/release/bundle/nsis/Deskpad_<version>_x64-setup.exe`
(`bundle.targets` is `["nsis"]`; the MSI target was dropped on purpose).

Double-clicking it must install **without any interaction**: no wizard pages,
no "create desktop shortcut" or "launch app" checkboxes, no "app is running"
dialog. It closes a running Deskpad, copies the new build, and relaunches it.

This is done with `bundle.windows.nsis.template = "nsis/installer.nsi"`, a
copy of Tauri's stock template with four changes, all marked `; Deskpad:`:

- `.onInit` first probes for app-data redirection and aborts with a message
  box when the installer runs inside a packaged app's sandbox (see
  "Packaged-app sandboxes" above).

- `.onInit` unconditionally sets `$PassiveMode 1` (the stock template only
  does this for the `/P` flag). Passive mode skips every page via
  `SkipIfPassive`, and the `CheckIfAppIsRunning` macro kills the running app
  instead of prompting.
- `.onInit` also unconditionally sets `$UpdateMode 1`. Otherwise installing
  the same version takes the reinstall page's "uninstall first" branch (the
  page is skipped, so its choice variable is never set) and the previous
  uninstaller deletes the HKCU Run autostart entry. Update mode overwrites in
  place and preserves it.
- `.onInstSuccess` always relaunches the app with `nsis_tauri_utils::RunAsUser`
  (the stock template requires `/R`).

`installMode` is `currentUser`, so no UAC prompt either.

The relaunch races the shell: the old Deskpad is killed and the new one starts
at once, while Explorer still holds the dead window's AppBar strip, so the new
window gets docked one sidebar-width inboard. `appbar.rs` handles this: the
AppBar registers a callback message and the window is subclassed, so on
`ABN_POSCHANGED`, `WM_SETTINGCHANGE` or `WM_DISPLAYCHANGE` it re-docks whenever
it is not flush with the monitor's right edge (`needs_redock`), and
`schedule_redock_checks` in `lib.rs` sweeps a few times after launch in case the
shell drops the stale strip silently. Keep both when touching docking.

Waking from sleep displaces the window the same way: the display comes back in
steps and the shell moves AppBars after the first notification was answered
(and a second notification inside the 500 ms echo guard is ignored). So the
subclass also listens for `WM_POWERBROADCAST` resume and `WM_DPICHANGED`, and
every notification that is not an echo of our own dock starts a one-second
`SWEEP_TIMER` that re-checks for 12 ticks; a `SLOW_TIMER` re-checks every 20 s
as a last resort. Both skip while `STUCK` says a re-dock could not reach the
edge (another AppBar owns it). `redock_if_displaced` re-registers the AppBar
only when the strip is gone; while the shell still holds it, the window is
just moved back with `SetWindowPos`. A full re-registration in that state
makes the shell bounce the window inboard again within ~60 ms, and combined
with a sweep restarted by the echo that produced a sidebar flashing once a
second (seen 2026-11-04 after a wake).

**When bumping `@tauri-apps/cli`**, re-copy the template from the matching tag
(`crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi` at
`tauri-cli-v<version>`), re-apply the four marked changes, and keep the header
comment current. Then build and run the installer against a running Deskpad
and confirm: it exits within a few seconds, the only window is the progress
page, the old process is gone, a new one is running, and the `Deskpad` value
under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` still points at
the installed exe.

Bump `version` in `src-tauri/tauri.conf.json` for each release.

## Conventions

- Theme: `src/styles.css` defines every color as a token on `:root` (dark) and
  overrides them under `@media (prefers-color-scheme: light)`; WebView2 maps
  that query to the Windows app theme, and no window pins a `theme` in
  `tauri.conf.json`. Use the tokens (`--border`, `--hover`, `--shadow`, …);
  never write a literal color in a rule.
- Commands return `Result<_, String>` with user-readable messages; the
  frontend shows them verbatim.
- Frontend code relays `console.error` and uncaught errors to the backend via
  `log_js`, which prints `[js:<label>]` in the dev terminal. Check there first
  when something looks inert.
- Google: read scope `calendar.readonly` plus write scope `calendar.events`.
  Tokens record the granted scope; `can_write()` gates event creation and a
  read-only grant produces a "disconnect and reconnect" message.
- Alert timing lives in `main.ts` (`ALERT_LEAD` = 120 s, `ALERT_GRACE` = 300 s).
- Calendar windows are chosen by the frontend: `get_meetings(from, to)` takes
  unix seconds, and `main.ts` always keeps today + tomorrow loaded (`meetings`,
  which drives alerts) plus the browsed day (`dayMeetings`) when it is another
  one. `tomorrow_until_hour` replaced the old rolling look-ahead.
- Fold state (which parents are collapsed) is a view preference kept in
  `localStorage` (`deskpad.collapsed`), never in `tasks.json`.
- Rows nest to any depth through `parent`, and `tasks.json` is kept in
  pre-order (every row directly followed by its descendants). `normalize`
  (in both `outline.ts` and `store.rs`) re-establishes that after a load or a
  restore and makes orphans and cycle members top-level; `archive_items`
  takes all descendants. Nesting is drawn with the `--depth` custom property
  on `.row`, in the sidebar and the journal alike.
- Row text is plain with a Markdown subset (`**`, `*`/`_`, `~~`, backticks,
  `[label](url)`), rendered by `renderInline` while a row isn't being edited
  and shown raw while it is (`showLinked` keeps the raw text in `data-raw`,
  `plainText` restores it on focus). `parseClipboard` in `paste.ts` turns
  pasted HTML (lists → nesting, `li[role=checkbox]` → tasks, inline styles
  from Google Docs/Word → markers) or plain lines into rows; a one-line paste
  without markers is left to the browser. `strip_inline` in `store.rs` keeps
  markers out of calendar event titles.
- Pasted images are files, not data URLs: `onPaste` sends the clipboard file's
  bytes as the raw IPC body to `save_image` (extension in the `x-ext` header),
  which writes `images\<sha256 prefix>.<ext>` once (same bytes → same file)
  and returns the name; the row text gets `![](img:<name>)`. `renderInline`
  turns that into `<img class="pic">` whose `src` comes from the resolver
  `initImages` installs (`convertFileSrc` on `image_dir` + name, served by
  Tauri's asset protocol, enabled in `tauri.conf.json` with scope
  `$APPDATA/images/**` and the `protocol-asset` cargo feature). One file per
  image: `.row .txt img.pic { max-width: 100% }` scales it to the column, so
  no thumbnails exist. Nothing deletes image files when rows go; they are
  small and deduplicated. `strip_inline`/`stripInline` drop the marker.
- Days are the record, the outline is the workspace. A row's day is derived
  from `created_at` (local), `done_at` is set/cleared by the frontend when a
  task is toggled, and `schedule.start` places it on a day. The journal
  (`list_journal`) sees live and archived rows together; archiving only
  removes a row from the outline. The sidebar calls `record_day_events(day,
  meetings)` after every calendar load so `day_events.json` holds each day's
  events as last seen; the journal prefers a live `get_meetings` and falls
  back to that file (labelled "as recorded"). The journal window is created
  hidden and only ever hidden on close (`open_journal` shows it); `show_item`
  brings the sidebar back and focuses a row (`focus-item` event).
- Scheduling: only the frontend parses language (`src/schedule.ts`,
  `parseSchedule(text, now)`; it is pure, so test it with
  `node --experimental-strip-types` and a fixed `now`). The outline runs it
  when a row is committed (Enter, blur) and the capture popup on submit; the
  backend's `schedule_item(id, start, end, all_day)` creates or patches the
  Google event and stores `Item.schedule { start, end, all_day, event_id }`,
  `unschedule_item(id)` deletes the event and clears it. Both emit
  `items-changed` and `calendar-changed` (the sidebar reloads meetings on the
  latter). A failed create keeps the schedule locally with `event_id: null` so
  the typed time isn't lost; the badge shows it is off the calendar. Archiving
  or completing a scheduled task leaves its event alone.
