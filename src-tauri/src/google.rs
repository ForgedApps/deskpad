//! Google Calendar via OAuth 2.0 (desktop "installed app" flow with PKCE and a
//! loopback redirect). Tokens are stored in the app data dir.

use crate::calendar::Meeting;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Local, NaiveDate, TimeZone, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
/// Read all calendars, plus write access to events so Deskpad can add them.
const SCOPE: &str = "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events";
const WRITE_SCOPE: &str = "https://www.googleapis.com/auth/calendar.events";

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    /// Space-separated scopes Google actually granted. Older token files
    /// predate this field and were read-only.
    #[serde(default)]
    pub scope: String,
}

pub struct Google {
    path: PathBuf,
    /// The direct connection: this PC's own OAuth client and refresh token
    /// (Settings → advanced). Used when no Deskpad account provides access.
    tokens: Mutex<Option<Tokens>>,
    /// Access through the signed-in Deskpad account: a short-lived Google
    /// token the Deskpad server hands out and refreshes. Preferred when present.
    account: Mutex<Option<AccountToken>>,
}

/// A Google access token obtained through the Deskpad account.
#[derive(Clone)]
pub struct AccountToken {
    pub access_token: String,
    /// Unix seconds.
    pub expires_at: i64,
    pub can_write: bool,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: i64,
    #[serde(default)]
    scope: Option<String>,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("deskpad/0.1")
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl Google {
    pub fn load(dir: &std::path::Path) -> Self {
        let path = dir.join("google_tokens.json");
        let tokens = fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok());
        Self { path, tokens: Mutex::new(tokens), account: Mutex::new(None) }
    }

    /// Whether the calendar can be read at all, through the account or directly.
    pub fn connected(&self) -> bool {
        self.account.lock().unwrap().is_some() || self.connected_directly()
    }

    /// Whether this PC has its own direct connection (the advanced setup).
    pub fn connected_directly(&self) -> bool {
        self.tokens.lock().unwrap().as_ref().map(|t| !t.refresh_token.is_empty()).unwrap_or(false)
    }

    /// Whether the grant in use allows creating events.
    pub fn can_write(&self) -> bool {
        if let Some(a) = self.account.lock().unwrap().as_ref() {
            return a.can_write;
        }
        self.tokens
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|t| t.scope.split_whitespace().any(|s| s == WRITE_SCOPE))
    }

    /// Set or clear the access that comes with the Deskpad account.
    pub fn set_account(&self, token: Option<AccountToken>) {
        *self.account.lock().unwrap() = token;
    }

    /// Whether the account's token is present and good for at least another minute.
    pub fn account_fresh(&self) -> bool {
        self.account.lock().unwrap().as_ref().is_some_and(|a| a.expires_at > Utc::now().timestamp() + 60)
    }

    fn save(&self, t: Option<Tokens>) {
        match &t {
            Some(t) => {
                if let Ok(json) = serde_json::to_string_pretty(t) {
                    crate::store::write_atomic(&self.path, &json);
                }
            }
            None => {
                fs::remove_file(&self.path).ok();
            }
        }
        *self.tokens.lock().unwrap() = t;
    }

    pub fn disconnect(&self) {
        self.save(None);
    }

    /// Runs the full browser-based consent flow. Blocks (async) until the user
    /// finishes in the browser or the 5 minute timeout elapses.
    pub async fn connect<F: FnOnce(&str)>(
        &self,
        client_id: &str,
        client_secret: &str,
        open_browser: F,
    ) -> Result<(), String> {
        if client_id.trim().is_empty() {
            return Err("Enter a Google OAuth client ID first.".into());
        }

        // PKCE
        let mut raw = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut raw);
        let verifier = URL_SAFE_NO_PAD.encode(raw);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut st = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut st);
        let state = URL_SAFE_NO_PAD.encode(st);

        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let redirect = format!("http://127.0.0.1:{port}");

        let auth_url = format!(
            "{AUTH_URL}?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
            urlencode(client_id.trim()),
            urlencode(&redirect),
            urlencode(SCOPE),
            challenge,
            state
        );
        open_browser(&auth_url);

        // Wait for the redirect on a blocking thread.
        let expected_state = state.clone();
        let code = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
            listener.set_nonblocking(false).ok();
            let deadline = std::time::Instant::now() + Duration::from_secs(300);
            loop {
                if std::time::Instant::now() > deadline {
                    return Err("Timed out waiting for Google sign-in.".into());
                }
                let (mut stream, _) = listener.accept().map_err(|e| e.to_string())?;
                stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let line = req.lines().next().unwrap_or("");
                let path = line.split_whitespace().nth(1).unwrap_or("/");
                let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
                let mut code = None;
                let mut st = None;
                let mut err = None;
                for pair in query.split('&') {
                    let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                    match k {
                        "code" => code = Some(urldecode(v)),
                        "state" => st = Some(urldecode(v)),
                        "error" => err = Some(urldecode(v)),
                        _ => {}
                    }
                }
                let (status, body, result) = match (code, st, err) {
                    (_, _, Some(e)) => ("200 OK", format!("Google sign-in failed: {e}. You can close this tab."), Err(e)),
                    (Some(c), Some(s), None) if s == expected_state => (
                        "200 OK",
                        "Deskpad is connected to Google Calendar. You can close this tab.".to_string(),
                        Ok(c),
                    ),
                    (Some(_), _, None) => ("400 Bad Request", "State mismatch.".to_string(), Err("State mismatch".into())),
                    _ => {
                        // Probably a favicon or stray request; keep waiting.
                        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        continue;
                    }
                };
                let html = format!(
                    "<!doctype html><html><body style=\"font-family:Segoe UI,sans-serif;background:#15171c;color:#e8eaf0;display:grid;place-items:center;height:100vh;margin:0\"><h2>{body}</h2></body></html>"
                );
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
                        html.len()
                    )
                    .as_bytes(),
                );
                return result;
            }
        })
        .await
        .map_err(|e| e.to_string())??;

        // Exchange the code.
        let resp = client()?
            .post(TOKEN_URL)
            .form(&[
                ("code", code.as_str()),
                ("client_id", client_id.trim()),
                ("client_secret", client_secret.trim()),
                ("redirect_uri", redirect.as_str()),
                ("grant_type", "authorization_code"),
                ("code_verifier", verifier.as_str()),
            ])
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Token exchange failed: {body}"));
        }
        let tr: TokenResponse = resp.json().await.map_err(|e| e.to_string())?;
        let refresh = tr.refresh_token.ok_or("Google did not return a refresh token. Remove Deskpad from your Google account's third-party access and try again.")?;
        self.save(Some(Tokens {
            access_token: tr.access_token,
            refresh_token: refresh,
            expires_at: Utc::now().timestamp() + tr.expires_in - 60,
            scope: tr.scope.unwrap_or_else(|| SCOPE.to_string()),
        }));
        Ok(())
    }

    async fn access_token(&self, client_id: &str, client_secret: &str) -> Result<String, String> {
        // The account's token first; `lib.rs` keeps it fresh before each call.
        let account = self.account.lock().unwrap().clone();
        if let Some(a) = account {
            if a.expires_at > Utc::now().timestamp() {
                return Ok(a.access_token);
            }
            if !self.connected_directly() {
                return Err("Could not reach Deskpad to renew calendar access. It will retry.".into());
            }
        }
        let current = self.tokens.lock().unwrap().clone().ok_or("Not connected to Google.")?;
        if current.expires_at > Utc::now().timestamp() {
            return Ok(current.access_token);
        }
        let resp = client()?
            .post(TOKEN_URL)
            .form(&[
                ("client_id", client_id.trim()),
                ("client_secret", client_secret.trim()),
                ("refresh_token", current.refresh_token.as_str()),
                ("grant_type", "refresh_token"),
            ])
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            if body.contains("invalid_grant") {
                self.save(None);
                return Err("Google access was revoked. Reconnect in Settings.".into());
            }
            return Err(format!("Token refresh failed: {body}"));
        }
        let tr: TokenResponse = resp.json().await.map_err(|e| e.to_string())?;
        let tokens = Tokens {
            access_token: tr.access_token.clone(),
            refresh_token: tr.refresh_token.unwrap_or(current.refresh_token),
            expires_at: Utc::now().timestamp() + tr.expires_in - 60,
            scope: tr.scope.unwrap_or(current.scope),
        };
        self.save(Some(tokens));
        Ok(tr.access_token)
    }

    pub async fn meetings(
        &self,
        client_id: &str,
        client_secret: &str,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
    ) -> Result<Vec<Meeting>, String> {
        let token = self.access_token(client_id, client_secret).await?;
        let http = client()?;

        let list: CalendarList = http
            .get("https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&maxResults=100")
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;

        let mut out = Vec::new();
        for cal in list.items.into_iter().filter(|c| c.selected.unwrap_or(false)) {
            let url = format!(
                "https://www.googleapis.com/calendar/v3/calendars/{}/events?singleEvents=true&orderBy=startTime&maxResults=100&timeMin={}&timeMax={}",
                urlencode(&cal.id),
                urlencode(&from.to_rfc3339()),
                urlencode(&to.to_rfc3339())
            );
            let Ok(resp) = http.get(&url).bearer_auth(&token).send().await else { continue };
            let Ok(events) = resp.json::<Events>().await else { continue };
            for ev in events.items {
                if ev.status.as_deref() == Some("cancelled") {
                    continue;
                }
                if ev
                    .attendees
                    .iter()
                    .any(|a| a.self_.unwrap_or(false) && a.response_status.as_deref() == Some("declined"))
                {
                    continue;
                }
                let (Some(start), Some(end)) = (ev.start.as_ref(), ev.end.as_ref()) else { continue };
                let all_day = start.date.is_some();
                let (Some(s), Some(e)) = (start.instant(), end.instant()) else { continue };
                let join = ev
                    .hangout_link
                    .clone()
                    .or_else(|| {
                        ev.conference_data.as_ref().and_then(|c| {
                            c.entry_points
                                .iter()
                                .find(|p| p.entry_point_type.as_deref() == Some("video"))
                                .and_then(|p| p.uri.clone())
                        })
                    })
                    .or_else(|| ev.location.as_ref().filter(|l| l.starts_with("http")).cloned())
                    .or(ev.html_link.clone());
                out.push(Meeting {
                    id: format!("g:{}", ev.id),
                    title: ev.summary.unwrap_or_else(|| "(No title)".into()),
                    start: s.timestamp(),
                    end: e.timestamp(),
                    all_day,
                    location: ev.location,
                    url: join,
                });
            }
        }
        out.sort_by_key(|m| (m.start, m.end));
        out.dedup_by(|a, b| a.id == b.id);
        Ok(out)
    }

    /// Create a timed event on the primary calendar. `start`/`end` are unix
    /// seconds; they are sent in the machine's local time zone.
    pub async fn create_event(
        &self,
        client_id: &str,
        client_secret: &str,
        title: &str,
        start: i64,
        end: i64,
    ) -> Result<Meeting, String> {
        self.upsert_event(client_id, client_secret, None, title, start, end, false).await
    }

    /// Create an event on the primary calendar, or update `existing` (a raw
    /// Google event id) in place. An all-day event spans the local dates of
    /// `start` and `end` (`end` exclusive, as Google defines it). If the
    /// existing event was deleted in Google, a fresh one is created instead.
    /// The returned `Meeting` carries the event id as `g:<id>`.
    pub async fn upsert_event(
        &self,
        client_id: &str,
        client_secret: &str,
        existing: Option<&str>,
        title: &str,
        start: i64,
        end: i64,
        all_day: bool,
    ) -> Result<Meeting, String> {
        if !self.can_write() {
            return Err("Deskpad only has read access to your calendar. Disconnect and reconnect Google in Settings to allow adding events.".into());
        }
        let title = title.trim();
        if title.is_empty() {
            return Err("Give the event a title.".into());
        }
        if end <= start {
            return Err("The event must end after it starts.".into());
        }
        let token = self.access_token(client_id, client_secret).await?;
        let tz = iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".into());
        let local = |t: i64| Local.timestamp_opt(t, 0).single().ok_or_else(|| "bad time".to_string());
        let body = if all_day {
            let s = local(start)?.date_naive();
            let mut e = local(end)?.date_naive();
            if e <= s {
                e = s.succ_opt().ok_or("bad time")?;
            }
            serde_json::json!({
                "summary": title,
                "start": { "date": s.format("%Y-%m-%d").to_string() },
                "end": { "date": e.format("%Y-%m-%d").to_string() },
            })
        } else {
            serde_json::json!({
                "summary": title,
                "start": { "dateTime": local(start)?.to_rfc3339(), "timeZone": tz },
                "end": { "dateTime": local(end)?.to_rfc3339(), "timeZone": tz },
            })
        };
        let http = client()?;
        let create_url = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
        let mut resp = match existing.filter(|id| !id.is_empty()) {
            Some(id) => http
                .patch(format!("{create_url}/{}", urlencode(id)))
                .bearer_auth(&token)
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?,
            None => http.post(create_url).bearer_auth(&token).json(&body).send().await.map_err(|e| e.to_string())?,
        };
        if existing.is_some() && matches!(resp.status().as_u16(), 404 | 410) {
            // The user removed it in Google; make a new one.
            resp = http.post(create_url).bearer_auth(&token).json(&body).send().await.map_err(|e| e.to_string())?;
        }
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            if status.as_u16() == 403 {
                return Err("Google refused: Deskpad lacks permission to add events. Disconnect and reconnect Google in Settings.".into());
            }
            return Err(format!("Google rejected the event ({status}): {text}"));
        }
        let ev: Event = resp.json().await.map_err(|e| e.to_string())?;
        Ok(Meeting {
            id: format!("g:{}", ev.id),
            title: ev.summary.unwrap_or_else(|| title.to_string()),
            start,
            end,
            all_day,
            location: ev.location,
            url: ev.hangout_link.or(ev.html_link),
        })
    }

    /// Delete an event from the primary calendar by raw Google id. An event
    /// that is already gone counts as success.
    pub async fn delete_event(&self, client_id: &str, client_secret: &str, event_id: &str) -> Result<(), String> {
        if event_id.is_empty() {
            return Ok(());
        }
        if !self.can_write() {
            return Err("Deskpad only has read access to your calendar. Disconnect and reconnect Google in Settings to allow changing events.".into());
        }
        let token = self.access_token(client_id, client_secret).await?;
        let resp = client()?
            .delete(format!("https://www.googleapis.com/calendar/v3/calendars/primary/events/{}", urlencode(event_id)))
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if resp.status().is_success() || matches!(resp.status().as_u16(), 404 | 410) {
            return Ok(());
        }
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        Err(format!("Google refused to remove the event ({status}): {text}"))
    }
}

#[derive(Deserialize)]
struct CalendarList {
    #[serde(default)]
    items: Vec<CalendarEntry>,
}

#[derive(Deserialize)]
struct CalendarEntry {
    id: String,
    selected: Option<bool>,
}

#[derive(Deserialize)]
struct Events {
    #[serde(default)]
    items: Vec<Event>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    id: String,
    summary: Option<String>,
    status: Option<String>,
    location: Option<String>,
    hangout_link: Option<String>,
    html_link: Option<String>,
    start: Option<EventTime>,
    end: Option<EventTime>,
    #[serde(default)]
    attendees: Vec<Attendee>,
    conference_data: Option<ConferenceData>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Attendee {
    #[serde(rename = "self")]
    self_: Option<bool>,
    response_status: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConferenceData {
    #[serde(default)]
    entry_points: Vec<EntryPoint>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntryPoint {
    entry_point_type: Option<String>,
    uri: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventTime {
    date_time: Option<String>,
    date: Option<String>,
}

impl EventTime {
    fn instant(&self) -> Option<DateTime<Utc>> {
        if let Some(dt) = &self.date_time {
            return DateTime::parse_from_rfc3339(dt).ok().map(|d| d.with_timezone(&Utc));
        }
        let d = NaiveDate::parse_from_str(self.date.as_deref()?, "%Y-%m-%d").ok()?;
        Local.from_local_datetime(&d.and_hms_opt(0, 0, 0)?).single().map(|d| d.with_timezone(&Utc))
    }
}
