// Small text and date helpers shared by the sidebar, the journal and capture.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;

/** HTML for `text` with URLs wrapped in `<a data-ext>` anchors; trailing punctuation stays text. */
export function linkify(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    const trail = /[.,;:!?)\]]+$/.exec(url);
    if (trail) url = url.slice(0, -trail[0].length);
    if (!url) continue;
    const start = m.index!;
    out += escapeHtml(text.slice(last, start));
    const href = /^www\./i.test(url) ? `https://${url}` : url;
    out += `<a href="${escapeHtml(href)}" data-ext title="${escapeHtml(href)}">${escapeHtml(url)}</a>`;
    last = start + url.length;
  }
  return out + escapeHtml(text.slice(last));
}

/** Local calendar day of a unix timestamp as `YYYY-MM-DD`. */
export function dayKey(unix: number): string {
  return dayKeyOf(new Date(unix * 1000));
}

export function dayKeyOf(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight of a `YYYY-MM-DD` key. */
export function keyToDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key: string, n: number): string {
  const d = keyToDate(key);
  d.setDate(d.getDate() + n);
  return dayKeyOf(d);
}

export const todayKey = () => dayKeyOf(new Date());

export function fmtTime(unix: number): string {
  return new Date(unix * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "Monday, November 2" (with the year when it isn't this year). */
export function fmtDayTitle(key: string): string {
  const d = keyToDate(key);
  const opts: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString([], opts);
}

/** "Today", "Yesterday", "Tomorrow" or null. */
export function relativeDayName(key: string): string | null {
  const t = todayKey();
  if (key === t) return "Today";
  if (key === addDays(t, -1)) return "Yesterday";
  if (key === addDays(t, 1)) return "Tomorrow";
  return null;
}
