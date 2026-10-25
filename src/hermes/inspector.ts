import { Component, Modal, Notice, Scope, ToggleComponent, setTooltip, type ItemView } from "obsidian";
import { ActivityPane } from "./activity-pane";
import { keepDetail } from "./cache";
import type { CronJob, Profile } from "./data";
import { type Detail, type PluginInfo, type SkillInfo, type ToolUse } from "./inspect";
import { confirmed } from "./kanban-drawer";
import { avatar, type HermesHost, icon, iconButton, stat } from "./ui";
import { ModelPicker, type Pair } from "./inspector-picker";
import { DISCARD, type FileRead, type Filter, type PluginSort, type Runs, SOURCES, type Sort, type Tab, message, skeleton } from "./inspector-common";
import { renderSkills, skillRow, renderFile } from "./inspector-skills";
import { renderCron, jobCard, renderRuns } from "./inspector-cron";
import { renderPlugins, pluginRow, confirmPlugin } from "./inspector-plugins";

/** The last tab picked, for the next modal this session. */
let lastTab = "";
/** One profile in a modal: header with model and profile switcher, a tab rail, and the selected pane. */
export class ProfileModal extends Modal {
  alias = "";
  profileId = "";
  profile!: Profile;
  now = 0;
  detail: Detail | null = null;
  error: string | null = null;
  /** undefined: not asked yet; null: in flight; false: the read failed. */
  use: ToolUse | null | false | undefined = undefined;
  tab = "";
  /** Path of the skill whose file is open. */
  skill: string | null = null;
  editor: { readonly path: string; readonly original: string; readonly area: HTMLTextAreaElement } | null = null;
  /** On the keymap stack while the editor is open, so Escape cancels the edit instead of closing the modal. */
  editScope: Scope | null = null;
  /** On the modal's document while editScope is pushed. Obsidian keeps Tab inside a modal only while the modal's own
   *  scope is on top (no public setter for another scope), so Tab could walk out and the next one indent a note. */
  readonly keepFocus = (event: FocusEvent): void => {
    if (this.editor && !(event.target as Element).closest(".modal-container, .menu")) this.editor.area.focus();
  };
  readonly files = new Map<string, Promise<FileRead | string>>();
  readonly runCache = new Map<string, Runs>();
  /** Toggle states sent but not yet read back. */
  readonly overrides = new Map<string, boolean>();
  readonly jobErrors = new Map<string, string>();
  readonly expanded = new Map<string, boolean>();
  query = "";
  sort: Sort = "category";
  filter: Filter = "all";
  pluginSort: PluginSort = "name";
  owner = new Component();
  opened = false;
  asking = false;
  head!: HTMLElement;
  rail!: HTMLElement;
  pane!: HTMLElement;
  readonly tabs: readonly Tab[] = [
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

  constructor(view: ItemView, _container: HTMLElement, readonly host: HermesHost, readonly onDone: () => void,
    readonly peers: () => readonly Profile[], readonly refresh: () => void) {
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
  guard(go: () => void): void {
    if (!this.dirty()) { this.editor = null; go(); return; }
    if (this.asking) return;
    this.asking = true;
    void confirmed(this.app, DISCARD, "", "Discard", true).then(ok => { this.asking = false; if (ok) { this.editor = null; go(); } });
  }

  dirty(): boolean { return !!this.editor && this.editor.area.value !== this.editor.original; }

  /** Safe to repeat. A scope left behind would eat Escape app-wide; popScope also removes one that isn't on top. */
  popEditScope(): void {
    if (this.editScope) { this.app.keymap.popScope(this.editScope); this.editScope = null; }
    this.modalEl.doc.removeEventListener("focusin", this.keepFocus, true);
  }

  /** The toggle state to show: the one just asked for, until a read agrees. */
  state(key: string, actual: boolean): boolean {
    const wanted = this.overrides.get(key);
    if (wanted === undefined || wanted === actual) { this.overrides.delete(key); return actual; }
    return wanted;
  }

  current(): Tab { return this.tabs.find(tab => tab.id === this.tab) ?? this.tabs[0]!; }

  /** The skills/plugins read; a cached one shows at once while a fresh one runs. */
  async load(fresh = false): Promise<void> {
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
  async restore(alias: string, profileId: string): Promise<void> {
    const saved = await this.host.cache.load(alias, `inspector/${profileId}`);
    if (!saved || this.detail || !this.opened || alias !== this.alias || profileId !== this.profileId) return;
    const { skills, plugins } = (saved.data ?? {}) as { skills?: unknown; plugins?: unknown };
    const rows = (list: unknown): list is Record<string, unknown>[] => Array.isArray(list) && list.every((row: unknown) => typeof (row as { name?: unknown } | null)?.name === "string");
    if (!rows(skills) || !rows(plugins) || !skills.every(skill => typeof skill.source === "string" && Object.hasOwn(SOURCES, skill.source))) return;
    this.detail = saved.data as Detail;
    this.renderRail();
    if (!this.editor && ["skills", "plugins", "cron"].includes(this.tab)) this.renderPane(true);
  }

  switchTo(profile: Profile): void {
    this.profile = profile; this.profileId = profile.id;
    this.detail = null; this.error = null; this.use = undefined; this.skill = null; this.editor = null; this.query = "";
    for (const map of [this.files, this.runCache, this.overrides, this.jobErrors, this.expanded]) map.clear();
    // ponytail: the canvas highlight follows on the next poll.
    void this.load();
    this.renderHead(); this.renderRail(); this.renderPane();
  }

  renderHead(): void {
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
  pickModel(): void {
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

  renderRail(): void {
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
  renderPane(keep = false): void {
    const { pane } = this;
    const top = keep ? pane.scrollTop : 0;
    const typing = pane.querySelector("input:focus") !== null;
    pane.toggleClass("is-switching", !keep);
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
  pending(el: HTMLElement, rows = 3): void {
    if (!this.error) { skeleton(el, rows); return; }
    const box = el.createDiv({ cls: "hm-error", text: this.error });
    box.createEl("button", { text: "Retry" }).addEventListener("click", () => { this.error = null; void this.load(true); this.renderPane(); });
  }

  /** A switch that never opens its row; `locked` explains why it can't change. */
  toggle(parent: HTMLElement, on: boolean, locked: string | null, change: (on: boolean) => void, tip?: string): void {
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
  fold(parent: HTMLElement, key: string, cls: string, open: boolean, head: (summary: HTMLElement) => void, fill: (body: HTMLElement) => void): HTMLDetailsElement {
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

  renderSkills(el: HTMLElement): void { return renderSkills.call(this, el); }

  skillRow(parent: HTMLElement, skill: SkillInfo): void { return skillRow.call(this, parent, skill); }

  /* ───────────── files ───────────── */

  /** A markdown file of the profile, rendered, with an in-place editor; `skill` adds the way back and what editing it means. */
  renderFile(el: HTMLElement, path: string, skill?: SkillInfo): void { return renderFile.call(this, el, path, skill); }

  /* ───────────── cron ───────────── */

  renderCron(el: HTMLElement): void { return renderCron.call(this, el); }

  jobCard(parent: HTMLElement, job: CronJob): void { return jobCard.call(this, parent, job); }

  /** The job's last runs from the execution ledger, cached a minute; the full history opens the job modal. */
  runs(el: HTMLElement, job: CronJob): void { return renderRuns.call(this, el, job); }

  /* ───────────── plugins ───────────── */

  renderPlugins(el: HTMLElement): void { return renderPlugins.call(this, el); }

  pluginRow(parent: HTMLElement, plugin: PluginInfo, last: number | null): void { return pluginRow.call(this, parent, plugin, last); }

  /** Plugin switches reload the shared gateway, so they ask first; no puts the switch back. */
  confirmPlugin(plugin: PluginInfo, on: boolean, last: number | null): void { return confirmPlugin.call(this, plugin, on, last); }
}

export { ProfileModal as Inspector };
