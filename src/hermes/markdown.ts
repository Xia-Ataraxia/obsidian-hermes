import { MarkdownRenderer, type App, type Component } from "obsidian";

// Highlighting only. Any other info string (dataview, dataviewjs, js-engine, mermaid, tasks, ...) becomes `text`.
const LANGS = new Set(("text txt plain md markdown js javascript jsx ts typescript tsx json jsonc yaml yml toml ini sh bash zsh " +
  "shell console diff patch py python rb ruby go rs rust java kt kotlin swift c h cpp cs php sql html xml css scss lua " +
  "dockerfile makefile").split(" "));
// Any line that could open a fence in some container: quote and list markers, any indentation.
const LOOSE = /^((?:[ \t]*(?:>|[-+*](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*)(`{3,}|~{3,})([^\n]*)$/;
// A fence we track: its quote and list markers on the same line, then at most 3 spaces.
// No `1)` marker: Obsidian may read it as a list or as text, so such a fence is prose.
const FENCE = /^((?: {0,3}(?:>|[-+*](?= )|\d{1,9}\.(?= )) ?)*(?: {0,3}))(`{3,}|~{3,})([^\n]*)$/;
const PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

interface Chunk { poisoned: boolean; plain: string }
const fresh = (): Chunk => ({ poisoned: false, plain: "" });

/** Model output -> Markdown that runs no plugin block, embed or raw HTML. Code shows as written. The output starts
 *  with a newline, so no text sits at offset 0, where Obsidian reads `---` as frontmatter and strips a BOM. */
export function tame(md: string): string {
  let fence: { run: string; quotes: number; indent: number } | null = null;
  let chunk = fresh();
  // A fence line went untracked (a `|` may make it a table row), a tracked fence lost its containers (Obsidian may
  // continue it lazily) or a `$$`/`%%` block may be open, so Obsidian may close a fence where we would open one.
  let doubt = false;
  return "\n" + md.split(/\r\n?|\n/).map(raw => {
    const line = lang(raw);
    if (fence) {
      const rest = inside(line, fence.quotes, fence.indent);
      if (rest !== null) {
        const run = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(rest)?.[1] ?? "";
        if (run[0] === fence.run[0] && run.length >= fence.run.length) fence = null;
        return line;
      }
      fence = null; doubt = true;
    }
    if (/\$\$|%%/.test(line)) doubt = true;
    const [, , loose = "", info = ""] = LOOSE.exec(line) ?? [];
    if (loose && !(loose.startsWith("`") && info.includes("`"))) {
      const [, pre = "", run = ""] = FENCE.exec(line) ?? [];
      if (run && !doubt && !line.includes("|")) {
        const tail = pre.replace(/^.*> ?/, "");
        fence = { run, quotes: pre.split(">").length - 1, indent: /[-+*\d]/.test(tail) ? tail.length : 0 };
        chunk = fresh();
        return line;
      }
      // ponytail: in doubt no fence is tracked again, so code after any math or comment block shows &lt; for <.
      doubt = true;
    }
    if (!line.trim()) chunk = fresh();
    return inline(line, chunk);
  }).join("\n");
}

// Rule 1 on every line, tracked fence or not, so a fence we misread never leaves a live plugin block.
function lang(line: string): string {
  const [, pre = "", run = "", info = ""] = LOOSE.exec(line) ?? [];
  const word = info.trim().split(/\s/)[0]?.toLowerCase() ?? "";
  return run && word && !LANGS.has(word) ? pre + run + "text" : line;
}

// A fenced line without its quote markers and list indent, or null once the line has left those containers.
function inside(line: string, quotes: number, indent: number): string | null {
  let rest = line;
  for (let i = 0; i < quotes; i++) {
    const marker = /^ {0,3}> ?/.exec(rest)?.[0];
    if (marker === undefined) return null;
    rest = rest.slice(marker.length);
  }
  return indent > 0 && rest.trim() !== "" && !rest.startsWith(" ".repeat(indent)) ? null : rest.slice(indent);
}

// Rule 2 outside fences. A code span stays byte-identical only when it surely is one (same-line closer, no `|`,
// nothing open before it, nothing left unpaired earlier in the paragraph); otherwise the rest of the paragraph is
// text, which can only over-escape.
// ponytail: indented (4-space) code blocks count as text, so `<` shows as &lt; there.
function inline(line: string, chunk: Chunk): string {
  let out = "";
  for (let i = 0; i < line.length; ) {
    const c = line.charAt(i), next = line.charAt(i + 1);
    let take = c;
    // An autolink may take the backslash, so `\<` leaves as an entity, which forms no tag.
    if (c === "\\" && next === "<") { out += "&lt;"; chunk.plain += c + next; i += 2; continue; }
    if (c === "\\" && next && PUNCT.includes(next)) take = c + next;
    else if (c === "`") {
      const run = /^`+/.exec(line.slice(i))?.[0] ?? c;
      const end = chunk.poisoned || open(chunk.plain) ? -1 : closer(line, i + run.length, run.length);
      const span = end < 0 ? "" : line.slice(i, end + run.length);
      if (span && !span.includes("|")) { out += /<[A-Za-z/!?]|!\[/.test(span) ? html(span, run.length) : span; i += span.length; continue; }
      chunk.poisoned = true;
      take = run;
    } else if (c === "!" && next === "[") { i++; continue; }
    else if (c === "<" && /[A-Za-z/!?]/.test(next)) { out += "&lt;"; chunk.plain += c; i++; continue; }
    out += take; chunk.plain += take; i += take.length;
  }
  return out;
}

function closer(line: string, from: number, n: number): number {
  const runs = /`+/g;
  runs.lastIndex = from;
  for (let m = runs.exec(line); m; m = runs.exec(line)) if (m[0].length === n) return m.index;
  return -1;
}

// A span that would be live Markdown without its backticks, as inline HTML: entities for & < >, a backslash before
// other ASCII punctuation. Shows the same text, and nothing in it can open a tag, link, embed or emphasis.
function html(span: string, n: number): string {
  return "<code>" + span.slice(n, -n).replace(/[!-/:-@[-`{-~]/g, ch => ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : "\\" + ch) + "</code>";
}

// True when a link destination, wikilink, math or comment opened in this text is still open: Obsidian may read a
// backtick there as plain text and pair the next one differently.
function open(text: string): boolean {
  let depth = 0;
  const link = text.lastIndexOf("](");
  if (link >= 0) for (const ch of text.slice(link + 1)) depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
  return depth > 0 || text.lastIndexOf("[[") > text.lastIndexOf("]]") || text.split("$").length % 2 === 0 || text.split("%%").length % 2 === 0;
}

// ponytail: Dataview's own per-render opt-out (`no-dataview` after the sourcePath's last `?`), checked in 0.5.68;
// a build without the check would run queries again (rule 1 still renames dataview and dataviewjs fences).
// It must never name a vault file, or Templater runs dynamic commands in the rendered text.
const NO_DATAVIEW = "?no-dataview";

// ponytail: no detached render to sanitize first; an <img> fetches as soon as its src is set, attached or not, so
// escaping in tame() is the guard.
/** Render model output through tame() with Dataview off, then turn links that leave the web (obsidian://, file:,
 *  app:, ...) into text. */
export async function renderSafe(app: App, md: string, el: HTMLElement, owner: Component): Promise<void> {
  await MarkdownRenderer.render(app, tame(md), el, NO_DATAVIEW, owner);
  el.querySelectorAll("a[href]").forEach(a => { if (!web(a.getAttribute("href") ?? "")) a.replaceWith(a.textContent ?? ""); });
}

export function web(href: string): boolean { return /^(https?|mailto):/i.test(href); }
