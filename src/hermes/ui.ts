import { ItemView, Notice, setIcon, setTooltip, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type { CronJobRecord, ProfileRef } from "../types/hermes-cron";
import type { EdgeMode } from "../types/snapshot";
import type { ActivityClient } from "./activity";
import type { DiskCache } from "./cache";
import type { HermesClient } from "./data";
import { hue } from "./geometry";
import { plainWhy } from "./send-queue";
import type { InspectClient } from "./inspect";
import type { KanbanClient } from "./kanban";

export type Layout = Record<string, [number, number]>;

/** What the plugin hands to the Hermes views. */
export interface HermesHost {
  readonly client: HermesClient;
  servers(): readonly string[];
  layout(alias: string): Layout;
  saveLayout(alias: string, layout: Layout): void;
  edgeMode(): EdgeMode;
  setEdgeMode(mode: EdgeMode): void;
  openSettings(): void;
  readonly chat: import("./chat").HermesChat;
  readonly kanban: KanbanClient;
  /** Last board shown on this host ("default" when none). */
  board(alias: string): string;
  saveBoard(alias: string, slug: string): void;
  readonly inspect: InspectClient;
  /** The last data each view showed, per host; see cache.ts. */
  readonly cache: DiskCache;
  openJob(job: CronJobRecord, profile: ProfileRef): void;
  openChat(alias: string, profile: string): void;
  readonly activity: ActivityClient;
}

/* ───────────── small DOM helpers ───────────── */

export function icon(parent: HTMLElement, name: string, cls = "hm-icon"): HTMLElement {
  const el = parent.createSpan({ cls });
  setIcon(el, name);
  return el;
}

/** Icon-only button with a tooltip; the tooltip is the only text. */
export function iconButton(parent: HTMLElement, name: string, label: string, onClick: (event: MouseEvent) => void, cls = ""): HTMLButtonElement {
  const button = parent.createEl("button", { cls: `hm-icon-btn clickable-icon ${cls}`.trim(), attr: { "aria-label": label } });
  setIcon(button, name);
  setTooltip(button, label);
  button.addEventListener("click", event => { event.stopPropagation(); onClick(event); });
  return button;
}

/** Icon, one line of copy, an optional action and the raw detail behind Details. */
export function emptyBox(parent: HTMLElement, iconName: string, text: string, action?: string, onAction?: () => void, detail?: string, cls = ""): HTMLElement {
  const box = parent.createDiv(`hm-empty ${cls}`.trim());
  icon(box, iconName, "hm-empty-icon");
  box.createDiv({ text });
  if (action && onAction) box.createEl("button", { text: action }).addEventListener("click", onAction);
  if (detail) {
    const more = box.createEl("details", { cls: "hm-empty-more" });
    more.createEl("summary", { text: "Details" });
    more.createEl("pre", { text: detail });
  }
  return box;
}

/** A failed read inside a pane: plain copy, Retry, and the raw error behind Details. */
export function failBox(parent: HTMLElement, error: string, retry: () => void): HTMLElement {
  const why = plainWhy(error);
  return emptyBox(parent, why === "Can't reach Hermes" ? "wifi-off" : "triangle-alert", why, "Retry", retry, error, "is-inline");
}

/** Icon + short value, e.g. ⚡ 12. Tooltip carries the meaning. */
export function stat(parent: HTMLElement, name: string, value: string | number, label: string, cls = "", tag: "span" | "button" = "span"): HTMLElement {
  const el = parent.createEl(tag, { cls: `hm-stat ${cls}`.trim() });
  icon(el, name);
  el.createSpan({ text: String(value) });
  setTooltip(el, label);
  return el;
}

export function avatar(parent: HTMLElement, name: string, cls = "hm-avatar"): HTMLElement {
  const el = parent.createSpan({ cls, text: (name[0] ?? "?").toUpperCase() });
  el.style.setProperty("--hue", String(Math.round(hue(name))));
  return el;
}

/* ───────────── formatting ───────────── */

export function compact(value: number): string {
  if (value < 1000) return String(Math.round(value));
  const units = ["k", "M", "B"];
  let n = value, unit = -1;
  while (n >= 1000 && unit < units.length - 1) { n /= 1000; unit++; }
  return `${n >= 100 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, "")}${units[unit]}`;
}

/** Epoch seconds or ISO text → seconds. */
export function seconds(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value > 1e12 ? value / 1000 : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed / 1000;
}

/** "5m", "3h", "2d" in the past; "in 5m" in the future. */
export function relative(value: number | string | null | undefined, now = Date.now() / 1000): string {
  const at = seconds(value);
  if (at === null) return "—";
  const delta = Math.abs(now - at);
  const text = delta < 60 ? "now" : delta < 3600 ? `${Math.floor(delta / 60)}m` : delta < 86400 ? `${Math.floor(delta / 3600)}h` : `${Math.floor(delta / 86400)}d`;
  return text === "now" ? text : at > now ? `in ${text}` : text;
}

export function absolute(value: number | string | null | undefined): string {
  const at = seconds(value);
  return at === null ? "" : new Date(at * 1000).toLocaleString();
}

/* ───────────── base view ───────────── */

/**
 * Shared shell for the Hermes views: server switch, refresh, freshness stamp and a polling loop
 * that only runs while the leaf is visible and the user is not mid-gesture.
 */
export abstract class HermesView extends ItemView {
  protected alias = "";
  protected toolbar!: HTMLElement;
  protected tools!: HTMLElement;
  protected body!: HTMLElement;
  private stamp!: HTMLElement;
  private refreshButton!: HTMLElement;
  private loadedAt = 0;
  protected inflight: Promise<void> | null = null;
  /** A non-quiet reload came in mid-pull; that pull may predate a write, so pull once more after it. */
  private again = false;
  /** The host and key the screen shows; a change drops what was loaded and restores the saved copy of the new one. */
  private ctx = "";
  /** The data on screen came from disk, not from a pull (only the stamp tooltip says so). */
  private fromCache = false;
  /** When the disk copy of this ctx was last written (or read); see `save`. */
  private savedAt = 0;
  private restoring: Promise<void> = Promise.resolve();
  /** Set by onClose: from then on nothing starts an ssh read or paints into the detached container. A subclass checks it after its own awaits. */
  protected closed = false;

  constructor(leaf: WorkspaceLeaf, protected readonly host: HermesHost, private readonly pollMs: number) {
    super(leaf);
  }

  /** Fetch for `alias`; return an error message or null. Must not render while `stale()` is true. */
  protected abstract pull(alias: string): Promise<string | null>;
  protected abstract render(): void;
  /** True while a drag or an edit would be clobbered by a re-render. */
  protected busy(): boolean { return false; }
  /** Where this view keeps its last-seen data under the host, or null to keep none. */
  protected cacheKey(): string | null { return null; }
  /** What to keep after a successful pull; build it with a keep* function from cache.ts. */
  protected cacheData(): unknown { return null; }
  /**
   * Called on every host or key change with the saved data, or null on a miss. It must replace what the view
   * holds (so null drops the previous host's data) and return true when there is something to show.
   * A host change also calls it with null at once, before the saved copy loads.
   */
  protected cacheRestore(_saved: unknown): boolean { return false; }
  /** Called at once when the host changes: close or clear what only fits the old host (a drawer, a selection). */
  protected leaveHost(): void { /* nothing by default */ }

  override getState(): Record<string, unknown> {
    return { ...super.getState(), alias: this.alias };
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const alias = (state as { alias?: unknown } | null)?.alias;
    // A saved layout may name a host removed since; the view then stays on a registered one.
    if (typeof alias === "string" && this.host.servers().includes(alias)) {
      if (alias !== this.alias) {
        this.alias = alias;
        if (this.body) void this.reload();
      }
      // The toolbar was built before this alias arrived (ChatView sets it before calling here).
      const select = this.toolbar?.querySelector<HTMLSelectElement>("select.hm-server");
      if (select) select.value = alias;
    }
    await super.setState(state, result);
  }

  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("hm-view");
    this.toolbar = this.contentEl.createDiv("hm-toolbar");
    this.body = this.contentEl.createDiv("hm-body");
    this.buildToolbar();
    this.registerInterval(window.setInterval(() => {
      if (!this.contentEl.doc.hidden && this.contentEl.isShown() && !this.busy()) void this.reload(true);
    }, this.pollMs));
    this.registerInterval(window.setInterval(() => this.tick(), 15_000));
    // Not awaited: Obsidian holds the tab blank (and its saved state) until onOpen resolves.
    void this.reload();
  }

  override async onClose(): Promise<void> {
    this.closed = true;
    await super.onClose();
  }

  private buildToolbar(): void {
    this.toolbar.empty();
    const servers = this.host.servers();
    if (!servers.includes(this.alias)) this.alias = servers[0] ?? "";
    if (servers.length > 1) {
      const select = this.toolbar.createEl("select", { cls: "dropdown hm-server" });
      setTooltip(select, "SSH host");
      for (const server of servers) select.createEl("option", { text: server, value: server });
      select.value = this.alias;
      select.addEventListener("change", () => { this.alias = select.value; this.app.workspace.requestSaveLayout(); void this.reload(); });
    }
    this.tools = this.toolbar.createDiv("hm-tools");
    const end = this.toolbar.createDiv("hm-toolbar-end");
    this.stamp = end.createSpan("hm-stamp");
    this.refreshButton = iconButton(end, "refresh-cw", "Refresh", () => void this.reload());
  }

  protected async reload(quiet = false): Promise<void> {
    if (this.closed) return;
    if (!this.alias) this.buildToolbar();
    const entered = this.enter();
    if (this.inflight) {
      // A new host or key still owes its pull, however the reload came in.
      if (!quiet || entered) this.again = true;
      return this.inflight;
    }
    if (!this.alias) return this.empty("server", "No SSH host", "Settings", () => this.host.openSettings());
    this.refreshButton.addClass("hm-spinning");
    if (!quiet && !entered && !this.loadedAt) this.empty("loader", "Loading…");
    const { alias, ctx } = this;
    this.inflight = (async () => {
      await this.restoring;
      if (this.closed || ctx !== this.ctx) return;
      const error = await this.pull(alias).catch((e: unknown) => e instanceof Error ? e.message : String(e));
      if (this.closed || ctx !== this.ctx) return;
      if (error !== null) {
        // Whatever is on screen, saved or live, stays; only an empty view shows the error in its place.
        if (!this.loadedAt) this.fail("wifi-off", error);
        else if (!quiet && !this.again) new Notice(`${plainWhy(error)}. Showing the last update.`, 10_000);
        this.stamp.addClass("is-stale");
        setTooltip(this.stamp, `${plainWhy(error)}\n${error}`);
        return;
      }
      this.loadedAt = Date.now();
      this.fromCache = false;
      this.stamp.removeClass("is-stale");
      this.tick();
      // Before render: a view may change its cards in place once they are drawn.
      this.save();
      if (!this.busy()) this.render();
    })().catch((e: unknown) => {
      console.error(e);
      if (!this.closed) this.fail("triangle-alert", e instanceof Error ? e.message : String(e));
    }).finally(() => {
      this.inflight = null;
      if (this.closed) return;
      this.refreshButton.removeClass("hm-spinning");
      if (this.again) { this.again = false; void this.reload(); }
    });
    return this.inflight;
  }

  /** True when the host or key changed: drops what was loaded and starts restoring the saved copy of the new one. */
  private enter(): boolean {
    if (!this.alias) return false;
    const key = this.cacheKey(), ctx = `${this.alias}\0${key ?? ""}`;
    if (ctx === this.ctx) return false;
    // A new key on the same host keeps the screen until its saved copy lands; a new host must not.
    const moved = this.ctx !== "" && !this.ctx.startsWith(`${this.alias}\0`);
    this.ctx = ctx;
    this.loadedAt = this.savedAt = 0;
    this.fromCache = false;
    // No age or warning left over from the previous host.
    this.stamp.setText("");
    this.stamp.removeClass("is-stale");
    if (moved) {
      // At once, so nothing of the old host is clickable while the new one loads: a write would send its board and task ids on.
      this.leaveHost();
      this.cacheRestore(null);
      this.empty("loader", "Loading…");
    }
    const alias = this.alias;
    this.restoring = (async () => {
      const saved = key ? await this.host.cache.load(alias, key) : null;
      // Closed or switched away meanwhile, or fresher data landed first.
      if (this.closed || ctx !== this.ctx || this.loadedAt) return;
      try {
        // The hook runs on a miss too, to drop the previous host's data.
        if (this.cacheRestore(saved ? saved.data : null) && saved) {
          this.loadedAt = this.savedAt = saved.at;
          this.fromCache = true;
          this.tick();
          if (!this.busy()) this.render();
          return;
        }
      } catch (e) {
        // A copy of another shape reads as a miss, so it can never leave the view half drawn.
        console.error(e);
        this.loadedAt = this.savedAt = 0;
        this.fromCache = false;
        this.stamp.setText("");
        this.cacheRestore(null);
      }
      this.empty("loader", "Loading…");
    })().catch(console.error);
    return true;
  }

  private save(): void {
    const key = this.cacheKey(), data = key ? this.cacheData() : null;
    // ponytail: one write per host and key, then at most one per 5 min, so the disk lags the screen by up to that much.
    if (!key || data == null || Date.now() - this.savedAt < 5 * 60_000) return;
    this.savedAt = Date.now();
    this.host.cache.save(this.alias, key, data);
  }

  /** Redraw from the data already loaded (e.g. after a color change). */
  repaint(): void {
    if (this.loadedAt && !this.busy()) this.render();
  }

  /** Settings changed the host list: rebuild the switch, move off a removed host and pull. */
  serversChanged(): void {
    if (this.closed || !this.toolbar) return;
    const alias = this.alias;
    this.buildToolbar();
    // The rebuilt toolbar has an empty `tools`; a render refills it. A new host is cleared by reload instead.
    if (this.alias === alias) this.repaint();
    void this.reload();
  }

  private tick(): void {
    if (!this.loadedAt || !this.stamp) return;
    this.stamp.setText(relative(this.loadedAt / 1000));
    // A failed pull left its error as the tooltip; keep it.
    if (this.stamp.hasClass("is-stale")) return;
    setTooltip(this.stamp, `${this.fromCache ? "Cached ·" : "Updated"} ${new Date(this.loadedAt).toLocaleTimeString()}`);
  }

  protected empty(iconName: string, text: string, action?: string, onAction?: () => void, detail?: string): void {
    this.body.empty();
    emptyBox(this.body, iconName, text, action, onAction, detail);
  }

  /** A failure reads as plain copy; the raw error waits behind Details. */
  protected fail(iconName: string, error: string): void {
    this.empty(iconName, plainWhy(error), "Retry", () => void this.reload(), error);
  }
}
