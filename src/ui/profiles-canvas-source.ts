import { projectTaskActivity } from "../domain/task-activity-projector";
import { serializeScopedKey } from "../domain/control-center-validation";
import type { BoardKey, Freshness, ProfileRoster } from "../types/control-center";
import type { ActivityWindow, BoardActivitySnapshot } from "../types/task-activity";
import type { CanvasFilters, ConfiguredOrchestrator, ProfilesCanvasServices } from "../types/profiles-canvas";
import { CANVAS_DEFAULT_FILTERS } from "../types/profiles-canvas";
import { retainProfileRoster } from "./control-center-state";
import type { ControlCenterLeaf } from "./control-center-state";
import { activityWindow } from "./profiles-canvas-model";

type ActivityBatch = { readonly window: ActivityWindow; readonly snapshots: readonly BoardActivitySnapshot[]; readonly freshness: Freshness };
const stale = (freshness: Freshness): Freshness => ({ kind: "stale", lastSuccessAt: freshness.lastSuccessAt, reason: "transport-failure" });
export class ProfilesCanvasSource {
  private readonly roster: ControlCenterLeaf<ProfileRoster>;
  private readonly boards: ControlCenterLeaf<readonly BoardKey[]>;
  private readonly configuration: ControlCenterLeaf<ConfiguredOrchestrator>;
  private readonly activity: ControlCenterLeaf<ActivityBatch>;
  private readonly watches = new Map<string, () => void>();
  private readonly listeners = new Set<() => void>();
  private visible = true;
  private disposed = false;
  private activityScope = "";
  private socketFailed = false;
  private initialWindow: ActivityWindow;
  filters: CanvasFilters;
  constructor(private readonly services: ProfilesCanvasServices) {
    this.filters = services.preferences?.filters ?? CANVAS_DEFAULT_FILTERS;
    this.initialWindow = activityWindow(this.filters, services.state.clock.now());
    this.roster = services.state.createLeaf();
    this.boards = services.state.createLeaf();
    this.configuration = services.state.createLeaf();
    this.activity = services.state.createLeaf();
    this.roster.subscribe(() => this.notify());
    this.boards.subscribe(() => { this.syncBoards(); this.notify(); });
    this.configuration.subscribe(() => this.notify());
    this.activity.subscribe(() => this.notify());
  }
  async start(): Promise<void> {
    const entity = { kind: "connection", connection: this.services.state.connection } as const;
    await Promise.all([
      this.roster.select({ entity, channel: "profiles:roster", load: context => this.services.loadRoster(context), revision: value => JSON.stringify(value.profiles), merge: retainProfileRoster, freshness: value => value.freshness }),
      this.boards.select({ entity, channel: "profiles:boards", load: context => this.services.loadBoards(context), revision: value => JSON.stringify(value) }),
      this.configuration.select({ entity, channel: "profiles:configuration", load: context => this.services.loadConfiguration?.(context) ?? Promise.resolve({ kind: "unknown" }), revision: value => JSON.stringify(value) }),
    ]);
  }
  get availableBoards(): readonly BoardKey[] { return (this.boards.snapshot.value ?? []).filter(board => board.connection === this.services.state.connection).slice(0, 64); }
  get selectedBoards(): readonly BoardKey[] {
    if (this.filters.boards.length === 0) return this.availableBoards;
    return this.filters.boards.map(board => ({ kind: "board", connection: this.services.state.connection, board }));
  }
  get currentRoster(): ProfileRoster {
    const value = this.roster.snapshot.value;
    return value ? { ...value, freshness: this.roster.snapshot.freshness } : { connection: this.services.state.connection, profiles: [], coverage: { kind: "unknown" }, freshness: this.roster.snapshot.freshness };
  }
  get orchestrator(): ConfiguredOrchestrator {
    const value = this.configuration.snapshot.value;
    return this.configuration.snapshot.freshness.kind === "fresh" && value?.kind === "configured" && value.profile.connection === this.services.state.connection ? value : { kind: "unknown" };
  }
  get projection() {
    const batch = this.activity.snapshot;
    const snapshots = (batch.value?.snapshots ?? []).map(snapshot => ({ ...snapshot, freshness: this.socketFailed ? stale(snapshot.freshness) : batch.freshness.kind === "fresh" ? snapshot.freshness : batch.freshness }));
    const roster = this.currentRoster;
    const boardsFresh = this.boards.snapshot.freshness.kind === "fresh";
    const boundedRoster: ProfileRoster = (this.boards.snapshot.value?.length ?? 0) > 64 ? { ...roster, coverage: { kind: "incomplete", reasons: ["row-cap"] } } : roster;
    return projectTaskActivity({ roster: boardsFresh ? boundedRoster : { ...boundedRoster, freshness: this.boards.snapshot.freshness }, selectedBoards: this.selectedBoards, window: batch.value?.window ?? this.initialWindow, types: this.filters.types, snapshots });
  }
  get scopeLabel(): string {
    const window = this.activity.snapshot.value?.window ?? this.initialWindow;
    const date = (time: number) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" }).format(time);
    const start = window.start === null ? "전체 기간" : date(window.start);
    return `${this.selectedBoards.length}개 보드 · ${start} — ${date(window.end)} KST · ${this.filters.types.length}개 이벤트 유형`;
  }
  get freshnessLabel(): string {
    const time = this.roster.snapshot.freshness.lastSuccessAt;
    return time === null ? "최근 수집 확인 불가" : `프로파일 수집 ${new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", timeStyle: "medium" }).format(time)} KST`;
  }
  subscribe(callback: () => void): () => void { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  private notify(): void { if (!this.disposed) for (const callback of this.listeners) callback(); }
  setFilters(filters: CanvasFilters): void {
    this.filters = filters;
    this.initialWindow = activityWindow(filters, this.services.state.clock.now());
    this.syncBoards(); this.notify();
  }
  private syncBoards(): void {
    if (this.disposed) return;
    const boards = this.selectedBoards;
    const scope = JSON.stringify([boards.map(serializeScopedKey).sort(), this.filters.window, [...this.filters.types].sort()]);
    if (scope !== this.activityScope) {
      this.activityScope = scope;
      const filters = this.filters;
      let previous: ActivityBatch | null = null;
      void this.activity.select({ entity: { kind: "connection", connection: this.services.state.connection }, channel: `profiles:activity:${scope}`,
        load: async context => {
          const window = activityWindow(filters, this.services.state.clock.now());
          const outcomes: PromiseSettledResult<BoardActivitySnapshot>[] = [];
          let next = 0;
          await Promise.all(Array.from({ length: Math.min(4, boards.length) }, async () => {
            while (next < boards.length && !context.signal?.aborted && context.isCurrent?.() !== false) {
              const index = next++, board = boards[index];
              if (board) outcomes[index] = (await Promise.allSettled([this.services.loadActivity(board, window, context)]))[0]!;
            }
          }));
          for (const outcome of outcomes) if (outcome.status === "rejected" && !(outcome.reason instanceof Error)) throw outcome.reason;
          const snapshots = outcomes.flatMap(outcome => outcome.status === "fulfilled" ? [outcome.value] : []);
          const failed = snapshots.length !== boards.length;
          const sameWindow = snapshots.every(snapshot => JSON.stringify(snapshot.window) === JSON.stringify(window));
          if ((!sameWindow || failed) && previous) return { ...previous, freshness: stale(previous.freshness) };
          const fresh = !failed && sameWindow && snapshots.every(snapshot => snapshot.freshness.kind === "fresh");
          const batch: ActivityBatch = { window, snapshots, freshness: fresh ? { kind: "fresh", lastSuccessAt: this.services.state.clock.now() } : stale(previous?.freshness ?? { kind: "unknown", lastSuccessAt: null }) };
          if (context.isCurrent?.() !== false && !context.signal?.aborted) { previous = batch; this.socketFailed = false; }
          return batch;
        }, revision: value => JSON.stringify([value.window, value.snapshots.map(snapshot => [snapshot.snapshotAt, snapshot.highWaterEventId])]), freshness: value => value.freshness });
    }
    const selected = new Map(boards.map(board => [serializeScopedKey(board), board]));
    for (const [key, stop] of this.watches) if (!selected.has(key) || !this.visible) { stop(); this.watches.delete(key); }
    if (!this.visible) return;
    for (const [key, board] of selected) if (!this.watches.has(key)) {
      this.watches.set(key, this.services.state.kanbanServices().watch({ board: board.board, since: 0, onEvents: () => undefined, onRefresh: () => { void this.activity.refresh(); }, onFailure: () => { this.socketFailed = true; this.notify(); void this.activity.refresh(); } }));
    }
  }
  async refresh(): Promise<void> { await Promise.all([this.roster.refresh(), this.boards.refresh(), this.configuration.refresh(), this.activity.refresh()]); }
  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const leaf of [this.roster, this.boards, this.configuration, this.activity]) leaf.setVisible(visible);
    this.syncBoards();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const stop of this.watches.values()) stop();
    this.watches.clear();
    for (const leaf of [this.roster, this.boards, this.configuration, this.activity]) leaf.dispose();
    this.listeners.clear();
  }
}
