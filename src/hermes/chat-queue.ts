import type { Queued } from "./send-queue";
import { icon, iconButton } from "./ui";

export interface QueueActions {
  edit(id: number): void;
  remove(id: number): void;
  resume(): void;
  clear(): void;
}

/** A leaving chip plays its exit animation; this is the ceiling if `animationend` never comes (hidden window). */
const LEAVE_MS = 600;

/**
 * The messages waiting for the current turn, above the composer. Chips are keyed: one that stays is untouched, an
 * arrival rises in, and a departure either flies up toward the thread (`sent`) or sinks away (removed).
 */
export class QueueBar {
  private readonly el: HTMLElement;
  private readonly head: HTMLElement;
  private readonly list: HTMLElement;
  private readonly chips = new Map<number, { el: HTMLElement; pos: HTMLElement }>();
  private sentId = 0;

  constructor(parent: HTMLElement, private readonly actions: QueueActions) {
    this.el = parent.createDiv({ cls: "hm-queue", attr: { "aria-label": "Queued messages" } });
    const inner = this.el.createDiv("hm-queue-in");
    this.head = inner.createDiv("hm-queue-head");
    this.list = inner.createDiv("hm-queue-list");
  }

  /** The next `sync` shows this one leaving because it was sent. */
  markSent(id: number): void { this.sentId = id; }

  /** A different host or profile: swap the chips at once. */
  reset(): void {
    for (const { el } of this.chips.values()) el.remove();
    this.chips.clear();
  }

  sync(items: readonly Queued[], paused: boolean, error: string): void {
    const ids = new Set(items.map(item => item.id));
    for (const [id, chip] of this.chips) {
      if (ids.has(id)) continue;
      this.chips.delete(id);
      chip.el.addClass(id === this.sentId ? "is-sent" : "is-gone");
      const win = chip.el.win;
      chip.el.addEventListener("animationend", () => chip.el.remove(), { once: true });
      win.setTimeout(() => chip.el.remove(), LEAVE_MS);
    }
    items.forEach((item, at) => {
      let chip = this.chips.get(item.id);
      if (!chip) {
        const el = this.list.createDiv("hm-queue-chip");
        el.createSpan({ cls: "hm-queue-skill", text: item.skill ? `/${item.skill}` : "" });
        el.createSpan({ cls: "hm-queue-text", text: item.skill ? item.draft.replace(/^\/\S+\s*/, "") : item.draft, attr: { title: item.draft } });
        iconButton(el, "pencil", "Edit", () => this.actions.edit(item.id), "hm-queue-btn");
        iconButton(el, "x", "Remove from queue", () => this.actions.remove(item.id), "hm-queue-btn");
        chip = { el, pos: el.createSpan("hm-queue-pos") };
        el.prepend(chip.pos);
        this.chips.set(item.id, chip);
      }
      chip.pos.setText(String(at + 1));
      chip.el.toggleClass("is-next", at === 0 && !paused);
      this.list.appendChild(chip.el);
    });
    this.el.toggleClass("has-items", items.length > 0);
    this.el.toggleClass("is-paused", paused && items.length > 0);
    this.header(items.length, paused, error);
  }

  private header(count: number, paused: boolean, error: string): void {
    this.head.empty();
    if (!count) return;
    icon(this.head, paused ? "pause" : "list-plus", "hm-icon hm-queue-mark");
    this.head.createSpan({ cls: "hm-queue-title", text: paused ? `Paused · ${count}` : `Queued · ${count}` });
    if (paused && error) this.head.createSpan({ cls: "hm-queue-why", text: error });
    this.head.createSpan("hm-queue-gap");
    if (paused) iconButton(this.head, "rotate-cw", error ? "Retry" : "Resume", () => this.actions.resume(), "hm-queue-btn");
    iconButton(this.head, "trash-2", "Clear queue", () => this.actions.clear(), "hm-queue-btn");
  }
}
