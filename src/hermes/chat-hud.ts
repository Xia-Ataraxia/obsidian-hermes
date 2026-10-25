import { setTooltip } from "obsidian";
import { elapsed, type Hud, type HudItem, type HudKind } from "./hud";
import { icon } from "./ui";

const KIND_ICONS: Record<HudKind, string> = { session: "message-square", agent: "bot", job: "send", process: "terminal" };
const STATE_ICONS = { done: "check", failed: "triangle-alert" } as const;
const BUSY_MS = 6_000, IDLE_MS = 20_000;
/** A removed row plays its exit animation; this is the ceiling if `animationend` never comes (hidden window). */
const LEAVE_MS = 600;

interface Row { el: HTMLElement; mark: HTMLElement; text: HTMLElement; time: HTMLElement; item: HudItem }

/**
 * The strip under the chat log: running agents, background jobs and processes, or "Idle". Rows are keyed so one that
 * stays is patched in place and only arrivals and departures animate. The host calls `tick` every second; it keeps the
 * elapsed times moving and reads again when the last read is older than the cadence (faster while something runs).
 */
export class ChatHud {
  private readonly el: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly list: HTMLElement;
  private readonly rows = new Map<string, Row>();
  private hud: Hud | null = null;
  private readAt = 0;
  private reading = false;
  /** Bumped by `reset`, so a read that started for the previous profile lands nowhere. */
  private epoch = 0;

  constructor(parent: HTMLElement, private readonly read: () => Promise<Hud | null>, private readonly active: () => boolean) {
    this.el = parent.createDiv({ cls: "hm-hud", attr: { role: "status", "aria-label": "Running now" } });
    const bar = this.el.createDiv("hm-hud-bar");
    bar.createSpan("hm-hud-dot");
    this.summary = bar.createSpan({ cls: "hm-hud-summary" });
    const fold = this.el.createDiv("hm-hud-fold");
    this.list = fold.createDiv("hm-hud-list");
    this.render();
  }

  /** A different host or profile: drop its rows at once, read right away. */
  reset(): void {
    this.epoch++;
    this.hud = null;
    this.readAt = 0;
    this.reading = false;
    for (const row of this.rows.values()) row.el.remove();
    this.rows.clear();
    this.render();
  }

  tick(): void {
    this.times();
    const running = this.hud?.items.some(i => i.state === "running") ?? false;
    if (this.reading || !this.active() || Date.now() - this.readAt < (running ? BUSY_MS : IDLE_MS)) return;
    void this.poll();
  }

  async poll(): Promise<void> {
    const epoch = this.epoch;
    this.reading = true;
    const hud = await this.read();
    if (epoch !== this.epoch) return;
    this.reading = false;
    this.readAt = Date.now();
    // A failed read keeps what is shown until the next one.
    if (!hud) return;
    this.hud = hud;
    this.render();
  }

  /** Host clock at the time of the read, advanced by how long ago that was here. */
  private now(): number {
    return this.hud ? this.hud.at + (Date.now() - this.readAt) / 1000 : 0;
  }

  private times(): void {
    const now = this.now();
    for (const { item, time } of this.rows.values()) {
      const text = elapsed((item.ended ?? now) - item.started);
      if (time.textContent !== text) time.setText(text);
    }
  }

  private render(): void {
    const items = this.hud?.items ?? [];
    const running = items.filter(i => i.state === "running").length;
    this.el.toggleClass("has-items", items.length > 0);
    this.el.toggleClass("is-busy", running > 0);
    this.summary.setText(items.length === 0 ? "Idle · nothing running" : running === 0 ? "Just finished" : `${running} running`);
    const keep = new Set(items.map(i => i.key));
    for (const [key, row] of this.rows) {
      if (keep.has(key)) continue;
      this.rows.delete(key);
      this.leave(row.el);
    }
    for (const item of items) this.patch(this.rows.get(item.key) ?? this.enter(item), item);
    this.order(items);
    this.times();
  }

  private enter(item: HudItem): Row {
    const el = this.list.createDiv({ cls: "hm-hud-row" });
    const mark = el.createSpan("hm-hud-mark");
    const text = el.createSpan("hm-hud-text");
    const row: Row = { el, mark, text, time: el.createSpan("hm-hud-time"), item };
    el.createSpan({ cls: "hm-hud-model" });
    this.rows.set(item.key, row);
    return row;
  }

  private patch(row: Row, item: HudItem): void {
    const kindChanged = row.item.state !== item.state || row.mark.childElementCount === 0;
    row.item = item;
    row.el.toggleClass("is-running", item.state === "running");
    row.el.toggleClass("is-done", item.state === "done");
    row.el.toggleClass("is-failed", item.state === "failed");
    if (kindChanged) {
      row.mark.empty();
      icon(row.mark, item.state === "running" ? KIND_ICONS[item.kind] : STATE_ICONS[item.state]);
    }
    row.text.setText(item.detail ? `${item.label} · ${item.detail}` : item.label);
    const model = row.el.querySelector<HTMLElement>(".hm-hud-model");
    model?.setText(item.model ?? "");
    setTooltip(row.el, [item.label, item.detail, item.model].filter(Boolean).join("\n"));
  }

  /** Reorder only when the order really changed: moving a node restarts its animation. */
  private order(items: readonly HudItem[]): void {
    const want = items.map(i => this.rows.get(i.key)?.el);
    const have = Array.from(this.list.children).filter(c => !c.hasClass("is-leaving"));
    if (want.every((el, i) => el === have[i])) return;
    for (const el of want) if (el) this.list.append(el);
  }

  private leave(el: HTMLElement): void {
    el.addClass("is-leaving");
    const done = (): void => el.remove();
    el.addEventListener("animationend", done, { once: true });
    el.win.setTimeout(done, LEAVE_MS);
  }
}
