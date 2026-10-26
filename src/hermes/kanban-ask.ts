import { AbstractInputSuggest, Modal, Notice, type App } from "obsidian";
import { type Card, type Verb } from "./kanban";
import { CONFIRM, message } from "./kanban-common";

export function suggestion(el: HTMLElement, title: string, note?: string): void {
  el.addClass("mod-complex");
  const content = el.createDiv("suggestion-content");
  content.createDiv({ cls: "suggestion-title", text: title });
  if (note) content.createDiv({ cls: "suggestion-note", text: note });
}

export class Suggest<T> extends AbstractInputSuggest<T> {
  constructor(app: App, input: HTMLInputElement, private readonly items: (query: string) => T[] | Promise<T[]>, private readonly draw: (item: T, el: HTMLElement) => void, chosen: (item: T) => void) {
    super(app, input);
    this.onSelect(item => { chosen(item); this.close(); });
  }

  protected getSuggestions(query: string): T[] | Promise<T[]> { return this.items(query); }
  renderSuggestion(item: T, el: HTMLElement): void { this.draw(item, el); }
}

export interface Suggestion { value: string; label: string; note?: string; fill?: Record<string, string> }

export interface Field {
  /** A checkbox reads "on" when ticked, else "" (and starts ticked when `value` is "on"). */
  key: string; label: string; kind?: "text" | "textarea" | "dropdown" | "number" | "checkbox"; value?: string; options?: [string, string][];
  placeholder?: string; required?: boolean; desc?: string;
  /** Enter submits (Shift+Enter keeps a newline). */
  enter?: boolean;
  /** Monospace textarea, for text the worker receives verbatim. */
  mono?: boolean;
  suggest?: (query: string, values: Record<string, string>) => Suggestion[] | Promise<Suggestion[]>;
}

/** Dialog copy: fixed, or drawn from the form's values as they change. */
type Say = string | ((values: Record<string, string>) => string);

export interface Ask {
  title: string; text?: Say; fields?: Field[]; cta?: Say; warning?: boolean;
  /** Copy `map(from)` into `to` until the user edits `to`. */
  follow?: { from: string; to: string; map: (v: string) => string };
  hint?: (values: Record<string, string>) => string;
  /** Resolve null to close, or an error to show in the form. */
  submit: (values: Record<string, string>) => Promise<string | null>;
  closed?: () => void;
}

export type Focus = "diagnostics" | "comment";

type Control = HTMLElement & { value: string; type?: string; checked?: boolean };

class AskModal extends Modal {
  private dismissed = false;
  /** Set by onOpen: puts a new field's row in the open form, ahead of the row of the field named. */
  private insert: ((f: Field, before: string) => void) | null = null;
  constructor(app: App, private readonly ask: Ask) { super(app); }

  /** Adds a field to the form while it is open, ahead of the one named `before`; a dialog that has closed takes nothing. */
  addField(f: Field, before: string): void {
    if (this.dismissed) return;
    const fields = this.ask.fields ??= [], at = fields.findIndex(x => x.key === before);
    fields.splice(at < 0 ? fields.length : at, 0, f);
    this.insert?.(f, before);
  }

  override onOpen(): void {
    const a = this.ask, fields = a.fields ??= [];
    this.modalEl.addClass("hm-modal");
    this.setTitle(a.title);
    const grid = fields.length > 4;
    this.modalEl.toggleClass("is-grid", grid);
    const form = this.contentEl.createEl("form", { cls: grid ? "hm-form is-grid" : "hm-form" });
    const lead = a.text ? form.createEl("p", { cls: "hm-k-ask-text" }) : null;
    const inputs = new Map<string, Control>();
    const values = (): Record<string, string> => Object.fromEntries([...inputs].map(([key, el]) => [key, el.type === "checkbox" ? (el.checked ? "on" : "") : el.value.trim()]));
    const say = (s: Say | undefined): string => typeof s === "function" ? s(values()) : s ?? "";
    const build = (f: Field): HTMLElement => {
      const label = form.createEl("label", { cls: f.kind === "textarea" ? "hm-k-field is-wide" : f.kind === "checkbox" ? "hm-k-field is-check" : "hm-k-field" });
      label.createSpan({ cls: "hm-k-field-label", text: f.label });
      const placeholder = f.placeholder ? { placeholder: f.placeholder } : {};
      let input: Control;
      if (f.kind === "textarea") input = label.createEl("textarea", { ...(f.mono ? { cls: "is-mono" } : {}), attr: { rows: 3, ...placeholder } });
      else if (f.kind === "checkbox") {
        input = label.createEl("input", { type: "checkbox" });
        input.checked = f.value === "on";
      } else if (f.kind === "dropdown") {
        const select = label.createEl("select", { cls: "dropdown" });
        for (const [value, text] of f.options ?? []) select.createEl("option", { value, text });
        input = select;
      } else {
        const text = label.createEl("input", { type: f.kind ?? "text", ...placeholder });
        const suggest = f.suggest;
        if (suggest) new Suggest<Suggestion>(this.app, text, q => suggest(q, values()), (s, el) => suggestion(el, s.label, s.note), s => {
          text.value = s.value;
          for (const [key, value] of Object.entries(s.fill ?? {})) { const other = inputs.get(key); if (other) other.value = value; }
          form.dispatchEvent(new Event("change"));
        });
        input = text;
      }
      if (f.value !== undefined) input.value = f.value;
      if (f.enter) label.addEventListener("keydown", event => {
        if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.isComposing) return;
        event.preventDefault();
        form.requestSubmit();
      });
      if (f.desc) label.createDiv({ cls: "hm-k-field-desc", text: f.desc });
      inputs.set(f.key, input);
      return label;
    };
    for (const f of fields) build(f);
    const follow = a.follow, src = follow && inputs.get(follow.from), dst = follow && inputs.get(follow.to);
    if (follow && src && dst) {
      let touched = !!dst.value;
      dst.addEventListener("input", () => { touched = true; });
      src.addEventListener("input", () => { if (!touched) dst.value = follow.map(src.value); });
    }
    const hint = form.createDiv("hm-k-hint"), error = form.createDiv("hm-k-error");
    const buttons = form.createDiv("modal-button-container");
    // type=button: with a submit button, Enter in any one-line field (a picker mid-choice too) would submit.
    const cta = buttons.createEl("button", { cls: a.warning ? "mod-warning" : "mod-cta", attr: { type: "button" } });
    cta.addEventListener("click", () => form.requestSubmit());
    buttons.createEl("button", { text: "Cancel", attr: { type: "button" } }).addEventListener("click", () => this.close());
    const sync = (): void => { lead?.setText(say(a.text)); cta.setText(say(a.cta) || "Save"); hint.setText(a.hint?.(values()) ?? ""); };
    form.addEventListener("input", sync);
    form.addEventListener("change", sync);
    sync();
    this.insert = (f, before) => form.insertBefore(build(f), inputs.get(before)?.closest("label") ?? hint);
    form.addEventListener("keydown", event => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
    });
    let busy = false;
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (busy) return;
      const v = values(), missing = fields.find(f => f.required && !v[f.key]);
      if (missing) { error.setText(`${missing.label} is required`); inputs.get(missing.key)?.focus(); return; }
      busy = true;
      cta.disabled = true;
      error.setText("");
      void a.submit(v).catch(message).then(result => {
        busy = false;
        cta.disabled = false;
        if (result === null) this.close(); else if (this.dismissed) new Notice(result, 10_000); else error.setText(result);
      });
    });
    ([...inputs.values()].find(el => el.tagName !== "SELECT" && el.type !== "checkbox") ?? cta).focus();
  }

  override onClose(): void {
    // A write still in flight reports its failure in a Notice: the form is gone.
    this.dismissed = true;
    this.contentEl.empty();
    this.ask.closed?.();
  }
}

export function ask(app: App, a: Ask): AskModal {
  const modal = new AskModal(app, a);
  modal.open();
  return modal;
}

export function confirmed(app: App, title: string, text: string, cta = "Confirm", warning = false): Promise<boolean> {
  return new Promise(resolve => {
    let ok = false;
    ask(app, { title, text, cta, warning, submit: () => { ok = true; return Promise.resolve(null); }, closed: () => resolve(ok) });
  });
}

type BlockKind = NonNullable<Extract<Verb, { verb: "block" }>["kind"]>;
const BLOCK_KINDS: [BlockKind, string][] = [["needs_input", "Needs input"], ["capability", "Capability"], ["dependency", "Dependency"], ["transient", "Transient"]];

export function askBlock(app: App, cards: Pick<Card, "blockKind" | "blockRecurrences">[], submit: (kind: BlockKind, reason: string) => Promise<string | null>): void {
  const one = cards.length === 1 ? cards[0] : undefined;
  ask(app, {
    title: one ? "Block task" : `Block ${cards.length} tasks`, cta: "Block",
    fields: [
      { key: "kind", label: "Kind", kind: "dropdown", value: "needs_input", options: BLOCK_KINDS },
      { key: "reason", label: "Reason", kind: "textarea", required: true, enter: true, placeholder: "What does the worker need?" },
    ],
    hint: v => one?.blockRecurrences && one.blockKind === v.kind ? `Blocked as ${v.kind} ${one.blockRecurrences}× already — another block of this kind may send it to triage.` : "",
    submit: v => submit((v.kind || "needs_input") as BlockKind, v.reason ?? ""),
  });
}

export function askComplete(app: App, n: number, submit: (summary: string, result: string) => Promise<string | null>): void {
  ask(app, {
    title: n === 1 ? "Complete task" : `Complete ${n} tasks`, text: n === 1 ? CONFIRM.done : `Mark ${n} tasks as done?`, cta: "Complete",
    fields: [
      { key: "summary", label: "Summary", kind: "textarea", placeholder: "Optional" },
      { key: "result", label: "Result", kind: "textarea", placeholder: "Optional" },
    ],
    submit: v => submit(v.summary ?? "", v.result ?? ""),
  });
}

/** Reassigning a running task: Hermes refuses while a worker still holds it unless it is reclaimed first, so the box starts
 *  unticked and the refusal comes back per card. `cancelled` runs when the form closes without a successful write. */
export function askReassign(app: App, submit: (reclaim: boolean) => Promise<string | null>, o: { reclaim?: boolean; cancelled?: () => void } = {}): void {
  let sent = false;
  ask(app, {
    title: "Reassign", cta: "Reassign", warning: true,
    text: "Hermes refuses to reassign a running task while its worker holds it. Reclaiming first stops the worker and returns the task to the queue.",
    fields: [{ key: "reclaim", label: "Reclaim running cards first", kind: "checkbox", value: o.reclaim ? "on" : "" }],
    submit: async v => { const error = await submit(v.reclaim === "on"); if (error === null) sent = true; return error; },
    closed: () => { if (!sent) o.cancelled?.(); },
  });
}

