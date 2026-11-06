// Turns clipboard content into outline rows. Rich text (HTML from a browser,
// Google Docs, Word, …) keeps its list structure as nesting and its inline
// formatting as the Markdown subset `renderInline` understands; plain text is
// split on lines, with leading whitespace or bullets as nesting. Pure: no DOM
// beyond DOMParser, so it can be tested in Node with a tiny parser shim.

export interface PastedLine {
  /** Nesting relative to the first line (0 = same level as the target row). */
  depth: number;
  text: string;
  /** Set when the source said so (a checklist item); otherwise the marker parser decides. */
  kind: "task" | null;
  done: boolean;
}

const BLOCK = new Set(["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "tr", "section", "article", "header", "footer", "dd", "dt", "table", "thead", "tbody", "figure", "figcaption", "hr"]);
const SKIP = new Set(["script", "style", "head", "meta", "title", "template", "noscript", "svg", "img", "button", "input", "select", "textarea"]);

/** Parse whatever the clipboard holds into lines; empty when there is nothing usable. */
export function parseClipboard(html: string | null | undefined, plain: string): PastedLine[] {
  let lines: PastedLine[] = [];
  if (html && html.trim()) {
    try {
      lines = fromHtml(html);
    } catch (err) {
      console.error("paste: html parse failed", err);
      lines = [];
    }
  }
  if (!lines.length) lines = fromPlain(plain);
  const min = Math.min(...lines.map((l) => l.depth));
  for (const l of lines) l.depth -= min;
  return lines;
}

// ---------- HTML ----------

function fromHtml(html: string): PastedLine[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const lines: PastedLine[] = [];
  let cur: PastedLine | null = null;
  let buf = "";

  const flush = () => {
    if (cur) {
      const t = cleanLine(buf);
      if (t.text) lines.push({ ...cur, text: t.text, kind: cur.kind ?? t.kind, done: cur.done || t.done });
    }
    cur = null;
    buf = "";
  };
  const start = (depth: number, kind: "task" | null = null, done = false) => {
    flush();
    cur = { depth, text: "", kind, done };
  };
  const ensure = (depth: number) => {
    if (!cur) cur = { depth, text: "", kind: null, done: false };
  };

  const walk = (node: Node, depth: number, pre: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.textContent ?? "";
      if (!pre && !raw.trim() && !buf) return; // leading whitespace between blocks
      ensure(depth);
      buf += pre ? raw : raw.replace(/\s+/g, " ");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) return;
    if (tag === "br") {
      flush();
      return;
    }
    // A block boundary ends the current line, but a line a list item just
    // started (carrying its checkbox state) waits for its first text.
    const boundary = () => {
      if (buf.trim() || !cur) flush();
    };
    if (tag === "ul" || tag === "ol") {
      boundary();
      for (const c of Array.from(el.childNodes)) walk(c, depth + 1, pre);
      flush();
      return;
    }
    if (tag === "li") {
      const role = el.getAttribute("role");
      const checked = el.getAttribute("aria-checked");
      const task = role === "checkbox" || checked !== null;
      start(Math.max(0, depth - 1), task ? "task" : null, checked === "true");
      for (const c of Array.from(el.childNodes)) walk(c, depth, pre);
      flush();
      return;
    }
    if (BLOCK.has(tag)) {
      boundary();
      // Word pastes lists as paragraphs indented 36pt per level.
      let d = depth;
      if (/MsoListParagraph/i.test(el.className)) {
        const pt = parseFloat(/margin-left:\s*([\d.]+)pt/i.exec(el.getAttribute("style") ?? "")?.[1] ?? "36");
        d += Math.max(0, Math.round(pt / 36) - 1);
      }
      for (const c of Array.from(el.childNodes)) walk(c, d, pre || tag === "pre");
      flush();
      return;
    }
    if (tag === "a") {
      const href = el.getAttribute("href") ?? "";
      const label = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (/^https?:\/\//i.test(href) && label) {
        ensure(depth);
        const same = label === href || label === href.replace(/^https?:\/\//i, "") || label.replace(/\/$/, "") === href.replace(/^https?:\/\//i, "").replace(/\/$/, "");
        buf += same ? href : `[${label.replace(/[\[\]]/g, "")}](${href})`;
        return;
      }
    }
    const mark = inlineMark(el, tag);
    // Markers only wrap elements without block children, so they can't straddle lines.
    if (mark && !el.querySelector("p,div,li,ul,ol,h1,h2,h3,h4,h5,h6,blockquote,pre,tr,br")) {
      ensure(depth);
      const before = buf.length;
      for (const c of Array.from(el.childNodes)) walk(c, depth, pre);
      const inner = buf.slice(before);
      if (!inner.trim()) return;
      // Keep the surrounding whitespace outside the markers.
      const lead = /^\s*/.exec(inner)![0];
      const trail = /\s*$/.exec(inner)![0];
      const core = inner.slice(lead.length, inner.length - trail.length);
      buf = buf.slice(0, before) + lead + mark + core + mark + trail;
      return;
    }
    for (const c of Array.from(el.childNodes)) walk(c, depth, pre);
  };

  walk(doc.body, 0, false);
  flush();
  return lines;
}

/** The Markdown marker an element's styling calls for, if any. */
function inlineMark(el: HTMLElement, tag: string): string | null {
  const style = (el.getAttribute("style") ?? "").toLowerCase().replace(/\s+/g, "");
  const weight = /font-weight:([^;]+)/.exec(style)?.[1];
  const boldStyle = weight !== undefined && (weight === "bold" || weight === "bolder" || (parseInt(weight, 10) || 0) >= 600);
  const normalStyle = weight !== undefined && !boldStyle;
  if ((tag === "b" || tag === "strong") && !normalStyle) return "**";
  if (boldStyle) return "**";
  if (tag === "i" || tag === "em" || /font-style:italic/.test(style)) return "*";
  if (tag === "code" || tag === "kbd" || tag === "samp" || tag === "tt") return "`";
  if (tag === "s" || tag === "del" || tag === "strike" || /text-decoration[^;]*line-through/.test(style)) return "~~";
  return null;
}

// ---------- plain text ----------

function fromPlain(plain: string): PastedLine[] {
  const lines: PastedLine[] = [];
  for (const raw of plain.replace(/\r\n?/g, "\n").split("\n")) {
    if (!raw.trim()) continue;
    const indent = /^[ \t]*/.exec(raw)![0];
    const depth = indent.replace(/\t/g, "  ").length >> 1;
    const t = cleanLine(raw.slice(indent.length));
    if (t.text) lines.push({ depth, ...t });
  }
  return lines;
}

/** Trim, collapse whitespace, drop empty marker pairs, and read bullet/checkbox prefixes. */
function cleanLine(s: string): { text: string; kind: "task" | null; done: boolean } {
  let text = s.replace(/[ \t ]+/g, " ").trim();
  text = text.replace(/\*\*\s*\*\*|~~\s*~~|``|(^|[^\w*])\*\s*\*(?=[^\w*]|$)/g, "$1").trim();
  text = text.replace(/^(?:[-*•·◦▪▫‣–—]|o|\d+[.)]|[a-z][.)])\s+/i, "");
  let kind: "task" | null = null;
  let done = false;
  const box = /^(?:\[( |x|X)\]|☐|☑|☒|✓|✔)\s*/.exec(text);
  if (box) {
    kind = "task";
    done = box[1] !== undefined ? box[1] !== " " : box[0].trim() !== "☐";
    text = text.slice(box[0].length);
  }
  return { text: text.trim(), kind, done };
}
