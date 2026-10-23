import { ItemView, setIcon, setTooltip, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type { HermesClient } from "./data";
import { hue } from "./geometry";

export type Layout = Record<string, [number, number]>;

/** What the plugin hands to the Hermes views. */
export interface HermesHost {
  readonly client: HermesClient;
  servers(): readonly string[];
  layout(alias: string): Layout;
  saveLayout(alias: string, layout: Layout): void;
  openSettings(): void;
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

/** Icon + short value, e.g. ⚡ 12. Tooltip carries the meaning. */
export function stat(parent: HTMLElement, name: string, value: string | number, label: string, cls = ""): HTMLElement {
  const el = parent.createSpan({ cls: `hm-stat ${cls}`.trim() });
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
  private inflight: Promise<void> | null = null;

  constructor(leaf: WorkspaceLeaf, protected readonly host: HermesHost, private readonly pollMs: number) {
    super(leaf);
  }

  /** Fetch for `alias`; return an error message or null. Must not render while `stale()` is true. */
  protected abstract pull(alias: string): Promise<string | null>;
  protected abstract render(): void;
  /** True while a drag or an edit would be clobbered by a re-render. */
  protected busy(): boolean { return false; }

  override getState(): Record<string, unknown> {
    return { ...super.getState(), alias: this.alias };
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const alias = (state as { alias?: unknown } | null)?.alias;
    if (typeof alias === "string" && alias !== this.alias) {
      this.alias = alias;
      if (this.body) void this.reload();
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
      if (!document.hidden && this.contentEl.isShown() && !this.busy()) void this.reload(true);
    }, this.pollMs));
    this.registerInterval(window.setInterval(() => this.tick(), 15_000));
    await this.reload();
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
    if (this.inflight) return this.inflight;
    if (!this.alias) {
      this.buildToolbar();
      if (!this.alias) return this.empty("server", "No SSH host", "Settings", () => this.host.openSettings());
    }
    this.refreshButton.addClass("is-spinning");
    const alias = this.alias;
    this.inflight = (async () => {
      const error = await this.pull(alias);
      if (alias !== this.alias) return;
      if (error !== null) {
        if (!quiet || this.loadedAt === 0) this.empty("wifi-off", error, "Retry", () => void this.reload());
        this.stamp.addClass("is-stale");
        setTooltip(this.stamp, error);
        return;
      }
      this.loadedAt = Date.now();
      this.stamp.removeClass("is-stale");
      this.tick();
      if (!this.busy()) this.render();
    })().finally(() => {
      this.inflight = null;
      this.refreshButton.removeClass("is-spinning");
    });
    return this.inflight;
  }

  /** Redraw from the data already loaded (e.g. after a color change). */
  repaint(): void {
    if (this.loadedAt && !this.busy()) this.render();
  }

  private tick(): void {
    if (!this.loadedAt || !this.stamp) return;
    this.stamp.setText(relative(this.loadedAt / 1000));
    setTooltip(this.stamp, `Updated ${new Date(this.loadedAt).toLocaleTimeString()}`);
  }

  protected empty(iconName: string, text: string, action?: string, onAction?: () => void): void {
    this.body.empty();
    const box = this.body.createDiv("hm-empty");
    icon(box, iconName, "hm-empty-icon");
    box.createDiv({ text });
    if (action && onAction) box.createEl("button", { text: action }).addEventListener("click", onAction);
  }
}
