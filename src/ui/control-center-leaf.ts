import { serializeScopedKey } from "../domain/control-center-validation";
import { CONTROL_CENTER_TIMING } from "../types/control-center";
import type { Freshness } from "../types/control-center";
import { DashboardClientError } from "../types/dashboard-client";
import type { DashboardMutationResult, DashboardRequest, DashboardRequestContext } from "../types/dashboard-client";
import type { ProfileCatalogReader } from "./profile-catalog-reader";
import type { ControlCenterRefresh } from "./control-center-refresh";
import type { CloseDecision, ControlCenterSelection, ControlCenterSnapshot, ControlCenterState } from "./control-center-state";

const emptySnapshot = <T>(): ControlCenterSnapshot<T> => ({ value: null, draft: null, baseRevision: null, conflict: false, freshness: { kind: "unknown", lastSuccessAt: null }, loading: false, failure: null, mutation: "idle", mutationResult: null });

/** One selection owner per leaf. All bodies and drafts die with this object. */
export class ControlCenterLeaf<T> {
  private readonly records = new Map<string, ControlCenterSnapshot<T>>();
  private readonly listeners = new Set<() => void>();
  private selection: ControlCenterSelection<T> | null = null;
  private key: string | null = null;
  private generation = 0;
  private request = 0;
  private controller = new AbortController();
  private readController = new AbortController();
  private running: Promise<void> | null = null;
  private pending = false;
  private poll: (() => void) | null = null;
  private stale: (() => void) | null = null;
  private unwatch: (() => void) | null = null;
  private visible = true;
  private disposed = false;
  private external = false;
  constructor(private readonly owner: ControlCenterState, private readonly refreshOwner: ControlCenterRefresh, readonly catalog: ProfileCatalogReader | null, private readonly released: () => void) {}

  get snapshot(): ControlCenterSnapshot<T> { return this.key === null ? emptySnapshot<T>() : this.records.get(this.key) ?? emptySnapshot<T>(); }
  get retainedCount(): number { return this.records.size; }
  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(): void { if (!this.disposed) for (const listener of [...this.listeners]) if (this.listeners.has(listener)) listener(); }
  private update(patch: Partial<ControlCenterSnapshot<T>>): void {
    if (this.disposed || this.key === null) return;
    this.records.set(this.key, { ...this.snapshot, ...patch });
    this.notify();
  }
  select(selection: ControlCenterSelection<T>): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (selection.entity.connection !== this.owner.connection) throw new DashboardClientError("invalid-request");
    this.stop();
    this.external = false;
    this.selection = selection;
    this.key = JSON.stringify([serializeScopedKey(selection.entity), selection.channel]);
    this.notify();
    return this.visible ? this.start() : Promise.resolve();
  }
  /** A generation-bound delivery seam for a host that already owns refresh IO. */
  selectExternal(selection: ControlCenterSelection<T>): (value: T, freshness: Freshness) => boolean {
    if (selection.entity.connection !== this.owner.connection) throw new DashboardClientError("invalid-request");
    if (this.disposed) return () => false;
    this.stop();
    this.external = true;
    this.controller = new AbortController();
    this.selection = selection;
    this.key = JSON.stringify([serializeScopedKey(selection.entity), selection.channel]);
    const generation = this.generation;
    this.notify();
    return (incoming, freshness) => {
      if (this.disposed || !this.visible || this.generation !== generation) return false;
      const previous = this.snapshot;
      const value = selection.merge?.(previous.value, incoming) ?? incoming;
      this.update({ value, conflict: previous.draft !== null && previous.baseRevision !== selection.revision(value), freshness, failure: null, loading: false });
      return true;
    };
  }
  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.stop();
    this.visible = visible;
    if (visible && !this.external) void this.start();
  }
  private start(): Promise<void> {
    const selected = this.selection;
    if (selected === null) return Promise.resolve();
    this.controller = new AbortController();
    const entity = selected.entity;
    if ("board" in entity) {
      this.unwatch = this.refreshOwner.watch({ board: entity.board, since: 0, onEvents: () => undefined, onRefresh: () => { void this.refresh(); }, onFailure: error => this.failed(error) }, batch => entity.kind !== "task" || batch.events.some(event => event.task_id === entity.taskId || event.task_id === null));
    } else this.schedulePoll();
    this.armStale();
    return this.refresh();
  }
  private schedulePoll(): void {
    this.poll = this.owner.clock.later(() => {
      if (!this.visible || this.disposed) return;
      void this.refresh();
      this.schedulePoll();
    }, CONTROL_CENTER_TIMING.pollMs);
  }
  private armStale(): void {
    this.stale?.();
    const elapsed = this.owner.clock.now() - (this.snapshot.freshness.lastSuccessAt ?? this.owner.clock.now());
    this.stale = this.owner.clock.later(() => {
      if (this.visible && !this.disposed) this.update({ freshness: { kind: "stale", lastSuccessAt: this.snapshot.freshness.lastSuccessAt, reason: "age" } });
    }, Math.max(0, CONTROL_CENTER_TIMING.staleAfterMs - elapsed));
  }
  private failed(error: Error): void {
    this.update({ failure: error, freshness: { kind: "stale", lastSuccessAt: this.snapshot.freshness.lastSuccessAt, reason: "transport-failure" } });
  }
  refresh(): Promise<void> {
    if (!this.visible || this.disposed || this.external || this.selection === null) return Promise.resolve();
    if (this.running !== null) { this.pending = true; return this.running; }
    const selected = this.selection;
    const generation = this.generation;
    const request = ++this.request;
    const isCurrent = () => !this.disposed && this.visible && generation === this.generation && request === this.request;
    this.readController = new AbortController();
    const context: DashboardRequestContext = { signal: AbortSignal.any([this.controller.signal, this.readController.signal]), isCurrent };
    const run = async () => {
      try {
        const incoming = await Promise.resolve().then(() => {
          if (!isCurrent()) throw new DashboardClientError("cancelled");
          return selected.load(context);
        });
        if (!isCurrent()) return;
        const previous = this.snapshot;
        const value = selected.merge?.(previous.value, incoming) ?? incoming;
        this.update({ value, conflict: previous.draft !== null && previous.baseRevision !== selected.revision(value), freshness: selected.freshness?.(value) ?? { kind: "fresh", lastSuccessAt: this.owner.clock.now() }, failure: null });
        if (isCurrent()) this.armStale();
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (isCurrent()) this.failed(error);
      } finally {
        if (isCurrent()) {
          this.running = null;
          this.update({ loading: false });
          if (isCurrent() && this.pending) { this.pending = false; void this.refresh(); }
        }
      }
    };
    this.running = run();
    const running = this.running;
    this.update({ loading: true });
    return running;
  }
  edit(value: T): void {
    if (this.selection === null) return;
    const current = this.snapshot;
    this.update({ draft: value, baseRevision: current.draft === null && current.value !== null ? this.selection.revision(current.value) : current.baseRevision });
  }
  discardDraft(): void { this.update({ draft: null, baseRevision: null, conflict: false }); }
  async mutate(request: DashboardRequest): Promise<DashboardMutationResult> {
    if (this.disposed || !this.visible || this.selection === null || this.snapshot.mutation === "saving") throw new DashboardClientError("cancelled");
    const entity = this.selection.entity;
    if (!("board" in entity) || request.board !== entity.board || entity.kind === "task" && request.id !== entity.taskId) throw new DashboardClientError("invalid-request");
    const generation = this.generation;
    const isCurrent = () => !this.disposed && this.visible && generation === this.generation;
    this.update({ mutation: "saving", mutationResult: null });
    try {
      const result = await this.owner.client.mutate(request, { signal: this.controller.signal, isCurrent });
      if (isCurrent()) {
        this.update({ mutation: result.kind === "applied" ? "applied" : "uncertain", mutationResult: result });
        if (isCurrent()) { this.readController.abort(); ++this.request; this.running = null; this.pending = false; await this.refresh(); }
        if (isCurrent() && !this.external) this.refreshOwner.invalidate(request.board);
      }
      return result;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (isCurrent()) { this.update({ mutation: "uncertain" }); this.failed(error); void this.refresh(); }
      throw error;
    }
  }
  closeDecision(): CloseDecision {
    const rows = [...this.records.values()];
    const dirtyCount = rows.filter(row => row.draft !== null).length;
    const saving = rows.some(row => row.mutation === "saving");
    return dirtyCount > 0 || saving ? { kind: "confirm-discard", dirtyCount, saving } : { kind: "allow" };
  }
  close(discard = false): boolean {
    if (!discard && this.closeDecision().kind !== "allow") return false;
    this.dispose();
    return true;
  }
  private stop(): void {
    ++this.generation;
    this.controller.abort();
    this.readController.abort();
    this.running = null;
    this.pending = false;
    this.poll?.(); this.poll = null;
    this.stale?.(); this.stale = null;
    this.unwatch?.(); this.unwatch = null;
    if (this.key !== null) this.records.set(this.key, { ...this.snapshot, loading: false, mutation: this.snapshot.mutation === "saving" ? "uncertain" : this.snapshot.mutation });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.catalog?.dispose();
    this.selection = null;
    this.key = null;
    this.records.clear();
    this.listeners.clear();
    this.released();
  }
}
