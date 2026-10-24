import { Plugin, type App, type WorkspaceLeaf } from "obsidian";
import type { ObsidianSettingsAccess, TargetChangeResult } from "./types/contracts";
import { DEFAULT_SETTINGS, type EdgeMode, type ViewerSettings } from "./types/snapshot";
import { ControlCenterProcesses } from "./ui/control-center-processes";
import { SshReadOnlyAdapter } from "./ui/ssh-read-only-adapter";
import { ViewerState } from "./ui/viewer-state";
import { TODAY_TIMELINE_VIEW, TodayTimelineView } from "./ui/today-timeline-view";
import { WEEK_CALENDAR_VIEW, WeekCalendarView } from "./ui/week-calendar-view";
import { HermesCronSettingsTab } from "./ui/settings-tab";
import { Logger } from "./utils/logger";
import { RefreshScheduler } from "./ui/refresh-scheduler";
import { SnapshotDiskStore } from "./ui/snapshot-disk-store";
import { PluginDataGateway } from "./ui/plugin-data-gateway";
import { ControlCenterTargets } from "./ui/control-center-targets";
import { HermesClient } from "./hermes/data";
import { hues } from "./hermes/geometry";
import { KanbanClient, stuck } from "./hermes/kanban";
import { KANBAN_VIEW, KanbanView, noticeStuck } from "./hermes/kanban-view";
import { PROFILES_VIEW, ProfilesView } from "./hermes/profiles-view";
import { HermesView, type HermesHost, type Layout } from "./hermes/ui";

interface PersistedData {
  readonly settings?: Partial<ViewerSettings>;
  readonly remoteHomes?: Record<string, string>;
  readonly hermesLayouts?: Record<string, Layout>;
  readonly hermesHues?: Record<string, number>;
  readonly hermesBoards?: Record<string, string>;
}

/** Wiring only: construct collaborators, register views and commands, restore persisted data. */
export default class HermesCronViewerPlugin extends Plugin {
  override settings: ViewerSettings = DEFAULT_SETTINGS;
  adapter!: SshReadOnlyAdapter;
  state!: ViewerState;
  scheduler!: RefreshScheduler;
  private readonly logger = new Logger();
  private remoteHomes: Record<string, string> = {};
  private store!: SnapshotDiskStore;
  private data!: PluginDataGateway;
  private layouts: Record<string, Layout> = {};
  private boards: Record<string, string> = {};
  /** Watcher cursors per host and board; in memory only. */
  private cursors: Record<string, Record<string, number>> = {};
  private readonly watching = new Set<string>();
  /** Set first in onunload(), so a watcher read still in flight writes no cursors and shows no notices. */
  private unloaded = false;
  private kanban!: KanbanClient;
  readonly processes = new ControlCenterProcesses();
  readonly targets = new ControlCenterTargets({
    settings: () => this.settings,
    close: async () => true,
    cancel: alias => this.processes.cancel(alias),
    save: settings => this.saveSettings(settings),
    forget: alias => this.forgetServer(alias),
  });

  override async onload(): Promise<void> {
    this.data = new PluginDataGateway(this);
    const data = await this.data.read<PersistedData & Record<string, unknown>>();
    this.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };
    this.remoteHomes = { ...(data.remoteHomes ?? {}) };
    this.layouts = { ...(data.hermesLayouts ?? {}) };
    this.boards = { ...(data.hermesBoards ?? {}) };
    for (const [id, h] of Object.entries(data.hermesHues ?? {})) hues.set(id, h);

    this.adapter = new SshReadOnlyAdapter({ runner: this.processes.runner });
    this.kanban = new KanbanClient(this.adapter, new SshReadOnlyAdapter({ runner: this.processes.runner, timeoutMs: 120_000 }));
    this.state = new ViewerState(this.adapter, this.settings, this.logger);
    for (const [alias, home] of Object.entries(this.remoteHomes)) {
      this.state.rememberHome(alias, home);
    }

    this.store = new SnapshotDiskStore(this.data);
    this.state.setPersistSink((snapshots, isCurrent) => this.store.save(snapshots, isCurrent));
    this.state.restore(await this.store.load());

    this.scheduler = new RefreshScheduler(
      () => this.state.refresh(),
      this.settings.autoRefreshSeconds * 1000,
    );
    this.state.scheduler = this.scheduler;

    this.registerView(TODAY_TIMELINE_VIEW, (leaf) => new TodayTimelineView(leaf, this.state));
    this.registerView(WEEK_CALENDAR_VIEW, (leaf) => new WeekCalendarView(leaf, this.state));

    this.addRibbonIcon("clock", "Hermes: Today", () => {
      void this.activateView(TODAY_TIMELINE_VIEW, "right");
    });
    this.addRibbonIcon("settings", "Hermes: Settings", () => {
      this.openSettings();
    });

    this.addCommand({
      id: "open-today-timeline",
      name: "Open today timeline",
      callback: () => void this.activateView(TODAY_TIMELINE_VIEW, "right"),
    });
    this.addCommand({
      id: "open-week-calendar",
      name: "Open week calendar",
      callback: () => void this.activateView(WEEK_CALENDAR_VIEW, "tab"),
    });
    this.addCommand({
      id: "refresh-now",
      name: "Refresh now",
      callback: () => this.scheduler.trigger(),
    });
    this.addCommand({
      id: "open-settings",
      name: "Open settings",
      callback: () => this.openSettings(),
    });

    const host: HermesHost = {
      client: new HermesClient(this.adapter),
      servers: () => this.settings.servers,
      layout: alias => this.layouts[alias] ?? {},
      saveLayout: (alias, layout) => {
        this.layouts[alias] = layout;
        void this.data.update<Record<string, unknown>>(current => ({ ...current, hermesLayouts: this.layouts }));
      },
      edgeMode: () => this.settings.edgeMode,
      setEdgeMode: mode => this.setEdgeMode(mode),
      openSettings: () => this.openSettings(),
      kanban: this.kanban,
      board: alias => this.boards[alias] ?? "default",
      saveBoard: (alias, slug) => {
        this.boards[alias] = slug;
        void this.data.update<Record<string, unknown>>(current => ({ ...current, hermesBoards: this.boards }));
      },
    };
    this.registerView(KANBAN_VIEW, leaf => new KanbanView(leaf, host));
    this.registerView(PROFILES_VIEW, leaf => new ProfilesView(leaf, host));
    this.addRibbonIcon("square-kanban", "Hermes: Kanban", () => void this.openHermes(KANBAN_VIEW));
    this.addRibbonIcon("network", "Hermes: Profiles", () => void this.openHermes(PROFILES_VIEW));
    this.addCommand({ id: "open-hermes-kanban", name: "Open kanban", callback: () => void this.openHermes(KANBAN_VIEW) });
    this.addCommand({ id: "open-hermes-profiles", name: "Open profiles", callback: () => void this.openHermes(PROFILES_VIEW) });
    this.app.workspace.onLayoutReady(() => this.watch());
    this.registerInterval(window.setInterval(() => this.watch(), 60_000));

    this.addSettingTab(new HermesCronSettingsTab(this.app, this));
  }

  override async onunload(): Promise<void> {
    this.unloaded = true;
    this.targets.dispose();
    this.scheduler.stop();
    this.state.bodies.clear();
    this.state.dispose();
    await this.processes.dispose();
    this.logger.info("unloaded");
  }

  async saveSettings(settings: ViewerSettings): Promise<void> {
    if (!this.targets.active) return;
    this.processes.allow(settings.servers);
    this.settings = settings;
    this.state.setSettings(settings);
    this.scheduler.setInterval(settings.autoRefreshSeconds * 1000);
    await this.persist();
  }

  /**
   * Replace one registered SSH target in place.
   *
   * A different target may be a different machine, so nothing recorded for the old target is
   * carried over: its selected sources, cached snapshots and remembered remote home are dropped
   * through their existing owners. The new target starts unverified. Unrelated servers and every
   * other setting are preserved.
   */
  async replaceServerTarget(previous: string, next: string): Promise<TargetChangeResult> {
    return this.targets.replace(previous, next);
  }

  rememberRemoteHome(alias: string, remoteHome: string): void {
    if (remoteHome === "" || !this.targets.active || !this.settings.servers.includes(alias)) return;
    this.remoteHomes[alias] = remoteHome;
    this.state.rememberHome(alias, remoteHome);
    void this.persist();
  }

  async forgetServer(alias: string): Promise<void> {
    delete this.remoteHomes[alias];
    delete this.boards[alias];
    delete this.cursors[alias];
    this.state.forgetServer(alias);
    await this.store.removeServer(alias);
    await this.persist();
  }

  /** Deselecting a source removes its cached projection immediately. */
  async dropCachedSource(encodedKey: string): Promise<void> {
    const [alias = "", profileId = ""] = encodedKey.split("\u0000");
    await this.store.remove(alias, profileId);
  }

  async clearCache(): Promise<void> {
    await this.store.clear();
    this.state.bodies.clear();
  }

  private async persist(): Promise<void> {
    // Queued through the single data owner so a concurrent snapshot save cannot be lost.
    await this.data.update<Record<string, unknown>>((current) => this.targets.active ? ({
      ...current,
      settings: this.settings,
      remoteHomes: this.remoteHomes,
      hermesLayouts: this.layouts,
      hermesHues: Object.fromEntries(hues),
      hermesBoards: this.boards,
    }) : current);
  }

  /** Profile ids placed on any profiles canvas, for the color settings. */
  profileIds(): string[] {
    return [...new Set(Object.values(this.layouts).flatMap(layout => Object.keys(layout)))].sort();
  }

  /** Pick (or with null, reset) a profile's hue and repaint open Hermes views. */
  setHue(id: string, h: number | null): void {
    if (h === null) hues.delete(id); else hues.set(id, h);
    void this.data.update<Record<string, unknown>>(current => ({ ...current, hermesHues: Object.fromEntries(hues) }));
    for (const type of [KANBAN_VIEW, PROFILES_VIEW]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) if (leaf.view instanceof HermesView) leaf.view.repaint();
    }
  }

  /** What a line on the profiles canvas counts; the legend switch and the settings dropdown both land here. */
  setEdgeMode(edgeMode: EdgeMode): void {
    this.settings = { ...this.settings, edgeMode };
    void this.data.update<Record<string, unknown>>(current => ({ ...current, settings: this.settings }));
    for (const leaf of this.app.workspace.getLeavesOfType(PROFILES_VIEW)) if (leaf.view instanceof ProfilesView) leaf.view.redrawEdges();
  }

  /** Kanban and profiles open as main-area tabs, one leaf each; `alias` picks the SSH host, `extra` e.g. a board and task. */
  async openHermes(viewType: string, alias?: string, extra: Record<string, unknown> = {}): Promise<void> {
    const leaf = this.app.workspace.getLeavesOfType(viewType)[0] ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: viewType, active: true, state: { ...(alias ? { alias } : {}), ...extra } });
    await this.app.workspace.revealLeaf(leaf);
  }

  /** Stuck-task notices for every board on every host; the first read of a board only seeds its cursor. */
  private watch(): void {
    if (!this.settings.kanbanNotify) { this.cursors = {}; return; }
    for (const alias of this.settings.servers) {
      if (this.watching.has(alias)) continue;
      this.watching.add(alias);
      void this.kanban.events(alias, this.cursors[alias] ?? {}).then(feed => {
        if (this.unloaded || !feed || !this.settings.kanbanNotify || !this.settings.servers.includes(alias)) return;
        const { alerts, next } = stuck(feed, this.cursors[alias] ?? {}, this.kanban.mine, Date.now());
        this.cursors[alias] = next;
        noticeStuck(alerts, (board, task) => void this.openHermes(KANBAN_VIEW, alias, task ? { board, task } : { board }));
      }).finally(() => this.watching.delete(alias));
    }
  }

  private openSettings(): void {
    const app = this.app as App & ObsidianSettingsAccess;
    app.setting.open();
    app.setting.openTabById(this.manifest.id);
  }

  private async activateView(viewType: string, placement: "right" | "tab"): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(viewType);
    const leaf: WorkspaceLeaf | null =
      existing[0] ??
      (placement === "right" ? this.app.workspace.getRightLeaf(false) : this.app.workspace.getLeaf("tab"));
    if (leaf === null) return;
    await leaf.setViewState({ type: viewType, active: true });
    this.app.workspace.revealLeaf(leaf);
    this.scheduler.trigger();
  }
}
