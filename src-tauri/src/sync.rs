//! Cloud sync (see `docs/sync-architecture.md`). The local files stay the
//! working copy and the app works offline; this module replicates them to the
//! Deskpad Worker and merges what other devices wrote.
//!
//! How it works, in one paragraph: `sync_state.json` remembers, per row, the
//! copy this device and the server last agreed on (`base`). A cycle compares
//! the store with `base` (so every way a row can change is covered, with no
//! hooks in the commands), stamps what differs with a hybrid clock and pushes
//! it, tombstones for vanished rows included. The server keeps the newer
//! write per row and answers with everything this device hasn't seen plus its
//! own copy of anything it refused; `apply_rows` folds that into the store
//! unless the row changed locally in the meantime, in which case the local
//! change stays and goes out on the next cycle.
//!
//! Nothing here runs until this PC is signed in: `cloud.json` then holds the
//! server address and a session token obtained through the device sign-in
//! flow (`begin_sign_in`, `finish_sign_in`), never typed by hand.

use crate::calendar::Meeting;
use crate::rank;
use crate::store::{load_json, normalize, write_atomic, ArchivedItem, Item, Schedule, Store};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Rows per request, either way (the server's `PAGE`).
const PAGE: usize = 2000;
const IMAGE_MAX_BYTES: u64 = 10 * 1024 * 1024;
/// How often to look for other devices' changes when nothing changed here.
const PULL_EVERY: Duration = Duration::from_secs(60);
const TICK: Duration = Duration::from_secs(2);

// ---------- wire types (mirror shared/protocol.ts) ----------

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct WireRow {
    pub id: String,
    pub text: String,
    pub kind: String,
    pub done: bool,
    pub parent: Option<String>,
    #[serde(default)]
    pub rank: String,
    pub created_at: i64,
    pub done_at: Option<i64>,
    pub schedule: Option<Schedule>,
    pub archived_at: Option<i64>,
    pub updated_at: i64,
    #[serde(default)]
    pub updated_by: String,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
}

impl WireRow {
    /// Same row content, whoever wrote it and whenever.
    fn content_eq(&self, o: &WireRow) -> bool {
        self.text == o.text
            && self.kind == o.kind
            && self.done == o.done
            && self.parent == o.parent
            && self.rank == o.rank
            && self.created_at == o.created_at
            && self.done_at == o.done_at
            && self.schedule == o.schedule
            && self.archived_at == o.archived_at
    }

    fn from_item(it: &Item, archived_at: Option<i64>) -> Self {
        WireRow {
            id: it.id.to_string(),
            text: it.text.clone(),
            kind: it.kind.clone(),
            done: it.done,
            parent: it.parent.map(|p| p.to_string()),
            rank: it.rank.clone(),
            created_at: it.created_at,
            done_at: it.done_at,
            schedule: it.schedule.clone(),
            archived_at,
            updated_at: 0,
            updated_by: String::new(),
            deleted: false,
            seq: None,
        }
    }

    /// `None` when the id isn't one this app can hold (a number below 2^53).
    fn to_item(&self) -> Option<Item> {
        Some(Item {
            id: self.id.parse().ok()?,
            text: self.text.clone(),
            kind: if self.kind == "task" { "task".into() } else { "note".into() },
            done: self.done,
            parent: self.parent.as_ref().and_then(|p| p.parse().ok()),
            created_at: self.created_at,
            done_at: self.done_at,
            schedule: self.schedule.clone(),
            rank: self.rank.clone(),
        })
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct WireDay {
    pub day: String,
    pub events: Vec<Meeting>,
    pub updated_at: i64,
    #[serde(default)]
    pub updated_by: String,
}

#[derive(Serialize)]
struct SyncRequest<'a> {
    since: i64,
    rows: &'a [WireRow],
    days: &'a [WireDay],
}

#[derive(Deserialize)]
struct SyncResponse {
    seq: i64,
    #[serde(default)]
    rows: Vec<WireRow>,
    #[serde(default)]
    days: Vec<WireDay>,
    #[serde(default)]
    more: bool,
}

// ---------- persisted state ----------

/// The Deskpad cloud this build signs in to unless told otherwise.
pub const DEFAULT_URL: &str = "https://app.deskpad.win";
/// Where the server lived before it had its own domain; a PC still pointing
/// there is moved to `DEFAULT_URL` the next time it signs in.
pub const RETIRED_URLS: &[&str] = &["https://deskpad-cloud.jgentes.workers.dev"];
/// How the Worker knows the device flow was started by the Windows app.
const CLIENT_ID: &str = "deskpad-desktop";

/// `cloud.json`: where to sync and as whom. Never synced, never logged.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CloudConfig {
    pub url: String,
    pub token: String,
}

impl CloudConfig {
    pub fn ready(&self) -> bool {
        (self.url.starts_with("https://") || self.url.starts_with("http://127.0.0.1") || self.url.starts_with("http://localhost")) && self.token.len() >= 32
    }

    fn base(&self) -> &str {
        self.url.trim_end_matches('/')
    }

    /// Identifies the server and account without storing the token again.
    fn fingerprint(&self) -> String {
        let mut h = DefaultHasher::new();
        self.base().hash(&mut h);
        self.token.hash(&mut h);
        format!("{:016x}", h.finish())
    }
}

/// `sync_state.json`: what this device and the server last agreed on.
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SyncState {
    /// This device's name as the server knows it (it comes from the session
    /// there, and is how our own writes are recognised when they come back).
    pub device: String,
    /// The signed-in account's email, for display.
    pub account: String,
    /// Fingerprint of the config the rest of this state belongs to.
    pub remote: String,
    /// Highest server change number applied.
    pub since: i64,
    /// Hybrid logical clock: never behind the wall clock or any stamp seen.
    pub hlc: i64,
    /// Per row, the copy last agreed with the server.
    pub base: BTreeMap<String, WireRow>,
    /// Local changes not yet acknowledged, stamped when first noticed so an
    /// edit made offline keeps its own time rather than the time it got out.
    pub pending: BTreeMap<String, WireRow>,
    /// Per day, a hash of the events last agreed with the server.
    pub days: BTreeMap<String, u64>,
    pub pending_days: BTreeMap<String, (u64, i64)>,
    /// Image files known to be on the server.
    pub uploaded: BTreeSet<String>,
}

impl SyncState {
    fn tick(&mut self, now_ms: i64) -> i64 {
        self.hlc = now_ms.max(self.hlc + 1);
        self.hlc
    }

    /// Forget everything agreed with a previous server or account.
    fn reset_for(&mut self, remote: String) {
        *self = SyncState { remote, ..Default::default() };
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ---------- the merge, as pure functions ----------

/// The store as wire rows, keyed by id. A row is in the outline or the archive.
pub fn local_rows(items: &[Item], archive: &[ArchivedItem]) -> BTreeMap<String, WireRow> {
    let mut map = BTreeMap::new();
    for a in archive {
        map.insert(a.item.id.to_string(), WireRow::from_item(&a.item, Some(a.archived_at)));
    }
    for it in items {
        map.insert(it.id.to_string(), WireRow::from_item(it, None));
    }
    map
}

/// What a cycle would push: every row that differs from `base`, and a
/// tombstone for every `base` row that is gone. Stamps are kept in `pending`.
/// Returns (rows to send, at most `PAGE`; how many of all pending changes are
/// deletions).
pub fn plan_rows(state: &mut SyncState, local: &BTreeMap<String, WireRow>, now_ms: i64) -> (Vec<WireRow>, usize) {
    let device = state.device.clone();
    let mut wanted: BTreeMap<String, WireRow> = BTreeMap::new();
    for (id, cur) in local {
        if state.base.get(id).is_some_and(|b| cur.content_eq(b)) {
            continue;
        }
        wanted.insert(id.clone(), cur.clone());
    }
    for (id, b) in &state.base {
        if !local.contains_key(id) {
            wanted.insert(id.clone(), WireRow { deleted: true, ..b.clone() });
        }
    }
    // Keep stamps of changes already noticed; stamp the new ones.
    let old = std::mem::take(&mut state.pending);
    for (id, mut row) in wanted {
        let kept = old.get(&id).filter(|p| p.deleted == row.deleted && p.content_eq(&row)).map(|p| p.updated_at);
        row.updated_at = kept.unwrap_or_else(|| state.tick(now_ms));
        row.updated_by = device.clone();
        row.seq = None;
        state.pending.insert(id, row);
    }
    let deletes = state.pending.values().filter(|r| r.deleted).count();
    // Oldest changes first, so a long backlog goes out in the order it happened.
    let mut rows: Vec<WireRow> = state.pending.values().cloned().collect();
    rows.sort_by_key(|r| r.updated_at);
    rows.truncate(PAGE);
    (rows, deletes)
}

/// Fold the server's answer into the store. `sent` is what this request
/// pushed. Returns whether the outline or the archive changed.
pub fn apply_rows(state: &mut SyncState, items: &mut Vec<Item>, archive: &mut Vec<ArchivedItem>, sent: &[WireRow], rows: Vec<WireRow>) -> bool {
    if rows.is_empty() {
        return false;
    }
    let me = state.device.clone();
    let sent: HashMap<&str, &WireRow> = sent.iter().map(|r| (r.id.as_str(), r)).collect();
    let mut local = local_rows(items, archive);
    let mut upserts: HashMap<u64, WireRow> = HashMap::new();
    let mut removes: HashSet<u64> = HashSet::new();

    for r in rows {
        state.hlc = state.hlc.max(r.updated_at);
        let id = r.id.clone();
        if r.updated_by == me {
            // The server holds something this device sent. Nothing to change
            // locally; if the row moved on since, the next plan sees it differ.
            if state.pending.get(&id).is_some_and(|p| p.updated_at == r.updated_at) {
                state.pending.remove(&id);
            }
            if r.deleted {
                state.base.remove(&id);
            } else {
                state.base.insert(id, r);
            }
            continue;
        }
        // Another device's write. It stands unless this row changed here
        // since the copy we last sent or agreed on.
        let cur = local.get(&id);
        let agreed = sent.get(id.as_str()).copied().or(state.base.get(&id));
        let untouched = match (cur, agreed) {
            (Some(c), Some(a)) => !a.deleted && c.content_eq(a),
            (None, Some(a)) => a.deleted,
            // No history with the server for this row (a first sync): its copy wins.
            (_, None) => true,
        };
        state.pending.remove(&id);
        if untouched {
            match (r.deleted, r.id.parse::<u64>()) {
                (_, Err(_)) => eprintln!("[sync] skipping row with an id this app can't hold"),
                (true, Ok(n)) => {
                    if local.remove(&id).is_some() {
                        removes.insert(n);
                        upserts.remove(&n);
                    }
                }
                (false, Ok(n)) => {
                    if !cur.is_some_and(|c| c.content_eq(&r)) {
                        local.insert(id.clone(), r.clone());
                        removes.remove(&n);
                        upserts.insert(n, r.clone());
                    }
                }
            }
        }
        // Either way the server's copy is the new common ground. When the
        // local change was kept, it differs from this and goes out next, with
        // a stamp past `r.updated_at` because the clock just moved up to it.
        if r.deleted {
            state.base.remove(&id);
        } else {
            state.base.insert(id, r);
        }
    }

    if upserts.is_empty() && removes.is_empty() {
        return false;
    }
    items.retain(|i| !removes.contains(&i.id) && !upserts.contains_key(&i.id));
    archive.retain(|a| !removes.contains(&a.item.id) && !upserts.contains_key(&a.item.id));
    for row in upserts.into_values() {
        let Some(item) = row.to_item() else { continue };
        match row.archived_at {
            Some(archived_at) => archive.push(ArchivedItem { item, archived_at }),
            None => items.push(item),
        }
    }
    // Other devices decide order through ranks; the list follows them.
    rank::sort_siblings(items);
    normalize(items);
    true
}

fn events_hash(events: &[Meeting]) -> u64 {
    let mut h = DefaultHasher::new();
    serde_json::to_string(events).unwrap_or_default().hash(&mut h);
    h.finish()
}

/// Days whose events differ from what the server last agreed to.
pub fn plan_days(state: &mut SyncState, local: &BTreeMap<String, Vec<Meeting>>, now_ms: i64) -> Vec<WireDay> {
    let device = state.device.clone();
    let mut out = Vec::new();
    let old = std::mem::take(&mut state.pending_days);
    for (day, events) in local {
        let hash = events_hash(events);
        if state.days.get(day) == Some(&hash) {
            continue;
        }
        let stamp = old.get(day).filter(|(h, _)| *h == hash).map(|(_, s)| *s).unwrap_or_else(|| state.tick(now_ms));
        state.pending_days.insert(day.clone(), (hash, stamp));
        if out.len() < PAGE {
            out.push(WireDay { day: day.clone(), events: events.clone(), updated_at: stamp, updated_by: device.clone() });
        }
    }
    out
}

/// Returns whether any day changed locally.
pub fn apply_days(state: &mut SyncState, local: &mut BTreeMap<String, Vec<Meeting>>, days: Vec<WireDay>) -> bool {
    let me = state.device.clone();
    let mut changed = false;
    for d in days {
        state.hlc = state.hlc.max(d.updated_at);
        let hash = events_hash(&d.events);
        if d.updated_by != me {
            let cur = local.get(&d.day).map(|e| events_hash(e));
            // Take another device's copy unless this one recorded the day
            // differently since the last agreement; then ours stays, differs
            // from the new common ground below, and goes out next.
            let untouched = cur.is_none() || cur == state.days.get(&d.day).copied();
            if untouched && cur != Some(hash) {
                local.insert(d.day.clone(), d.events);
                changed = true;
            }
        }
        state.pending_days.remove(&d.day);
        state.days.insert(d.day, hash);
    }
    changed
}

/// Image names (`<20 hex>.<ext>`) referenced by `![](img:…)` markers.
pub fn image_refs<'a>(texts: impl Iterator<Item = &'a str>) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for text in texts {
        let mut rest = text;
        while let Some(at) = rest.find("](img:") {
            rest = &rest[at + 6..];
            let name: String = rest.chars().take_while(|c| *c != ')').collect();
            if valid_image_name(&name) {
                out.insert(name);
            }
        }
    }
    out
}

pub fn valid_image_name(name: &str) -> bool {
    let Some((stem, ext)) = name.split_once('.') else { return false };
    stem.len() == 20
        && stem.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        && (1..=5).contains(&ext.len())
        && ext.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

// ---------- shared with the commands ----------

#[derive(Clone, Default, Serialize)]
pub struct CloudStatus {
    pub configured: bool,
    pub url: String,
    pub device: String,
    /// The signed-in account's email, once the server has told us.
    pub account: String,
    /// Set while a sign-in waits for approval in the browser: the code to compare.
    pub signing_in: Option<String>,
    /// Whether the account lets Deskpad read the calendar; `None` until asked.
    pub calendar: Option<bool>,
    /// Unix seconds of the last cycle that completed.
    pub last_sync: Option<i64>,
    pub error: Option<String>,
    /// Rows the server and this device agree on.
    pub rows: usize,
    /// Set when a cycle stopped because most rows vanished locally.
    pub mass_delete: Option<usize>,
}

/// Managed state: the config and status the commands read, and the flags they
/// set. The sync state itself belongs to the loop alone.
pub struct Cloud {
    pub config: Mutex<CloudConfig>,
    pub status: Mutex<CloudStatus>,
    /// Run a cycle now.
    pub kick: AtomicBool,
    /// Let the next cycle push a mass deletion.
    pub allow_mass_delete: AtomicBool,
    /// Abandon the sign-in that is waiting for approval.
    pub cancel_sign_in: AtomicBool,
    dir: PathBuf,
}

impl Cloud {
    pub fn load(dir: &Path) -> Self {
        let config: CloudConfig = load_json(&dir.join("cloud.json")).unwrap_or_default();
        Cloud {
            status: Mutex::new(CloudStatus { configured: config.ready(), url: config.url.clone(), ..Default::default() }),
            config: Mutex::new(config),
            kick: AtomicBool::new(false),
            allow_mass_delete: AtomicBool::new(false),
            cancel_sign_in: AtomicBool::new(false),
            dir: dir.to_path_buf(),
        }
    }

    pub fn set_config(&self, config: CloudConfig) {
        if let Ok(json) = serde_json::to_string_pretty(&config) {
            write_atomic(&self.dir.join("cloud.json"), &json);
        }
        {
            let mut s = self.status.lock().unwrap();
            s.configured = config.ready();
            s.url = config.url.clone();
            s.error = None;
            s.mass_delete = None;
            s.signing_in = None;
            s.last_sync = None;
            s.calendar = None;
            if !s.configured {
                s.account.clear();
            }
        }
        *self.config.lock().unwrap() = config;
        self.kick.store(true, Ordering::Relaxed);
    }
}

enum CycleError {
    /// More than half of the agreed rows are gone locally; refuse to delete them remotely unasked.
    MassDelete(usize),
    Other(String),
}

impl From<String> for CycleError {
    fn from(s: String) -> Self {
        CycleError::Other(s)
    }
}

fn save_state(dir: &Path, state: &SyncState) {
    if let Ok(json) = serde_json::to_string(state) {
        write_atomic(&dir.join("sync_state.json"), &json);
    }
}

async fn post_sync(client: &reqwest::Client, cfg: &CloudConfig, since: i64, rows: &[WireRow], days: &[WireDay]) -> Result<SyncResponse, String> {
    let res = client
        .post(format!("{}/api/v1/sync", cfg.base()))
        .bearer_auth(&cfg.token)
        .json(&SyncRequest { since, rows, days })
        .send()
        .await
        .map_err(|e| format!("Could not reach the sync server: {}", e.without_url()))?;
    match res.status().as_u16() {
        200 => res.json().await.map_err(|e| format!("The sync server sent something unexpected: {e}")),
        401 => Err(SIGNED_OUT.into()),
        code => Err(format!("The sync server answered {code}.")),
    }
}

/// A device sign-in in progress (RFC 8628): the page to open, the code the
/// user compares there, and what to poll with.
#[derive(Deserialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri_complete: String,
    #[serde(default)]
    pub interval: u64,
    #[serde(default)]
    pub expires_in: u64,
}

fn auth_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(Duration::from_secs(20)).user_agent("Deskpad").build().map_err(|e| e.to_string())
}

/// Start a sign-in: ask the server for a device code.
pub async fn begin_sign_in(url: &str) -> Result<DeviceCode, String> {
    let res = auth_client()?
        .post(format!("{url}/api/auth/device/code"))
        .header("origin", url)
        .json(&serde_json::json!({ "client_id": CLIENT_ID }))
        .send()
        .await
        .map_err(|e| format!("Could not reach the Deskpad server: {}", e.without_url()))?;
    if !res.status().is_success() {
        return Err(format!("The Deskpad server refused to start a sign-in ({}).", res.status().as_u16()));
    }
    let code: DeviceCode = res.json().await.map_err(|e| format!("The Deskpad server sent something unexpected: {e}"))?;
    // The page to open must be on the server we asked, whatever the answer says.
    if !code.verification_uri_complete.starts_with(&format!("{url}/")) {
        return Err("The Deskpad server sent a sign-in page on another site.".into());
    }
    Ok(code)
}

/// Wait for the user to approve in the browser; returns this device's session token.
pub async fn finish_sign_in(url: &str, code: &DeviceCode, cancel: &AtomicBool) -> Result<String, String> {
    #[derive(Deserialize)]
    struct Answer {
        access_token: Option<String>,
        error: Option<String>,
    }
    let client = auth_client()?;
    let mut interval = code.interval.clamp(2, 30);
    let deadline = Instant::now() + Duration::from_secs(code.expires_in.clamp(60, 1800));
    while Instant::now() < deadline {
        for _ in 0..interval * 4 {
            if cancel.load(Ordering::Relaxed) {
                return Err("Sign-in cancelled.".into());
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let res = match client
            .post(format!("{url}/api/auth/device/token"))
            .header("origin", url)
            .json(&serde_json::json!({ "grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": code.device_code, "client_id": CLIENT_ID }))
            .send()
            .await
        {
            Ok(r) => r,
            // A dropped connection while waiting is not the end of the sign-in.
            Err(_) => continue,
        };
        let answer: Answer = res.json().await.unwrap_or(Answer { access_token: None, error: Some("server_error".into()) });
        if let Some(token) = answer.access_token.filter(|t| t.len() >= 32) {
            return Ok(token);
        }
        match answer.error.as_deref() {
            Some("authorization_pending") => {}
            Some("slow_down") => interval = (interval + 5).min(30),
            Some("access_denied") => return Err("The sign-in was cancelled in the browser.".into()),
            Some("expired_token") => return Err("The sign-in took too long. Try again.".into()),
            _ => return Err("The Deskpad server could not complete the sign-in.".into()),
        }
    }
    Err("The sign-in took too long. Try again.".into())
}

/// What the account's Google grant allows, and a token to use it with.
#[derive(Deserialize)]
pub struct GoogleAccess {
    pub access_token: String,
    pub expires_at: i64,
    #[serde(default)]
    pub calendar_read: bool,
    #[serde(default)]
    pub calendar_write: bool,
}

/// Ask the server for a current Google access token for this account.
/// `Ok(None)` means the account has no Google access (or is signed out).
pub async fn google_access(cfg: &CloudConfig) -> Result<Option<GoogleAccess>, String> {
    let res = auth_client()?
        .get(format!("{}/api/v1/google-token", cfg.base()))
        .bearer_auth(&cfg.token)
        .send()
        .await
        .map_err(|e| format!("Could not reach the Deskpad server: {}", e.without_url()))?;
    match res.status().as_u16() {
        200 => Ok(Some(res.json().await.map_err(|e| format!("The Deskpad server sent something unexpected: {e}"))?)),
        401 | 404 => Ok(None),
        code => Err(format!("The Deskpad server answered {code}.")),
    }
}

/// End this device's session on the server (best effort).
pub async fn sign_out(cfg: &CloudConfig) {
    if let Ok(client) = auth_client() {
        let _ = client.post(format!("{}/api/auth/sign-out", cfg.base())).header("origin", cfg.base()).bearer_auth(&cfg.token).json(&serde_json::json!({})).send().await;
    }
}

/// Ask the server who this session is: (device, account email).
async fn whoami(client: &reqwest::Client, cfg: &CloudConfig) -> Result<(String, String), String> {
    #[derive(Deserialize)]
    struct Status {
        device: String,
        #[serde(default)]
        account: Option<String>,
    }
    let res = client
        .get(format!("{}/api/v1/status", cfg.base()))
        .bearer_auth(&cfg.token)
        .send()
        .await
        .map_err(|e| format!("Could not reach the sync server: {}", e.without_url()))?;
    match res.status().as_u16() {
        200 => {
            let s = res.json::<Status>().await.map_err(|e| format!("The sync server sent something unexpected: {e}"))?;
            Ok((s.device, s.account.unwrap_or_default()))
        }
        401 => Err(SIGNED_OUT.into()),
        code => Err(format!("The sync server answered {code}.")),
    }
}

/// What a 401 means to the user.
const SIGNED_OUT: &str = "This PC is no longer signed in. Sign in again to keep syncing.";

/// One full exchange: push what changed, pull what's new, until both are
/// done, then the pictures. Returns whether the windows should reload.
async fn cycle(store: &Store, client: &reqwest::Client, cfg: &CloudConfig, state: &mut SyncState, allow_mass_delete: bool) -> Result<bool, CycleError> {
    if state.remote != cfg.fingerprint() {
        state.reset_for(cfg.fingerprint());
    }
    if state.device.is_empty() {
        (state.device, state.account) = whoami(client, cfg).await?;
    }
    // A device with no history pulls before it pushes, so rows both sides
    // hold settle on the server's copy instead of being overwritten by ours.
    let mut pull_only = state.since == 0 && state.base.is_empty();
    let mut outline_changed = false;

    for _ in 0..200 {
        let (rows, days) = if pull_only {
            (Vec::new(), Vec::new())
        } else {
            let local = {
                let items = store.items.lock().unwrap();
                let archive = store.archive.lock().unwrap();
                local_rows(&items, &archive)
            };
            let (rows, deletes) = plan_rows(state, &local, now_ms());
            if deletes > 20 && deletes * 2 > state.base.len() && !allow_mass_delete {
                save_state(&store.dir, state);
                return Err(CycleError::MassDelete(deletes));
            }
            let days = plan_days(state, &store.day_events.lock().unwrap(), now_ms());
            (rows, days)
        };
        // Stamps are on disk before anything leaves, so a crash can't re-date them.
        save_state(&store.dir, state);

        let resp = post_sync(client, cfg, state.since, &rows, &days).await?;

        let changed = {
            let mut items = store.items.lock().unwrap();
            let mut archive = store.archive.lock().unwrap();
            apply_rows(state, &mut items, &mut archive, &rows, resp.rows)
        };
        let days_changed = apply_days(state, &mut store.day_events.lock().unwrap(), resp.days);
        state.since = state.since.max(resp.seq);
        // The store first, then the state: after a crash in between, the rows
        // just applied look like local changes and are merely pushed again.
        if changed {
            store.save_items();
            store.save_archive();
            outline_changed = true;
        }
        if days_changed {
            store.save_day_events();
        }
        save_state(&store.dir, state);

        if resp.more {
            continue;
        }
        if pull_only {
            pull_only = false;
            continue;
        }
        if rows.len() < PAGE && days.len() < PAGE {
            break;
        }
    }

    // Pictures that were missing can render once they are here.
    let downloaded = sync_images(store, client, cfg, state).await?;
    save_state(&store.dir, state);
    Ok(outline_changed || downloaded)
}

/// Upload image files the server lacks and fetch referenced ones missing here.
/// Returns whether any file was downloaded.
async fn sync_images(store: &Store, client: &reqwest::Client, cfg: &CloudConfig, state: &mut SyncState) -> Result<bool, String> {
    let dir = store.dir.join("images");
    let on_disk: BTreeSet<String> = std::fs::read_dir(&dir)
        .map(|rd| rd.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| valid_image_name(n)).collect())
        .unwrap_or_default();

    for name in on_disk.difference(&state.uploaded.clone()) {
        let path = dir.join(name);
        if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > IMAGE_MAX_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let res = client
            .put(format!("{}/api/v1/images/{name}", cfg.base()))
            .bearer_auth(&cfg.token)
            .body(bytes)
            .send()
            .await
            .map_err(|e| format!("Could not upload a picture: {}", e.without_url()))?;
        match res.status().as_u16() {
            // 400/413/415: the server will never take this file; don't offer it again.
            200 | 400 | 413 | 415 => {
                state.uploaded.insert(name.clone());
            }
            401 => return Err(SIGNED_OUT.into()),
            code => return Err(format!("The sync server answered {code} to a picture upload.")),
        }
    }

    let wanted = {
        let items = store.items.lock().unwrap();
        let archive = store.archive.lock().unwrap();
        image_refs(items.iter().map(|i| i.text.as_str()).chain(archive.iter().map(|a| a.item.text.as_str())))
    };
    let mut downloaded = false;
    for name in wanted.difference(&on_disk) {
        let res = client
            .get(format!("{}/api/v1/images/{name}", cfg.base()))
            .bearer_auth(&cfg.token)
            .send()
            .await
            .map_err(|e| format!("Could not download a picture: {}", e.without_url()))?;
        if res.status().as_u16() != 200 {
            // Not uploaded by its device yet (or gone); try again on a later cycle.
            continue;
        }
        let bytes = res.bytes().await.map_err(|e| format!("Could not download a picture: {e}"))?;
        if bytes.is_empty() || bytes.len() as u64 > IMAGE_MAX_BYTES {
            continue;
        }
        std::fs::create_dir_all(&dir).ok();
        let tmp = dir.join(format!("{name}.tmp"));
        if std::fs::write(&tmp, &bytes).and_then(|_| std::fs::rename(&tmp, dir.join(name))).is_ok() {
            state.uploaded.insert(name.clone());
            downloaded = true;
        }
    }
    Ok(downloaded)
}

/// The sync loop. Spawned once at startup; idles until `cloud.json` is set.
pub async fn run(app: AppHandle) {
    let dir = app.state::<Store>().dir.clone();
    let mut state: SyncState = load_json(&dir.join("sync_state.json")).unwrap_or_default();
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(30)).user_agent("Deskpad").build() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[sync] no http client: {e}");
            return;
        }
    };
    let mut synced_version = 0u64;
    let mut seen_version = 0u64;
    let mut last_run: Option<Instant> = None;
    let mut backoff = Duration::ZERO;

    loop {
        tokio::time::sleep(TICK).await;
        let cloud = app.state::<Cloud>();
        let cfg = cloud.config.lock().unwrap().clone();
        if !cfg.ready() {
            continue;
        }
        let version = app.state::<Store>().version.load(Ordering::Relaxed);
        let kicked = cloud.kick.swap(false, Ordering::Relaxed);
        // Push once edits have paused for a tick; pull on a timer.
        let settled = version != synced_version && version == seen_version;
        seen_version = version;
        let timer = last_run.is_none_or(|t| t.elapsed() >= PULL_EVERY + backoff);
        if !(kicked || (settled && backoff.is_zero()) || timer) {
            continue;
        }

        let allow = cloud.allow_mass_delete.swap(false, Ordering::Relaxed);
        let result = cycle(&app.state::<Store>(), &client, &cfg, &mut state, allow).await;
        if matches!(result, Ok(true)) {
            app.emit("items-changed", ()).ok();
        }
        synced_version = app.state::<Store>().version.load(Ordering::Relaxed);
        seen_version = synced_version;
        last_run = Some(Instant::now());

        let mut status = cloud.status.lock().unwrap();
        status.configured = true;
        status.url = cfg.url.clone();
        status.device = state.device.clone();
        status.account = state.account.clone();
        status.rows = state.base.len();
        match result {
            Ok(_) => {
                status.last_sync = Some(chrono::Utc::now().timestamp());
                status.error = None;
                status.mass_delete = None;
                backoff = Duration::ZERO;
            }
            Err(CycleError::MassDelete(n)) => {
                status.mass_delete = Some(n);
                status.error = Some(format!("Sync is paused: {n} rows that were synced are no longer on this PC. Nothing was deleted in the cloud."));
                backoff = Duration::from_secs(600);
            }
            Err(CycleError::Other(e)) => {
                eprintln!("[sync] {e}");
                let signed_out = e == SIGNED_OUT;
                status.error = Some(e);
                backoff = (backoff * 2).clamp(Duration::from_secs(30), Duration::from_secs(600));
                if signed_out {
                    // The session is gone (signed out elsewhere, or expired). Drop the
                    // dead token so Settings offers "Sign in" again, and say why.
                    drop(status);
                    cloud.set_config(CloudConfig { url: cfg.url.clone(), token: String::new() });
                    status = cloud.status.lock().unwrap();
                    status.error = Some(SIGNED_OUT.into());
                    backoff = Duration::ZERO;
                }
            }
        }
        drop(status);
        app.emit("cloud-status", ()).ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The server's merge rule, as in cloud/src/tenant-do.ts.
    #[derive(Default)]
    struct Server {
        rows: BTreeMap<String, WireRow>,
        seq: i64,
    }

    impl Server {
        fn sync(&mut self, since: i64, sent: &[WireRow]) -> (i64, Vec<WireRow>) {
            let mut refused = Vec::new();
            for r in sent {
                if let Some(cur) = self.rows.get(&r.id) {
                    let newer = r.updated_at > cur.updated_at || (r.updated_at == cur.updated_at && r.updated_by > cur.updated_by);
                    if !newer {
                        if cur.seq.unwrap() <= since {
                            refused.push(cur.clone());
                        }
                        continue;
                    }
                }
                self.seq += 1;
                self.rows.insert(r.id.clone(), WireRow { seq: Some(self.seq), ..r.clone() });
            }
            let mut out: Vec<WireRow> = self.rows.values().filter(|r| r.seq.unwrap() > since).cloned().collect();
            out.sort_by_key(|r| r.seq);
            out.extend(refused);
            (self.seq, out)
        }
    }

    struct Device {
        state: SyncState,
        items: Vec<Item>,
        archive: Vec<ArchivedItem>,
        clock: i64,
    }

    impl Device {
        fn new(name: &str, clock: i64) -> Self {
            Device { state: SyncState { device: name.into(), ..Default::default() }, items: Vec::new(), archive: Vec::new(), clock }
        }

        fn add(&mut self, id: u64, text: &str, parent: Option<u64>) {
            self.items.push(Item { id, text: text.into(), kind: "note".into(), done: false, parent, created_at: 1, done_at: None, schedule: None, rank: String::new() });
            self.saved();
        }

        /// What `save_items` does to the list.
        fn saved(&mut self) {
            normalize(&mut self.items);
            rank::repair(&mut self.items);
        }

        fn edit(&mut self, id: u64, text: &str) {
            self.items.iter_mut().find(|i| i.id == id).unwrap().text = text.into();
        }

        /// One cycle against the server, as `cycle` does it. Returns whether the store changed.
        fn sync(&mut self, server: &mut Server) -> bool {
            self.clock += 1000;
            let mut changed = false;
            if self.state.since == 0 && self.state.base.is_empty() {
                let (seq, rows) = server.sync(0, &[]);
                changed |= apply_rows(&mut self.state, &mut self.items, &mut self.archive, &[], rows);
                self.state.since = seq;
            }
            let local = local_rows(&self.items, &self.archive);
            let (sent, _) = plan_rows(&mut self.state, &local, self.clock);
            let (seq, rows) = server.sync(self.state.since, &sent);
            changed |= apply_rows(&mut self.state, &mut self.items, &mut self.archive, &sent, rows);
            self.state.since = seq;
            if changed {
                self.saved();
            }
            changed
        }

        fn view(&self) -> Vec<(u64, String, Option<u64>)> {
            self.items.iter().map(|i| (i.id, i.text.clone(), i.parent)).collect()
        }
    }

    #[test]
    fn two_devices_converge() {
        let mut server = Server::default();
        let mut a = Device::new("a", 1_000_000);
        let mut b = Device::new("b", 1_000_500);
        a.add(1, "one", None);
        a.add(2, "two", None);
        a.add(3, "child of one", Some(1));
        assert!(!a.sync(&mut server), "a first push changes nothing locally");
        assert!(b.sync(&mut server), "a fresh device pulls everything");
        assert_eq!(a.view(), b.view());
        assert_eq!(b.view(), vec![(1, "one".into(), None), (3, "child of one".into(), Some(1)), (2, "two".into(), None)]);

        // Edits on different rows merge.
        a.edit(1, "one, by a");
        b.edit(2, "two, by b");
        a.sync(&mut server);
        b.sync(&mut server);
        a.sync(&mut server);
        assert_eq!(a.view(), b.view());
        assert_eq!(a.view()[0].1, "one, by a");
        assert_eq!(a.view()[2].1, "two, by b");

        // Nothing left to say: no pending changes, and a further cycle sends nothing.
        assert!(a.state.pending.is_empty() && b.state.pending.is_empty());
        let before = server.seq;
        a.sync(&mut server);
        b.sync(&mut server);
        assert_eq!(server.seq, before, "idle cycles write nothing");
    }

    #[test]
    fn the_later_edit_of_one_row_wins_on_both_sides() {
        let mut server = Server::default();
        let mut a = Device::new("a", 1_000_000);
        let mut b = Device::new("b", 1_000_000);
        a.add(1, "one", None);
        a.sync(&mut server);
        b.sync(&mut server);

        a.edit(1, "a's version");
        b.clock += 60_000; // b edits a minute later
        b.edit(1, "b's later version");
        b.sync(&mut server);
        a.sync(&mut server); // a's push is refused; the server's copy comes back
        assert_eq!(a.view()[0].1, "b's later version");
        b.sync(&mut server);
        assert_eq!(b.view()[0].1, "b's later version");
        assert!(a.state.pending.is_empty());
    }

    #[test]
    fn deletes_archives_and_moves_travel() {
        let mut server = Server::default();
        let mut a = Device::new("a", 1_000_000);
        let mut b = Device::new("b", 1_000_000);
        for (id, text) in [(1, "one"), (2, "two"), (3, "three")] {
            a.add(id, text, None);
        }
        a.sync(&mut server);
        b.sync(&mut server);

        // a deletes 2 and archives 3; b moves 3 to the top at the same time, a moment earlier.
        b.clock -= 500;
        let three = b.items.pop().unwrap();
        b.items.insert(0, three);
        b.saved();
        b.sync(&mut server);
        a.items.retain(|i| i.id != 2);
        let three = a.items.pop().unwrap();
        a.archive.push(ArchivedItem { item: three, archived_at: 99 });
        a.sync(&mut server);
        b.sync(&mut server);
        assert_eq!(a.view(), vec![(1, "one".into(), None)]);
        assert_eq!(b.view(), a.view(), "the delete and the later archive both arrive");
        assert_eq!(b.archive.len(), 1);
        assert_eq!(b.archive[0].archived_at, 99);

        // An order change alone travels too.
        a.add(4, "four", None);
        a.add(5, "five", None);
        a.sync(&mut server);
        b.sync(&mut server);
        let five = b.items.pop().unwrap();
        b.items.insert(0, five);
        b.saved();
        b.sync(&mut server);
        a.sync(&mut server);
        assert_eq!(a.view().iter().map(|v| v.0).collect::<Vec<_>>(), vec![5, 1, 4]);
        assert_eq!(a.view(), b.view());
    }

    #[test]
    fn a_local_edit_made_during_the_round_trip_is_kept_and_sent_next() {
        let mut server = Server::default();
        let mut a = Device::new("a", 1_000_000);
        let mut b = Device::new("b", 1_000_000);
        a.add(1, "one", None);
        a.sync(&mut server);
        b.sync(&mut server);
        b.edit(1, "from b");
        b.sync(&mut server);

        // a plans (nothing to send), the request is in flight, and the user types.
        let local = local_rows(&a.items, &a.archive);
        let (sent, _) = plan_rows(&mut a.state, &local, a.clock + 5000);
        assert!(sent.is_empty());
        let (seq, rows) = server.sync(a.state.since, &sent);
        a.edit(1, "typed on a meanwhile");
        let changed = apply_rows(&mut a.state, &mut a.items, &mut a.archive, &sent, rows);
        a.state.since = seq;
        assert!(!changed, "the row being typed in is left alone");
        assert_eq!(a.view()[0].1, "typed on a meanwhile");
        a.clock += 10_000;
        a.sync(&mut server);
        b.sync(&mut server);
        assert_eq!(b.view()[0].1, "typed on a meanwhile");
    }

    #[test]
    fn an_offline_edit_keeps_the_time_it_was_made() {
        let mut state = SyncState { device: "a".into(), ..Default::default() };
        let item = Item { id: 1, text: "x".into(), kind: "note".into(), done: false, parent: None, created_at: 1, done_at: None, schedule: None, rank: "V".into() };
        let local = local_rows(&[item], &[]);
        let (first, _) = plan_rows(&mut state, &local, 1_000);
        // The push failed; hours later the same change is planned again.
        let (again, _) = plan_rows(&mut state, &local, 9_000_000);
        assert_eq!(first[0].updated_at, again[0].updated_at);
    }

    #[test]
    fn a_wiped_store_is_noticed_before_anything_is_deleted() {
        let mut server = Server::default();
        let mut a = Device::new("a", 1_000_000);
        for id in 1..=40 {
            a.add(id, "row", None);
        }
        a.sync(&mut server);
        a.items.clear(); // tasks.json lost
        let (_, deletes) = plan_rows(&mut a.state, &local_rows(&a.items, &a.archive), a.clock);
        assert_eq!(deletes, 40);
        assert!(deletes > 20 && deletes * 2 > a.state.base.len(), "the cycle's guard trips");
    }

    /// The real engine against a real Worker. Needs `wrangler dev` running in
    /// cloud/ with two tokens of one tenant; run it with `npm run test:desktop` in cloud/.
    #[test]
    #[ignore]
    fn engine_against_a_local_worker() {
        let url = std::env::var("DESKPAD_SYNC_URL").expect("DESKPAD_SYNC_URL");
        let cfg = |t: &str| CloudConfig { url: url.clone(), token: std::env::var(t).expect(t) };
        let (ca, cb) = (cfg("DESKPAD_SYNC_TOKEN_A"), cfg("DESKPAD_SYNC_TOKEN_B"));
        let tmp = std::env::temp_dir().join(format!("deskpad-sync-e2e-{}", std::process::id()));
        let (a, b) = (Store::load(tmp.join("a")), Store::load(tmp.join("b")));
        let (mut sa, mut sb) = (SyncState::default(), SyncState::default());
        let client = reqwest::Client::new();
        let run = |store: &Store, cfg: &CloudConfig, state: &mut SyncState| {
            tauri::async_runtime::block_on(cycle(store, &client, cfg, state, false)).map_err(|e| match e {
                CycleError::Other(s) => s,
                CycleError::MassDelete(n) => format!("mass delete {n}"),
            })
        };
        let row = |id: u64, text: &str, parent: Option<u64>| Item { id, text: text.into(), kind: "task".into(), done: false, parent, created_at: 5, done_at: None, schedule: Some(Schedule { start: 10, end: 20, all_day: false, event_id: Some("ev".into()) }), rank: String::new() };

        // A picture on device a, referenced by a row.
        let png = b"not really a PNG, but hashed like one";
        let name = {
            use sha2::Digest;
            format!("{}.png", sha2::Sha256::digest(png).iter().take(10).map(|b| format!("{b:02x}")).collect::<String>())
        };
        std::fs::create_dir_all(a.dir.join("images")).unwrap();
        std::fs::write(a.dir.join("images").join(&name), png).unwrap();
        *a.items.lock().unwrap() = vec![row(1, "one", None), row(2, &format!("pic ![](img:{name})"), Some(1)), row(3, "three", None)];
        a.save_items();
        a.archive_items(&[3]);
        a.save_items();
        a.save_archive();
        a.record_day_events("2026-11-09", vec![Meeting { id: "m".into(), title: "Standup".into(), start: 1, end: 2, all_day: false, location: None, url: Some("https://x".into()) }]);

        assert_eq!(run(&a, &ca, &mut sa), Ok(false));
        assert!(!sa.device.is_empty() && sa.pending.is_empty() && sa.base.len() == 3);
        assert_eq!(run(&b, &cb, &mut sb), Ok(true), "b pulls rows and the picture");
        let view = |s: &Store| s.items.lock().unwrap().iter().map(|i| (i.id, i.text.clone(), i.parent, i.kind.clone(), i.schedule.clone(), i.rank.clone())).collect::<Vec<_>>();
        assert_eq!(view(&a), view(&b));
        assert_eq!(b.archive.lock().unwrap().len(), 1);
        assert_eq!(b.day_events.lock().unwrap().get("2026-11-09").map(|v| v[0].title.clone()), Some("Standup".to_string()));
        assert_eq!(std::fs::read(b.dir.join("images").join(&name)).unwrap(), png);

        // b edits and deletes; a picks both up.
        b.items.lock().unwrap()[0].text = "one, edited on b".into();
        b.items.lock().unwrap().retain(|i| i.id != 2);
        b.save_items();
        assert_eq!(run(&b, &cb, &mut sb), Ok(false));
        assert_eq!(run(&a, &ca, &mut sa), Ok(true));
        assert_eq!(view(&a).iter().map(|v| (v.0, v.1.clone())).collect::<Vec<_>>(), vec![(1, "one, edited on b".to_string())]);
        assert_eq!(run(&a, &ca, &mut sa), Ok(false), "and then there is nothing left to do");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn image_names_are_found_and_checked() {
        let refs = image_refs(["see ![](img:0123456789abcdef0123.png) and ![x](img:../../etc.png) ![](img:0123456789abcdef0123.png)", "none"].into_iter());
        assert_eq!(refs.into_iter().collect::<Vec<_>>(), vec!["0123456789abcdef0123.png".to_string()]);
        assert!(!valid_image_name("0123456789ABCDEF0123.png"));
        assert!(!valid_image_name("0123456789abcdef0123"));
    }
}
