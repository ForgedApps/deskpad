use crate::calendar::Meeting;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// One outline row. `kind` is "note" or "task"; `parent` nests it one level
/// under another top-level item. Order in the vector is display order, with
/// children stored directly after their parent.
#[derive(Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: u64,
    pub text: String,
    #[serde(default = "legacy_kind")]
    pub kind: String,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub parent: Option<u64>,
    pub created_at: i64,
    /// When the task was last marked done (unix seconds), so the journal can
    /// show what got finished on a day. Cleared when it is reopened.
    #[serde(default)]
    pub done_at: Option<i64>,
    /// Set when the task is on the calendar.
    #[serde(default)]
    pub schedule: Option<Schedule>,
}

/// A task's place on the calendar: the event window (unix seconds) and the
/// Google event id, so the event can be updated or removed later. `event_id`
/// is `None` when creating the event failed and only the local time is kept.
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Schedule {
    pub start: i64,
    pub end: i64,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub event_id: Option<String>,
}

/// Files written before notes existed only held tasks.
fn legacy_kind() -> String {
    "task".into()
}

impl Item {
    /// Build an item from raw text, honouring the task markers: a leading
    /// `- `, `[]` / `[ ]`, or `/task` anywhere in the text turns it into a task
    /// (the marker is stripped). `/note` forces a note.
    pub fn from_text(text: &str, parent: Option<u64>) -> Option<Self> {
        let (text, kind) = parse_marker(text);
        if text.is_empty() {
            return None;
        }
        let now = chrono::Utc::now();
        Some(Self {
            id: now.timestamp_millis() as u64,
            text,
            kind: kind.into(),
            done: false,
            parent,
            created_at: now.timestamp(),
            done_at: None,
            schedule: None,
        })
    }
}

/// Returns (clean text, kind).
pub fn parse_marker(text: &str) -> (String, &'static str) {
    let t = text.trim();
    let mut kind = "note";
    let mut t = t.to_string();
    for m in ["[ ]", "[]", "- ", "-"] {
        if let Some(rest) = t.strip_prefix(m) {
            if m == "-" && !rest.starts_with(' ') && !rest.is_empty() {
                continue;
            }
            t = rest.trim_start().to_string();
            kind = "task";
            break;
        }
    }
    if t.contains("/task") {
        t = t.replace("/task", "");
        kind = "task";
    }
    if t.contains("/note") {
        t = t.replace("/note", "");
        kind = "note";
    }
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    (t, kind)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub google_client_id: String,
    pub google_client_secret: String,
    pub always_on_top: bool,
    pub reserve_space: bool,
    pub autostart: bool,
    pub width: u32,
    /// The Today view also lists tomorrow's events that start before this hour
    /// (0 = never show tomorrow, 24 = all of tomorrow).
    pub tomorrow_until_hour: u32,
    pub show_all_day: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            google_client_id: String::new(),
            google_client_secret: String::new(),
            always_on_top: false,
            reserve_space: true,
            autostart: false,
            width: 340,
            tomorrow_until_hour: 10,
            show_all_day: true,
        }
    }
}

/// An outline row that was removed from the live list, kept so it can be
/// restored. Children are archived together with their parent.
#[derive(Clone, Serialize, Deserialize)]
pub struct ArchivedItem {
    #[serde(flatten)]
    pub item: Item,
    pub archived_at: i64,
}

/// Keep this many days of recorded calendar events (`day_events.json`).
const DAY_EVENTS_KEEP_DAYS: i64 = 730;

pub struct Store {
    pub dir: PathBuf,
    pub items: Mutex<Vec<Item>>,
    pub archive: Mutex<Vec<ArchivedItem>>,
    pub settings: Mutex<Settings>,
    /// Calendar events as the sidebar last saw them, keyed by local day
    /// (`YYYY-MM-DD`). The journal shows these when Google can't be reached
    /// or the connection is gone, so a past day keeps its context.
    pub day_events: Mutex<BTreeMap<String, Vec<Meeting>>>,
}

impl Store {
    pub fn load(dir: PathBuf) -> Self {
        fs::create_dir_all(&dir).ok();
        let mut items: Vec<Item> = load_json(&dir.join("tasks.json")).unwrap_or_default();
        normalize(&mut items);
        let archive = load_json(&dir.join("archive.json")).unwrap_or_default();
        let settings = load_json(&dir.join("settings.json")).unwrap_or_default();
        let day_events = load_json(&dir.join("day_events.json")).unwrap_or_default();
        Self {
            dir,
            items: Mutex::new(items),
            archive: Mutex::new(archive),
            settings: Mutex::new(settings),
            day_events: Mutex::new(day_events),
        }
    }

    /// Remember the events of one day. Returns whether anything changed (the
    /// sidebar calls this every few minutes; unchanged days are not rewritten).
    pub fn record_day_events(&self, day: &str, meetings: Vec<Meeting>) -> bool {
        if day.len() != 10 {
            return false;
        }
        let mut map = self.day_events.lock().unwrap();
        let same = map
            .get(day)
            .is_some_and(|old| serde_json::to_string(old).ok() == serde_json::to_string(&meetings).ok());
        if same {
            return false;
        }
        map.insert(day.to_string(), meetings);
        // Prune very old days; keys sort as dates.
        let cutoff = (chrono::Local::now() - chrono::Duration::days(DAY_EVENTS_KEEP_DAYS)).format("%Y-%m-%d").to_string();
        map.retain(|k, _| k.as_str() >= cutoff.as_str());
        if let Ok(json) = serde_json::to_string(&*map) {
            write_atomic(&self.dir.join("day_events.json"), &json);
        }
        true
    }

    pub fn save_archive(&self) {
        let archive = self.archive.lock().unwrap();
        if let Ok(json) = serde_json::to_string_pretty(&*archive) {
            write_atomic(&self.dir.join("archive.json"), &json);
        }
    }

    /// Move the given items, plus everything nested under them at any depth,
    /// from the outline to the archive. Returns how many rows moved.
    pub fn archive_items(&self, ids: &[u64]) -> usize {
        let now = chrono::Utc::now().timestamp();
        let mut items = self.items.lock().unwrap();
        let mut archive = self.archive.lock().unwrap();
        // Rows are in pre-order, so one pass catches descendants of descendants.
        let mut gone: HashSet<u64> = ids.iter().copied().collect();
        for i in items.iter() {
            if i.parent.is_some_and(|p| gone.contains(&p)) {
                gone.insert(i.id);
            }
        }
        let doomed: Vec<Item> = items.iter().filter(|i| gone.contains(&i.id)).cloned().collect();
        items.retain(|i| !doomed.iter().any(|d| d.id == i.id));
        let n = doomed.len();
        archive.extend(doomed.into_iter().map(|item| ArchivedItem { item, archived_at: now }));
        n
    }

    /// Move archived rows back into the outline. A row whose parent is still in
    /// the outline goes back under it; one whose parent is neither there nor
    /// coming back becomes top-level at the end.
    pub fn restore_items(&self, ids: &[u64]) {
        let mut items = self.items.lock().unwrap();
        let mut archive = self.archive.lock().unwrap();
        let mut back: Vec<Item> = archive
            .iter()
            .filter(|a| ids.contains(&a.item.id))
            .map(|a| a.item.clone())
            .collect();
        archive.retain(|a| !ids.contains(&a.item.id));
        for i in back.iter_mut() {
            i.done = false;
            i.done_at = None;
        }
        items.extend(back);
        // Unknown parents become top-level and every row lands after its parent.
        normalize(&mut items);
    }

    pub fn save_items(&self) {
        let items = self.items.lock().unwrap();
        if let Ok(json) = serde_json::to_string_pretty(&*items) {
            let path = self.dir.join("tasks.json");
            backup_daily(&path, &self.dir.join("backups"));
            write_atomic(&path, &json);
        }
    }

    pub fn save_settings(&self) {
        let settings = self.settings.lock().unwrap();
        if let Ok(json) = serde_json::to_string_pretty(&*settings) {
            write_atomic(&self.dir.join("settings.json"), &json);
        }
    }
}

/// Read and parse a JSON file. A file that exists but does not parse is moved
/// aside as `<name>.corrupt-<timestamp>` instead of being silently replaced by
/// defaults on the next save.
pub fn load_json<T: serde::de::DeserializeOwned>(path: &std::path::Path) -> Option<T> {
    let text = fs::read_to_string(path).ok()?;
    match serde_json::from_str(&text) {
        Ok(v) => Some(v),
        Err(err) => {
            let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
            let aside = path.with_file_name(format!(
                "{}.corrupt-{stamp}",
                path.file_name().and_then(|n| n.to_str()).unwrap_or("data.json")
            ));
            eprintln!("[store] {} failed to parse ({err}); moved to {}", path.display(), aside.display());
            fs::rename(path, &aside).ok();
            None
        }
    }
}

/// Write via a temp file and rename so a crash mid-write never leaves a
/// truncated file behind.
pub fn write_atomic(path: &std::path::Path, contents: &str) {
    let tmp = path.with_extension("json.tmp");
    if let Err(err) = fs::write(&tmp, contents).and_then(|_| fs::rename(&tmp, path)) {
        eprintln!("[store] failed to write {}: {err}", path.display());
    }
}

/// Keep the first version of the file seen each day in `backups/`, pruning to
/// the newest 30. Runs before every overwrite; cheap when today's copy exists.
pub fn backup_daily(path: &std::path::Path, backups: &std::path::Path) {
    if !path.exists() {
        return;
    }
    let stem = path.file_stem().and_then(|n| n.to_str()).unwrap_or("data");
    let today = chrono::Local::now().format("%Y-%m-%d");
    let dest = backups.join(format!("{stem}-{today}.json"));
    if dest.exists() {
        return;
    }
    fs::create_dir_all(backups).ok();
    fs::copy(path, &dest).ok();
    let mut old: Vec<_> = fs::read_dir(backups)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(&format!("{stem}-"))))
                .collect()
        })
        .unwrap_or_default();
    old.sort();
    for p in old.iter().rev().skip(30) {
        fs::remove_file(p).ok();
    }
}

/// Put rows in pre-order (every row directly followed by its descendants,
/// keeping their relative order) and make rows whose parent is missing, or
/// part of a cycle, top-level. The frontend keeps this invariant while
/// editing; this re-establishes it after a load or a restore.
pub fn normalize(items: &mut Vec<Item>) {
    let ids: HashSet<u64> = items.iter().map(|i| i.id).collect();
    for i in items.iter_mut() {
        if i.parent.is_some_and(|p| p == i.id || !ids.contains(&p)) {
            i.parent = None;
        }
    }
    fn emit(items: &[Item], parent: Option<u64>, out: &mut Vec<Item>, seen: &mut HashSet<u64>) {
        for i in items {
            if i.parent == parent && seen.insert(i.id) {
                out.push(i.clone());
                emit(items, Some(i.id), out, seen);
            }
        }
    }
    let mut out = Vec::with_capacity(items.len());
    let mut seen = HashSet::new();
    emit(items, None, &mut out, &mut seen);
    for i in items.iter() {
        if !seen.contains(&i.id) {
            let mut c = i.clone();
            c.parent = None;
            out.push(c);
        }
    }
    *items = out;
}

/// The row text without its Markdown markers, for calendar event titles.
pub fn strip_inline(text: &str) -> String {
    let mut s = text.replace("**", "").replace("~~", "").replace('`', "");
    // [label](url) -> label
    while let Some(open) = s.find('[') {
        let Some(close) = s[open..].find("](") else { break };
        let close = open + close;
        let Some(end) = s[close..].find(')') else { break };
        let end = close + end;
        let label = s[open + 1..close].to_string();
        s.replace_range(open..=end, &label);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::{backup_daily, load_json, normalize, parse_marker, strip_inline, write_atomic, Item, Store};

    fn item(id: u64, parent: Option<u64>) -> Item {
        Item { id, text: format!("item {id}"), kind: "note".into(), done: false, parent, created_at: 0, done_at: None, schedule: None }
    }

    #[test]
    fn archive_takes_children_and_restore_rebuilds_order() {
        let dir = std::env::temp_dir().join(format!("deskpad-archive-{}", std::process::id()));
        let store = Store::load(dir.clone());
        *store.items.lock().unwrap() = vec![item(1, None), item(2, Some(1)), item(3, Some(1)), item(4, None)];
        assert_eq!(store.archive_items(&[1]), 3);
        assert_eq!(store.items.lock().unwrap().iter().map(|i| i.id).collect::<Vec<_>>(), vec![4]);
        assert_eq!(store.archive.lock().unwrap().len(), 3);

        // Restoring only a child makes it top-level.
        store.restore_items(&[2]);
        let ids: Vec<(u64, Option<u64>)> = store.items.lock().unwrap().iter().map(|i| (i.id, i.parent)).collect();
        assert_eq!(ids, vec![(4, None), (2, None)]);

        // Restoring the parent with its remaining child keeps them together.
        store.restore_items(&[1, 3]);
        let ids: Vec<(u64, Option<u64>)> = store.items.lock().unwrap().iter().map(|i| (i.id, i.parent)).collect();
        assert_eq!(ids, vec![(4, None), (2, None), (1, None), (3, Some(1))]);
        assert!(store.archive.lock().unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn archive_takes_deep_descendants_and_restore_nests_under_a_live_parent() {
        let dir = std::env::temp_dir().join(format!("deskpad-deep-{}", std::process::id()));
        let store = Store::load(dir.clone());
        // 1 > 2 > 3 > 4, then 5 top-level.
        *store.items.lock().unwrap() = vec![item(1, None), item(2, Some(1)), item(3, Some(2)), item(4, Some(3)), item(5, None)];
        assert_eq!(store.archive_items(&[2]), 3);
        let ids: Vec<u64> = store.items.lock().unwrap().iter().map(|i| i.id).collect();
        assert_eq!(ids, vec![1, 5]);
        // The grandchild alone comes back under its live grandparent-chain's nearest known parent: none, so top-level.
        store.restore_items(&[4]);
        let ids: Vec<(u64, Option<u64>)> = store.items.lock().unwrap().iter().map(|i| (i.id, i.parent)).collect();
        assert_eq!(ids, vec![(1, None), (5, None), (4, None)]);
        // 2 and 3 come back under 1, directly after it, and 3 under 2.
        store.restore_items(&[2, 3]);
        let ids: Vec<(u64, Option<u64>)> = store.items.lock().unwrap().iter().map(|i| (i.id, i.parent)).collect();
        assert_eq!(ids, vec![(1, None), (2, Some(1)), (3, Some(2)), (5, None), (4, None)]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn normalize_reorders_and_breaks_cycles() {
        let mut items = vec![item(3, Some(1)), item(1, None), item(2, Some(1)), item(7, Some(9)), item(5, Some(6)), item(6, Some(5))];
        normalize(&mut items);
        let ids: Vec<(u64, Option<u64>)> = items.iter().map(|i| (i.id, i.parent)).collect();
        assert_eq!(ids, vec![(1, None), (3, Some(1)), (2, Some(1)), (7, None), (5, None), (6, None)]);
    }

    #[test]
    fn strip_inline_drops_markers() {
        assert_eq!(strip_inline("**call** [Tom](https://x.y/z) re `plan` ~~old~~"), "call Tom re plan old");
    }

    #[test]
    fn corrupt_file_is_set_aside_not_overwritten() {
        let dir = std::env::temp_dir().join(format!("deskpad-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tasks.json");
        std::fs::write(&path, "{not json").unwrap();
        let loaded: Option<Vec<super::Item>> = load_json(&path);
        assert!(loaded.is_none());
        assert!(!path.exists(), "corrupt file should have been moved aside");
        let aside = std::fs::read_dir(&dir).unwrap().flatten().find(|e| e.file_name().to_string_lossy().starts_with("tasks.json.corrupt-"));
        assert!(aside.is_some());

        write_atomic(&path, "[]");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[]");
        backup_daily(&path, &dir.join("backups"));
        assert_eq!(std::fs::read_dir(dir.join("backups")).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn items_without_schedule_still_load() {
        let old = r#"[{"id":1,"text":"a","kind":"task","done":false,"parent":null,"created_at":0}]"#;
        let items: Vec<Item> = serde_json::from_str(old).unwrap();
        assert!(items[0].schedule.is_none());
        let new = r#"[{"id":1,"text":"a","kind":"task","done":false,"parent":null,"created_at":0,"schedule":{"start":10,"end":20}}]"#;
        let items: Vec<Item> = serde_json::from_str(new).unwrap();
        assert_eq!(items[0].schedule, Some(super::Schedule { start: 10, end: 20, all_day: false, event_id: None }));
    }

    #[test]
    fn day_events_are_recorded_once_and_pruned() {
        use crate::calendar::Meeting;
        let dir = std::env::temp_dir().join(format!("deskpad-dayev-{}", std::process::id()));
        let store = Store::load(dir.clone());
        let m = Meeting { id: "g:1".into(), title: "Standup".into(), start: 10, end: 20, all_day: false, location: None, url: None };
        assert!(store.record_day_events("2026-11-02", vec![m.clone()]));
        assert!(!store.record_day_events("2026-11-02", vec![m.clone()]), "unchanged day must not rewrite");
        assert!(!store.record_day_events("bogus", vec![]));
        assert!(store.record_day_events("2000-01-01", vec![m]), "accepted, then pruned");
        let reloaded = Store::load(dir.clone());
        let map = reloaded.day_events.lock().unwrap();
        assert!(map.contains_key("2026-11-02"));
        assert!(!map.contains_key("2000-01-01"));
        drop(map);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn markers() {
        assert_eq!(parse_marker("buy milk"), ("buy milk".into(), "note"));
        assert_eq!(parse_marker("- buy milk"), ("buy milk".into(), "task"));
        assert_eq!(parse_marker("[] buy milk"), ("buy milk".into(), "task"));
        assert_eq!(parse_marker("[ ] buy milk"), ("buy milk".into(), "task"));
        assert_eq!(parse_marker("buy milk /task"), ("buy milk".into(), "task"));
        assert_eq!(parse_marker("call /task mom"), ("call mom".into(), "task"));
        assert_eq!(parse_marker("-dash word"), ("-dash word".into(), "note"));
        assert_eq!(parse_marker("- x /note"), ("x".into(), "note"));
        assert_eq!(parse_marker("   "), ("".into(), "note"));
    }
}
