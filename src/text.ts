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

function anchor(href: string, label: string): string {
  const url = /^www\./i.test(href) ? `https://${href}` : href;
  return `<a href="${escapeHtml(url)}" data-ext title="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

/** Inline styling markers on a segment that holds no code span, link or URL. */
function styled(s: string): string {
  let h = escapeHtml(s);
  h = h.replace(/\*\*(\S(?:[^*]*?\S)?)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/~~(\S(?:[^~]*?\S)?)~~/g, "<s>$1</s>");
  h = h.replace(/(^|[^\w*])\*(\S(?:[^*]*?\S)?)\*(?=[^\w*]|$)/g, "$1<em>$2</em>");
  h = h.replace(/(^|[^\w_])_(\S(?:[^_]*?\S)?)_(?=[^\w_]|$)/g, "$1<em>$2</em>");
  return h;
}

const INLINE_RE = /`([^`\n]+)`|\[([^\]\n]+)\]\(((?:https?:\/\/|www\.)[^\s)]+)\)|(?:https?:\/\/|www\.)[^\s<>"']+/gi;

/**
 * HTML for a row's text. Rows are stored as plain text with a small Markdown
 * subset, which is what pasted rich text is converted to and what the row shows
 * while it is being edited: `**bold**`, `*italic*` / `_italic_`, `~~struck~~`,
 * `` `code` ``, `[label](url)`, and bare URLs become links as before.
 */
export function renderInline(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const start = m.index!;
    out += styled(text.slice(last, start));
    last = start + m[0].length;
    if (m[1] !== undefined) out += `<code>${escapeHtml(m[1])}</code>`;
    else if (m[2] !== undefined) out += anchor(m[3], m[2]);
    else {
      let url = m[0];
      const trail = /[.,;:!?)\]]+$/.exec(url);
      if (trail) url = url.slice(0, -trail[0].length);
      out += anchor(url, url) + escapeHtml(trail ? trail[0] : "");
    }
  }
  return out + styled(text.slice(last));
}

/** The row's text without its formatting markers (for titles and tooltips). */
export function stripInline(text: string): string {
  return text
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]\n]+)\]\((?:https?:\/\/|www\.)[^\s)]+\)/gi, "$1")
    .replace(/\*\*(\S(?:[^*]*?\S)?)\*\*/g, "$1")
    .replace(/~~(\S(?:[^~]*?\S)?)~~/g, "$1")
    .replace(/(^|[^\w*])\*(\S(?:[^*]*?\S)?)\*(?=[^\w*]|$)/g, "$1$2")
    .replace(/(^|[^\w_])_(\S(?:[^_]*?\S)?)_(?=[^\w_]|$)/g, "$1$2");
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
