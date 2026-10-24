import { Component, Menu, Modal, Notice, Scope, SuggestModal, ToggleComponent, setTooltip, type App, type ItemView } from "obsidian";
import { resolveInstant } from "../domain/instant-timezone-resolver";
import type { LedgerReadResult } from "../types/snapshot";
import { SOURCE_LABEL } from "../ui/notices";
import { ActivityPane } from "./activity-pane";
import { keepDetail } from "./cache";
import type { CronJob, Outcome, Profile } from "./data";
import { byLeastRecent, EDIT_CAP, pluginLastUsed, type Detail, type PluginInfo, type SkillInfo, type Source, type ToolUse } from "./inspect";
import { confirmed } from "./kanban-drawer";
import { renderSafe } from "./markdown";
import { SAFE_TOKEN } from "./remote";
import { absolute, avatar, type HermesHost, icon, iconButton, relative, stat } from "./ui";

type Pair = [model: string, provider: string];

/** Substring filter over [model, provider]; a typed id that matches no model is offered as custom on the current provider. */
class ModelPicker extends SuggestModal<Pair> {
  constructor(app: App, readonly pairs: Pair[], private readonly current: Pair, private readonly pick: (pair: Pair) => Promise<void>) {
    super(app);
    this.setPlaceholder("Default model");
  }

  getSuggestions(query: string): Pair[] {
    const q = query.trim();
    const hits = this.pairs.filter(pair => pair.join(" ").toLowerCase().includes(q.toLowerCase()));
    return q && !hits.some(([model]) => model === q) ? [...hits, [q, this.current[1]]] : hits;
  }

  renderSuggestion(pair: Pair, el: HTMLElement): void {
    const [model, provider] = pair;
    el.addClass("mod-complex");
    const content = el.createDiv("suggestion-content");
    content.createDiv({ cls: "suggestion-title", text: model });
    content.createDiv({ cls: "suggestion-note", text: this.pairs.includes(pair) ? provider : ["custom", provider].filter(Boolean).join(" · ") });
    if (model === this.current[0] && provider === this.current[1]) icon(el.createDiv("suggestion-aux"), "check");
  }

  onChooseSuggestion(pair: Pair): void { void this.pick(pair); }
}

type FileRead = { readonly text: string; readonly sum: string };
type Runs = { readonly at: number; readonly read: Promise<LedgerReadResult>; value?: LedgerReadResult };

/** One rail entry; `live` panes re-render on every poll. */
interface Tab {
  readonly id: string;
  readonly icon: string;
  readonly label: string;
  readonly live?: boolean;
  readonly count?: () => string;
  render(el: HTMLElement): void;
}

const SOURCES: Record<Source, readonly [icon: string, label: string]> = {
  bundled: ["package", "Built-in"], modified: ["pencil-line", "Built-in, edited here"], hub: ["globe", "Installed from the hub"],
  local: ["folder", "Local"], shared: ["share-2", "Shared with other profiles"], omh: ["puzzle", "Managed by the omh plugin"], plugin: ["puzzle", "Plugin"],
};
const sourceLabel = (skill: SkillInfo): string => skill.source === "plugin" ? `Plugin ${skill.owner ?? ""}`.trim() : SOURCES[skill.source][1];

/** What editing this skill's file means; null when nothing special. */
function hint(skill: SkillInfo): string | null {
  switch (skill.source) {
    case "bundled": return `Editing marks it modified, and hermes update stops syncing it. Run hermes skills reset ${skill.name} to restore it.`;
    case "modified": return `Locally modified. Run hermes skills reset ${skill.name} to restore the bundled copy.`;
    case "hub": return "Running hermes skills update --force may overwrite edits.";
    case "shared": return "Shared root: changes apply to every profile using it.";
    case "omh": return "Managed by the omh plugin (read-only).";
    case "plugin": return `Provided by plugin ${skill.owner ?? ""} (read-only).`;
    default: return null;
  }
}

const FILTERS = [["all", "All"], ["bundled", "Built-in"], ["modified", "Modified"], ["hub", "Hub"], ["local", "Local"], ["shared", "Shared"], ["plugin", "Plugin"], ["disabled", "Disabled only"]] as const;
type Filter = (typeof FILTERS)[number][0];
const shows = (skill: SkillInfo, filter: Filter): boolean =>
  filter === "all" || (filter === "disabled" ? !skill.enabled : filter === "plugin" ? skill.source === "plugin" || skill.source === "omh" : skill.source === filter);
const SORTS = [["category", "Category"], ["name", "Name"], ["lru", "Least recently used"], ["mru", "Recently used"]] as const;
type Sort = (typeof SORTS)[number][0];
const PLUGIN_SORTS = [["name", "Name"], ["lru", "Least recently used"]] as const;
type PluginSort = (typeof PLUGIN_SORTS)[number][0];
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const DISCARD = "Discard unsaved changes?";
/** The last tab picked, for the next modal this session. */
let lastTab = "";

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const fail = (error: unknown): Outcome => ({ ok: false, message: message(error) });
/** Epoch seconds for a stamp with a known offset; naive stamps stay raw text. */
function instant(raw: string | null): number | null {
  const at = resolveInstant(raw);
  return at?.kind === "absolute" ? at.epochMs / 1000 : null;
}
function duration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}
function skeleton(el: HTMLElement, n: number): void { for (let i = 0; i < n; i++) el.createDiv("hm-skeleton"); }
function choose<T extends string>(button: HTMLElement, options: readonly (readonly [T, string])[], current: T, pick: (value: T) => void): void {
  const menu = new Menu();
  for (const [value, label] of options) menu.addItem(item => item.setTitle(label).setChecked(value === current).onClick(() => pick(value)));
  const rect = button.getBoundingClientRect();
  menu.showAtPosition({ x: rect.left, y: rect.bottom });
}

/** One profile in a modal: header with model and profile switcher, a tab rail, and the selected pane. */
export class ProfileModal extends Modal {
  alias = "";
  profileId = "";
  private profile!: Profile;
  private now = 0;
  private detail: Detail | null = null;
  private error: string | null = null;
  /** undefined: not asked yet; null: in flight; false: the read failed. */
  private use: ToolUse | null | false | undefined = undefined;
  private tab = "";
  /** Path of the skill whose file is open. */
  private skill: string | null = null;
  private editor: { readonly path: string; readonly original: string; readonly area: HTMLTextAreaElement } | null = null;
  /** On the keymap stack while the editor is open, so Escape cancels the edit instead of closing the modal. */
  private editScope: Scope | null = null;
  private readonly files = new Map<string, Promise<FileRead | string>>();
  private readonly runCache = new Map<string, Runs>();
  /** Toggle states sent but not yet read back. */
  private readonly overrides = new Map<string, boolean>();
  private readonly jobErrors = new Map<string, string>();
  private readonly expanded = new Map<string, boolean>();
  private query = "";
  private sort: Sort = "category";
  private filter: Filter = "all";
  private pluginSort: PluginSort = "name";
  private owner = new Component();
  private opened = false;
  private asking = false;
  private head!: HTMLElement;
  private rail!: HTMLElement;
  private pane!: HTMLElement;
  private readonly tabs: readonly Tab[] = [
    { id: "activity", icon: "activity", label: "Activity", render: el => {
      const pane = new ActivityPane(this.host.activity, this.alias, this.profileId);
      pane.mount(el);
      this.owner.register(() => pane.dispose());
    } },
    { id: "skills", icon: "sparkles", label: "Skills", render: el => this.renderSkills(el),
      count: () => this.detail ? `${this.detail.skills.filter(skill => skill.enabled).length}/${this.detail.skills.length}` : String(this.profile.skills.length || "") },
    { id: "cron", icon: "alarm-clock", label: "Cron", live: true, render: el => this.renderCron(el), count: () => String(this.profile.jobs.length || "") },
    { id: "plugins", icon: "plug", label: "Plugins", render: el => this.renderPlugins(el),
      count: () => this.detail ? `${this.detail.plugins.filter(plugin => plugin.status === "enabled" || plugin.status === "provider").length}/${this.detail.plugins.length}` : "" },
    { id: "soul", icon: "heart", label: "Soul", render: el => this.renderFile(el, "SOUL.md") },
    { id: "user", icon: "user", label: "User", render: el => this.renderFile(el, "memories/USER.md") },
    { id: "memory", icon: "brain", label: "Memory", render: el => this.renderFile(el, "memories/MEMORY.md") },
  ];

  constructor(view: ItemView, _container: HTMLElement, private readonly host: HermesHost, private readonly onDone: () => void,
    private readonly peers: () => readonly Profile[], private readonly refresh: () => void) {
    super(view.app);
  }

  /** profiles-view pauses polls while this is true. */
  get editing(): boolean { return this.editor !== null; }

  show(alias: string, profile: Profile, now: number): void {
    if (!this.opened) {
      this.alias = alias; this.profile = profile; this.profileId = profile.id; this.now = now;
      this.tab = this.tabs.some(tab => tab.id === lastTab) ? lastTab : this.tabs[0]!.id;
      this.open();
      return;
    }
    if (alias === this.alias && profile.id === this.profileId) { this.update(profile, now); return; }
    this.guard(() => { this.alias = alias; this.now = now; this.switchTo(profile); });
  }

  /** Fresh data from a poll; never touches an open editor. */
  update(profile: Profile, now: number): void {
    this.profile = profile; this.profileId = profile.id; this.now = now;
    if (!this.opened) return;
    this.renderHead();
    this.renderRail();
    if (!this.editor && this.current().live) this.renderPane(true);
  }

  override close(): void {
    if (!this.opened) return;
    if (this.dirty()) { this.guard(() => this.close()); return; }
    // Off the stack now: on phones onClose waits for the close animation.
    this.opened = false; this.popEditScope();
    super.close();
  }

  override onOpen(): void {
    this.opened = true;
    // The modal lives in <body>, outside the view: hm-view brings the plugin's variables and flex column along.
    this.modalEl.addClass("hm-view", "hm-profile-modal");
    this.head = this.contentEl.createDiv("hm-drawer-head");
    const body = this.contentEl.createDiv("hm-profile-body");
    this.rail = body.createEl("nav", { cls: "hm-tabs" });
    this.pane = body.createDiv("hm-pane");
    void this.load();
    this.renderHead(); this.renderRail(); this.renderPane();
  }

  override onClose(): void {
    this.opened = false; this.editor = null; this.popEditScope();
    this.owner.unload();
    this.contentEl.empty();
    this.onDone();
  }

  /** Runs `go` now, or after the user agrees to drop unsaved edits. */
  private guard(go: () => void): void {
    if (!this.dirty()) { this.editor = null; go(); return; }
    if (this.asking) return;
    this.asking = true;
    void confirmed(this.app, DISCARD, "", "Discard", true).then(ok => { this.asking = false; if (ok) { this.editor = null; go(); } });
  }

  private dirty(): boolean { return !!this.editor && this.editor.area.value !== this.editor.original; }

  /** Safe to repeat. A scope left behind would eat Escape app-wide; popScope also removes one that isn't on top. */
  private popEditScope(): void {
    if (this.editScope) { this.app.keymap.popScope(this.editScope); this.editScope = null; }
  }

  /** The toggle state to show: the one just asked for, until a read agrees. */
  private state(key: string, actual: boolean): boolean {
    const wanted = this.overrides.get(key);
    if (wanted === undefined || wanted === actual) { this.overrides.delete(key); return actual; }
    return wanted;
  }

  private current(): Tab { return this.tabs.find(tab => tab.id === this.tab) ?? this.tabs[0]!; }

  /** The skills/plugins read; a cached one shows at once while a fresh one runs. */
  private async load(fresh = false): Promise<void> {
    const { alias, profileId } = this;
    this.detail = this.host.inspect.cached(alias, profileId) ?? this.detail;
    // Nothing in memory yet (the first open since a reload or a host switch): the rows saved last time paint meanwhile.
    if (!this.detail) void this.restore(alias, profileId).catch(console.error);
    const read = await this.host.inspect.detail(alias, profileId, fresh).catch(message);
    if (!this.opened || alias !== this.alias || profileId !== this.profileId) return;
    if (typeof read !== "string") {
      const detail = this.host.inspect.cached(alias, profileId) ?? read;
      this.detail = detail;
      this.error = null;
      // ponytail: saved on every live read, which only follows the user opening or refreshing this window.
      this.host.cache.save(alias, `inspector/${profileId}`, keepDetail(detail));
    } else if (!this.detail) this.error = read;
    this.renderRail();
    if (!this.editor && ["skills", "plugins", "cron"].includes(this.tab)) this.renderPane(true);
  }

  /** Paints the saved skill and plugin rows; the live read, which replaces them, is already on its way. */
  private async restore(alias: string, profileId: string): Promise<void> {
    const saved = await this.host.cache.load(alias, `inspector/${profileId}`);
    if (!saved || this.detail || !this.opened || alias !== this.alias || profileId !== this.profileId) return;
    const { skills, plugins } = (saved.data ?? {}) as { skills?: unknown; plugins?: unknown };
    const rows = (list: unknown): list is Record<string, unknown>[] => Array.isArray(list) && list.every((row: unknown) => typeof (row as { name?: unknown } | null)?.name === "string");
    if (!rows(skills) || !rows(plugins) || !skills.every(skill => typeof skill.source === "string" && Object.hasOwn(SOURCES, skill.source))) return;
    this.detail = saved.data as Detail;
    this.renderRail();
    if (!this.editor && ["skills", "plugins", "cron"].includes(this.tab)) this.renderPane(true);
  }

  private switchTo(profile: Profile): void {
    this.profile = profile; this.profileId = profile.id;
    this.detail = null; this.error = null; this.use = undefined; this.skill = null; this.editor = null; this.query = "";
    for (const map of [this.files, this.runCache, this.overrides, this.jobErrors, this.expanded]) map.clear();
    // ponytail: the canvas highlight follows on the next poll.
    void this.load();
    this.renderHead(); this.renderRail(); this.renderPane();
  }

  private renderHead(): void {
    const { head, profile } = this;
    head.empty();
    avatar(head, profile.id, "hm-avatar is-large");
    const title = head.createDiv("hm-drawer-title");
    const name = title.createDiv({ cls: "hm-drawer-name", text: profile.id });
    const gateway = profile.gateway;
    const platforms = Object.entries(gateway?.platforms ?? {}).map(([platform, state]) => `${platform} ${state === "connected" ? "●" : "○"}`).join("  ");
    setTooltip(name.createSpan(`hm-gw ${gateway?.alive ? "is-live" : gateway ? "is-down" : "is-none"}`),
      gateway ? `Gateway ${gateway.alive ? "live" : "down"}${platforms ? `\n${platforms}` : ""}` : "No gateway");
    const meta = title.createDiv("hm-drawer-meta");
    stat(meta, "cpu", profile.model || "—", [profile.provider, "Change default model"].filter(Boolean).join(" · "), "is-action", "button")
      .addEventListener("click", () => this.pickModel());
    for (const [platform, state] of Object.entries(gateway?.platforms ?? {})) {
      stat(meta, state === "connected" ? "wifi" : "wifi-off", platform, `${platform} · ${state}`, state === "connected" ? "is-good" : "is-muted");
    }
    const peers = this.peers();
    const nav = head.createDiv("hm-switch hm-push");
    iconButton(nav, "message-square", "Chat with this profile", () => this.guard(() => { this.close(); this.host.openChat(this.alias, this.profile.id); }));
    if (peers.length > 1) {
      const at = peers.findIndex(peer => peer.id === profile.id);
      for (const [step, glyph, label] of [[-1, "chevron-left", "Previous profile"], [1, "chevron-right", "Next profile"]] as const) {
        const peer = peers[(at + step + peers.length) % peers.length]!;
        iconButton(nav, glyph, `${label} (${peer.id})`, () => this.guard(() => this.switchTo(peer)));
      }
    }
    if (profile.description) head.createDiv({ cls: "hm-drawer-desc", text: profile.description });
  }

  /** Models in use on this host first, then the cached catalog as it arrives; the write is `hermes config set`, then a refresh. */
  private pickModel(): void {
    const { alias, profile } = this;
    const pairs: Pair[] = [];
    const add = (pair: Pair): void => { if (pair[0] && !pairs.some(([m, p]) => m === pair[0] && p === pair[1])) pairs.push(pair); };
    for (const peer of [profile, ...this.peers()]) add([peer.model, peer.provider]);
    const picker = new ModelPicker(this.app, pairs, [profile.model, profile.provider], async ([model, provider]) => {
      // A poll re-renders the head while the picker is open, so spin the stat that is there now.
      const el = this.head.querySelector(".hm-stat.is-action");
      el?.addClass("hm-spinning");
      try {
        const outcome = await this.host.client.setModel(alias, profile.id, model, provider, profile.provider);
        if (!outcome.ok) return void new Notice(outcome.message);
        this.refresh();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
      } finally {
        el?.removeClass("hm-spinning");
      }
    });
    picker.open();
    void this.host.client.models(alias, profile.id).then(catalog => {
      catalog.forEach(add);
      picker.inputEl.dispatchEvent(new Event("input"));
    }).catch(error => new Notice(error instanceof Error ? error.message : String(error)));
  }

  private renderRail(): void {
    this.rail.empty();
    for (const tab of this.tabs) {
      const active = tab.id === this.tab;
      const button = this.rail.createEl("button", { cls: `hm-tab${active ? " is-active" : ""}`, attr: active ? { "aria-current": "page" } : {} });
      icon(button, tab.icon);
      button.createSpan({ cls: "hm-tab-label", text: tab.label });
      const count = tab.count?.();
      if (count) button.createSpan({ cls: "hm-tab-count", text: count });
      setTooltip(button, tab.label, { placement: "right" });
      button.addEventListener("click", () => this.guard(() => {
        this.tab = lastTab = tab.id; this.skill = null; this.renderRail(); this.renderPane();
        // Stale after a minute. load() joins a read already in flight; load(true) is for after a write.
        if (Date.now() / 1000 - (this.host.inspect.cached(this.alias, this.profileId)?.at ?? 0) > 60) void this.load();
      }));
    }
  }

  /** Re-renders the selected tab; `keep` holds the scroll position and the search box's focus. */
  private renderPane(keep = false): void {
    const { pane } = this;
    const top = keep ? pane.scrollTop : 0;
    const typing = pane.querySelector("input:focus") !== null;
    this.popEditScope();
    this.owner.unload();
    this.owner = new Component();
    this.owner.load();
    pane.empty();
    this.current().render(pane);
    pane.scrollTop = top;
    const input = typing ? pane.querySelector<HTMLInputElement>("input[type=search]") : null;
    if (input) { input.focus(); input.selectionStart = input.value.length; }
  }

  /** Skeleton rows while the first read runs; the error with a retry once it failed. */
  private pending(el: HTMLElement, rows = 3): void {
    if (!this.error) { skeleton(el, rows); return; }
    const box = el.createDiv({ cls: "hm-error", text: this.error });
    box.createEl("button", { text: "Retry" }).addEventListener("click", () => { this.error = null; void this.load(true); this.renderPane(); });
  }

  /** A switch that never opens its row; `locked` explains why it can't change. */
  private toggle(parent: HTMLElement, on: boolean, locked: string | null, change: (on: boolean) => void, tip?: string): void {
    const wrap = parent.createSpan("hm-toggle");
    new ToggleComponent(wrap).setValue(on).setDisabled(locked !== null).onChange(change);
    const text = locked ?? tip;
    if (text) setTooltip(wrap, text);
    // Inside a <summary> a click would also fold the card: cancel that, but not on the switch itself. Obsidian's switch
    // is a <label> that flips by clicking its hidden checkbox, so cancelling a click on the label leaves it stuck.
    wrap.addEventListener("click", event => {
      event.stopPropagation();
      if (!(event.target as Element).closest("input, label")) event.preventDefault();
    });
  }

  /** A <details> whose open state survives re-renders; the body fills on first open. */
  private fold(parent: HTMLElement, key: string, cls: string, open: boolean, head: (summary: HTMLElement) => void, fill: (body: HTMLElement) => void): HTMLDetailsElement {
    const details = parent.createEl("details", { cls });
    head(details.createEl("summary"));
    const body = details.createDiv();
    let filled = false;
    const show = (): void => { if (details.open && !filled) { filled = true; fill(body); } };
    details.open = this.expanded.get(key) ?? open;
    show();
    // Setting `open` queues a toggle event too; one from a node already re-rendered away is ignored.
    details.addEventListener("toggle", () => {
      if (!details.isConnected) return;
      this.expanded.set(key, details.open);
      show();
    });
    return details;
  }

  /* ───────────── skills ───────────── */

  private renderSkills(el: HTMLElement): void {
    const { detail } = this;
    if (!detail) { this.pending(el); return; }
    const open = this.skill === null ? undefined : detail.skills.find(skill => skill.path === this.skill);
    if (open) { this.renderFile(el, open.path, open); return; }
    this.skill = null;
    const tools = el.createDiv("hm-pane-tools");
    const search = tools.createDiv("hm-search");
    icon(search, "search");
    const input = search.createEl("input", { type: "search", placeholder: "Filter skills…", value: this.query });
    const sort: HTMLButtonElement = iconButton(tools, "arrow-up-down", "Sort", () => choose(sort, SORTS, this.sort, value => { this.sort = value; this.renderPane(true); }));
    const filter: HTMLButtonElement = iconButton(tools, "filter", "Filter", () => choose(filter, FILTERS, this.filter, value => { this.filter = value; this.renderPane(true); }), this.filter === "all" ? "" : "is-active");
    const list = el.createDiv("hm-list");
    const draw = (): void => {
      list.empty();
      const q = this.query.toLowerCase();
      const shown = detail.skills.filter(skill => shows(skill, this.filter) && (!q || `${skill.name} ${skill.category} ${skill.description}`.toLowerCase().includes(q)));
      if (!shown.length) { list.createDiv({ cls: "hm-muted hm-pad", text: "No matching skills" }); return; }
      if (this.sort !== "category") {
        const order = this.sort === "name" ? (a: SkillInfo, b: SkillInfo) => a.name.localeCompare(b.name)
          : this.sort === "lru" ? byLeastRecent : (a: SkillInfo, b: SkillInfo) => byLeastRecent(b, a);
        for (const skill of [...shown].sort(order)) this.skillRow(list, skill);
        return;
      }
      const groups = new Map<string, SkillInfo[]>();
      for (const skill of shown) groups.set(skill.category || "other", [...(groups.get(skill.category || "other") ?? []), skill]);
      for (const [cat, members] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
        this.fold(list, `group:${cat}${q ? "?" : ""}`, "hm-group", groups.size <= 4 || q !== "", summary => {
          summary.createSpan({ text: cat });
          summary.createSpan({ cls: "hm-count", text: String(members.length) });
        }, body => { for (const skill of members.sort((a, b) => a.name.localeCompare(b.name))) this.skillRow(body, skill); });
      }
    };
    input.addEventListener("input", () => { this.query = input.value; draw(); });
    draw();
  }

  private skillRow(parent: HTMLElement, skill: SkillInfo): void {
    const key = `skill:${skill.path}`;
    const on = this.state(key, skill.enabled);
    const row = parent.createDiv({ cls: `hm-row${on ? "" : " is-off"}`, attr: { tabindex: "0" } });
    const openFile = (): void => { this.skill = skill.path; this.renderPane(); };
    row.addEventListener("click", openFile);
    row.addEventListener("keydown", event => { if (event.key === "Enter" && event.target === row) openFile(); });
    const top = row.createDiv("hm-row-top");
    top.createSpan({ cls: "hm-row-name", text: skill.name });
    setTooltip(icon(top, SOURCES[skill.source][0], "hm-icon hm-src"), sourceLabel(skill));
    if (skill.verdict && /caution|danger/i.test(skill.verdict)) setTooltip(icon(top, "alert-triangle", "hm-icon hm-warn"), `Hub scan: ${skill.verdict}`);
    for (const platform of skill.platformOff) setTooltip(top.createSpan({ cls: "hm-tag", text: `${platform} off` }), `Disabled on ${platform}; the global switch can't override it`);
    const used = top.createSpan({ cls: "hm-muted hm-push", text: skill.lastUsed === null ? "never" : relative(skill.lastUsed, this.now) });
    setTooltip(used, skill.lastUsed === null ? "Never used" : `${absolute(skill.lastUsed)} · ${skill.uses} uses`);
    this.toggle(top, on, skill.readOnly, value => {
      this.overrides.set(key, value);
      row.toggleClass("is-off", !value);
      const { alias, profileId } = this;
      void this.host.inspect.toggleSkill(alias, profileId, skill, value).catch(fail).then(outcome => {
        if (!outcome.ok) new Notice(outcome.message);
        if (!this.opened || alias !== this.alias || profileId !== this.profileId) return;
        if (!outcome.ok) this.overrides.delete(key);
        this.detail = this.host.inspect.cached(alias, profileId) ?? this.detail;
        this.renderRail();
        if (!this.editor && this.skill === null) this.renderPane(true);
      });
    }, "Takes effect at the next prompt build");
    if (skill.description) row.createDiv({ cls: "hm-row-desc", text: skill.description });
  }

  /* ───────────── files ───────────── */

  /** A markdown file of the profile, rendered, with an in-place editor; `skill` adds the way back and what editing it means. */
  private renderFile(el: HTMLElement, path: string, skill?: SkillInfo): void {
    const { alias, profileId } = this;
    const bar = el.createDiv("hm-doc-bar");
    if (skill) {
      iconButton(bar, "chevron-left", "Back to skills", () => this.guard(() => { this.skill = null; this.renderPane(); }));
      bar.createSpan({ cls: "hm-doc-title", text: skill.name });
    } else bar.createSpan({ cls: "hm-muted", text: path.replace("memories/", "") });
    let loaded: FileRead | null = null;
    const reload = iconButton(bar, "refresh-cw", "Reload", () => { this.files.delete(path); this.renderPane(true); }, "hm-push");
    const edit = iconButton(bar, "pencil", "Edit", () => { if (loaded) startEdit(loaded); });
    edit.disabled = true;
    if (skill) {
      const src = el.createDiv("hm-skill-src hm-muted");
      icon(src, SOURCES[skill.source][0]);
      src.createSpan({ text: `${sourceLabel(skill)} · ${this.detail ? path.replace(this.detail.home, "~") : path}` });
      const note = hint(skill);
      if (note) el.createDiv({ cls: "hm-hint", text: note });
    }
    const body = el.createDiv("hm-doc markdown-rendered");
    skeleton(body, 3);

    const startEdit = (file: FileRead): void => {
      reload.hide(); edit.hide();
      body.empty(); body.removeClass("markdown-rendered");
      const area = body.createEl("textarea", { cls: "hm-editor", text: file.text });
      const error = body.createDiv("hm-error");
      error.hide();
      this.editor = { path, original: file.text, area };
      const actions = bar.createDiv("hm-doc-actions");
      const cancel = iconButton(actions, "x", "Cancel", () => this.guard(() => this.renderPane(true)));
      const save = iconButton(actions, "check", "Save (⌘↵)", () => void doSave(), "mod-cta");
      const doSave = async (): Promise<void> => {
        if (area.value === file.text) { this.editor = null; this.renderPane(true); return; }
        save.disabled = true;
        const outcome = await this.host.inspect.save(alias, profileId, path, file.sum, area.value).catch(fail);
        save.disabled = false;
        if (!outcome.ok) { error.setText(outcome.message); error.show(); return; }
        this.files.delete(path);
        if (this.editor?.area === area) this.editor = null;
        if (!this.opened || alias !== this.alias || profileId !== this.profileId) return;
        if (skill) void this.load(true);
        if (!this.editor) this.renderPane(true);
      };
      area.addEventListener("keydown", event => {
        if (event.isComposing) return;
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save.click(); }
      });
      // Obsidian's keymap runs in the capture phase, so the modal's Escape (close) fires before any textarea listener.
      // A child scope on top takes Escape first: false stops it there; undefined during IME lets it reach the textarea.
      this.editScope = new Scope(this.scope);
      this.editScope.register([], "Escape", event => { if (event.isComposing) return; cancel.click(); return false; });
      this.app.keymap.pushScope(this.editScope);
      area.focus();
    };

    let read = this.files.get(path);
    if (!read) { read = this.host.inspect.read(alias, profileId, path).catch(message); this.files.set(path, read); }
    void read.then(file => {
      if (!body.isConnected) return;
      body.empty();
      if (typeof file === "string") {
        this.files.delete(path);
        const box = body.createDiv({ cls: "hm-error", text: file });
        box.createEl("button", { text: "Retry" }).addEventListener("click", () => this.renderPane(true));
        return;
      }
      const lock = skill && (skill.source === "omh" || skill.source === "plugin") ? hint(skill)
        : new TextEncoder().encode(file.text).length > EDIT_CAP ? "Too large to edit here (> 64 KB)" : null;
      edit.disabled = lock !== null;
      if (lock) setTooltip(edit, lock);
      loaded = file;
      const text = skill ? file.text.replace(FRONTMATTER, "") : file.text;
      if (text.trim()) void renderSafe(this.app, text, body, this.owner); else body.createDiv({ cls: "hm-muted", text: "Empty" });
    });
  }

  /* ───────────── cron ───────────── */

  private renderCron(el: HTMLElement): void {
    const jobs = [...this.profile.jobs].sort((a, b) => Number(b.enabled) - Number(a.enabled) || String(a.next ?? "~").localeCompare(String(b.next ?? "~")));
    if (!jobs.length) { el.createDiv({ cls: "hm-muted hm-pad", text: "No cron jobs" }); return; }
    for (const job of jobs) this.jobCard(el, job);
  }

  private jobCard(parent: HTMLElement, job: CronJob): void {
    const key = `job:${job.id}`;
    const on = this.state(key, job.enabled);
    const failed = !!job.error || (job.status !== null && !["ok", "success"].includes(job.status));
    const card: HTMLDetailsElement = this.fold(parent, key, `hm-job${on ? "" : " is-off"}${failed ? " is-failed" : ""}`, false, summary => {
      const top = summary.createDiv("hm-job-top");
      setTooltip(top.createSpan("hm-job-dot"), on ? `Last run: ${job.status ?? (failed ? "error" : "—")}` : "Paused");
      top.createDiv({ cls: "hm-job-name", text: job.name || job.id });
      setTooltip(top.createSpan({ cls: "hm-code", text: job.schedule }), "Schedule");
      this.toggle(top, on, job.state === "completed" ? "Completed one-shot job" : null, value => {
        this.overrides.set(key, value);
        card.toggleClass("is-off", !value);
        this.jobErrors.delete(job.id);
        const { alias, profileId } = this;
        void this.host.inspect.toggleJob(alias, profileId, job.id, value).catch(fail).then(outcome => {
          if (outcome.ok) { this.refresh(); return; }
          new Notice(outcome.message);
          if (!this.opened || alias !== this.alias || profileId !== this.profileId) return;
          this.overrides.delete(key);
          this.jobErrors.set(job.id, outcome.message);
          if (!this.editor) this.renderPane(true);
        });
      }, on ? undefined : "Schedules the next occurrence; a run missed while paused may fire once.");
      const meta = summary.createDiv("hm-job-meta");
      if (on && job.next) setTooltip(stat(meta, "timer", relative(job.next, this.now), "Next"), `Next · ${absolute(job.next)}`);
      if (job.last) setTooltip(stat(meta, "history", relative(job.last, this.now), "Last"), `Last · ${absolute(job.last)}`);
      if (job.deliver) stat(meta, "send", job.deliver, "Delivers to");
      if (job.skills.length) stat(meta, "sparkles", job.skills.join(", "), "Skills");
      const error = this.jobErrors.get(job.id) ?? job.error;
      if (error) summary.createDiv({ cls: "hm-error", text: error });
    }, body => this.runs(body, job));
  }

  /** The job's last runs from the execution ledger, cached a minute; the full history opens the job modal. */
  private runs(el: HTMLElement, job: CronJob): void {
    const list = el.createDiv("hm-runs");
    if (!this.detail) this.pending(list, 2);
    else {
      const { alias, profileId } = this;
      let entry = this.runCache.get(job.id);
      if (!entry || Date.now() - entry.at > 60_000) {
        const read = this.host.inspect.runs(alias, profileId, job.id)
          .catch((error: unknown): LedgerReadResult => ({ status: "ledger-unavailable", detail: message(error), rows: [], windowLimited: false }));
        const fresh: Runs = { at: Date.now(), read };
        void read.then(result => { fresh.value = result; });
        this.runCache.set(job.id, entry = fresh);
      }
      const draw = (result: LedgerReadResult): void => {
        if (result.status !== "read") { list.createDiv({ cls: "hm-muted", text: result.detail ?? SOURCE_LABEL[result.status] }); return; }
        if (!result.rows.length) { list.createDiv({ cls: "hm-muted", text: result.windowLimited ? "No runs in the recent window" : "No run history recorded" }); return; }
        for (const row of result.rows) {
          const line = list.createDiv(`hm-exec is-${row.status}`);
          line.createSpan("hm-exec-dot");
          const start = instant(row.startedAt ?? row.claimedAt), end = instant(row.finishedAt);
          const when = line.createSpan({ text: start === null ? row.startedAt ?? row.claimedAt ?? "—" : relative(start, this.now) });
          if (start !== null) setTooltip(when, absolute(start));
          if (start !== null && end !== null) line.createSpan({ cls: "hm-muted", text: duration(end - start) });
          const status = line.createSpan({ cls: "hm-push", text: row.statusRaw ?? row.status });
          if (row.error) setTooltip(status, row.error);
        }
      };
      if (entry.value) draw(entry.value);
      else {
        skeleton(list, 2);
        void entry.read.then(result => { if (list.isConnected) { list.empty(); draw(result); } });
      }
    }
    const button = el.createDiv("hm-job-foot").createEl("button");
    icon(button, "history");
    button.createSpan({ text: "Open full history" });
    button.addEventListener("click", () => {
      button.disabled = true;
      void this.host.inspect.job(this.alias, this.profileId, job.id).catch(message).then(found => {
        button.disabled = false;
        if (typeof found === "string") new Notice(found);
        else this.host.openJob(found.record, found.ref);
      });
    });
    if (job.prompt) {
      const prompt = el.createEl("details", { cls: "hm-prompt" });
      const summary = prompt.createEl("summary");
      icon(summary, "message-square");
      summary.createSpan({ text: job.prompt.split("\n")[0]!.slice(0, 90) });
      prompt.createEl("pre", { text: job.prompt });
    }
  }

  /* ───────────── plugins ───────────── */

  private renderPlugins(el: HTMLElement): void {
    const { detail, alias, profileId } = this;
    if (!detail) { this.pending(el); return; }
    if (this.use === undefined) {
      this.use = null;
      void this.host.inspect.tools(alias, profileId).then(use => {
        if (alias !== this.alias || profileId !== this.profileId) return;
        this.use = use ?? false;
        if (this.opened && this.tab === "plugins" && !this.editor) this.renderPane(true);
      });
    }
    const tools = el.createDiv("hm-pane-tools");
    const sort: HTMLButtonElement = iconButton(tools, "arrow-up-down", "Sort", () => choose(sort, PLUGIN_SORTS, this.pluginSort, value => { this.pluginSort = value; this.renderPane(true); }), "hm-push");
    if (!detail.plugins.length) { el.createDiv({ cls: "hm-muted hm-pad", text: "No plugins" }); return; }
    const use = this.use;
    const last = (plugin: PluginInfo): number | null => use ? pluginLastUsed(plugin, use, detail.skills) : null;
    const order = this.pluginSort === "lru"
      ? (a: PluginInfo, b: PluginInfo) => (last(a) ?? -Infinity) - (last(b) ?? -Infinity) || a.name.localeCompare(b.name)
      : (a: PluginInfo, b: PluginInfo) => a.name.localeCompare(b.name);
    for (const plugin of [...detail.plugins].sort(order)) this.pluginRow(el, plugin, last(plugin));
  }

  private pluginRow(parent: HTMLElement, plugin: PluginInfo, last: number | null): void {
    const provider = plugin.status === "provider" || !!plugin.readOnly?.includes("memory.provider");
    const on = this.state(`plugin:${plugin.key}`, plugin.status === "enabled" || provider);
    this.fold(parent, `plugin:${plugin.key}`, `hm-row hm-plugin${on ? "" : " is-off"}`, false, summary => {
      const top = summary.createDiv("hm-row-top");
      setTooltip(icon(top, provider ? "brain" : "puzzle", "hm-icon hm-src"), provider ? "Memory provider" : "Plugin");
      top.createSpan({ cls: "hm-row-name", text: plugin.name });
      if (plugin.version) top.createSpan({ cls: "hm-muted", text: plugin.version });
      if (provider) top.createSpan({ cls: "hm-tag", text: "Provider" });
      const hookOnly = plugin.hooks.length > 0 && !plugin.tools.length && !plugin.skills;
      const [text, tip] = this.use === false ? ["Usage unavailable", ""] : !this.use ? ["…", ""]
        : last !== null ? [relative(last, this.now), `Last used · ${absolute(last)}`]
        : hookOnly ? ["—", "Hooks leave no usage record"] : ["30d+", "No use in the last 30 days"];
      const used = top.createSpan({ cls: "hm-muted hm-push", text });
      if (tip) setTooltip(used, tip);
      this.toggle(top, on, plugin.readOnly, value => this.confirmPlugin(plugin, value, last), "Applies to new sessions");
      if (plugin.description) summary.createDiv({ cls: "hm-row-desc", text: plugin.description });
    }, body => {
      const kv = body.createDiv("hm-kv");
      const pair = (label: string, value: string): void => { if (value) { kv.createDiv({ cls: "hm-muted", text: label }); kv.createDiv({ text: value }); } };
      pair("Provides", [plugin.tools.join(", "), plugin.hooks.length ? `${plugin.hooks.length} hooks` : "", plugin.skills ? `${plugin.skills} skills` : ""].filter(Boolean).join(" · "));
      pair("Settings", plugin.settings.map(([k, v]) => `${k}  ${v}`).join("\n"));
      pair("Env", plugin.env.map(name => `${name} (in .env)`).join("\n"));
      pair("Source", plugin.source ?? "");
      pair("Kind", `${plugin.kind} · ${plugin.origin}`);
      body.createDiv({ cls: "hm-foot hm-muted", text: "Settings are read-only here. Edit them in config.yaml or the Hermes dashboard." });
    });
  }

  /** Plugin switches reload the shared gateway, so they ask first; no puts the switch back. */
  private confirmPlugin(plugin: PluginInfo, on: boolean, last: number | null): void {
    const key = `plugin:${plugin.key}`;
    const rel = last === null ? null : relative(last, this.now);
    const text = "Hermes reloads the running gateway, which serves all profiles. Applies to new sessions."
      + (rel ? ` Last used ${rel === "now" ? "just now" : `${rel} ago`}.` : "");
    void confirmed(this.app, `${on ? "Enable" : "Disable"} ${plugin.name}?`, text, on ? "Enable" : "Disable").then(ok => {
      if (!ok) { if (this.opened) this.renderPane(true); return; }
      this.overrides.set(key, on);
      const { alias, profileId } = this;
      void this.host.inspect.togglePlugin(alias, profileId, plugin, on).catch(fail).then(outcome => {
        if (!outcome.ok) new Notice(outcome.message);
        else if ("ungranted" in outcome) new Notice(`${plugin.name} is on, but its capabilities stay off until granted. Grant them once in a terminal${SAFE_TOKEN.test(plugin.key) ? `: hermes -p ${profileId} plugins enable ${plugin.key}` : " with hermes plugins enable."}`, 10_000);
        if (!this.opened || alias !== this.alias || profileId !== this.profileId) return;
        if (!outcome.ok) this.overrides.delete(key);
        this.detail = this.host.inspect.cached(alias, profileId) ?? this.detail;
        this.renderRail();
        if (!this.editor) this.renderPane(true);
      });
    });
  }
}

export { ProfileModal as Inspector };
