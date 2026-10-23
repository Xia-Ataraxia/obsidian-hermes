import { parseControlCenterToken } from "../domain/control-center-validation";
import { requireObject } from "./dashboard-response";
import { DashboardClientError } from "../types/dashboard-client";
import type { DashboardMutationResult, DashboardRequest, DashboardRequestContext } from "../types/dashboard-client";
import type { CloseDecision, ControlCenterState } from "./control-center-state";
import type { KanbanHostServices } from "./kanban-host-services";
import type { KanbanDraftScope, KanbanNativeBridge, KanbanNavigation } from "./kanban-view-contract";
import { KanbanViewDrafts } from "./kanban-view-drafts";

export class KanbanViewSession {
  readonly drafts: KanbanViewDrafts;
  readonly services: KanbanHostServices;
  readonly bridge: KanbanNativeBridge;
  private navigation: ((target: KanbanNavigation) => void) | null = null;
  private refresh: (() => void) | null = null;
  private pending: KanbanNavigation | null = null;
  private board: string;
  private lastSuccess: number | null = null;
  private failed = false;
  private saving = 0;
  private mutationNotice = "";
  private disposed = false;
  private visible = true;
  private generation = 0;
  private navigationGeneration = 0;
  private lifetime = new AbortController();
  private readonly releases = new Set<() => void>();
  private readonly resumes = new Map<() => void, { pause(): void; resume(): void }>();
  constructor(private readonly state: ControlCenterState, initialBoard = "default") {
    this.board = this.validBoard(initialBoard);
    this.drafts = new KanbanViewDrafts(state);
    const base = state.kanbanServices(initialBoard);
    const context = (input: DashboardRequestContext = {}) => {
      const generation = this.generation;
      return { signal: AbortSignal.any([this.lifetime.signal, ...(input.signal ? [input.signal] : [])]), isCurrent: () => !this.disposed && this.visible && generation === this.generation && (input.isCurrent?.() ?? true) };
    };
    this.services = { ...base, bridge: this.bridge = {
      connect: (navigate, refresh) => { this.navigation = navigate; this.refresh = refresh; if (this.pending) { navigate(this.pending); this.pending = null; } return () => { if (this.navigation === navigate) { this.navigation = null; this.refresh = null; } }; },
      selected: board => { this.board = this.validBoard(board); this.lastSuccess = null; this.drafts.notify(); },
      get: (scope, field, fallback) => this.drafts.get(scope, field, fallback),
      edit: (scope, field, value) => this.drafts.edit(scope, field, value),
      clear: (scope, field) => this.drafts.clear(scope, field),
      issue: scope => this.drafts.issue(scope), subscribe: this.drafts.subscribe,
    }, client: {
      read: async (request, input) => {
        const current = context(input);
        const receive = request.route === "GET /tasks/{task_id}" && request.board && request.id ? this.drafts.begin({ board: request.board, taskId: request.id }) : null;
        try {
          const result = await base.client.read(request, current);
          if (!current.isCurrent()) throw new DashboardClientError("stale-generation");
          if (receive && !receive(requireObject(result["task"] ?? null), { kind: "fresh", lastSuccessAt: state.clock.now() })) throw new DashboardClientError("stale-generation");
          if (request.route === "GET /board" && request.board === this.board) { this.lastSuccess = state.clock.now(); this.failed = false; this.drafts.notify(); }
          return result;
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          if (current.isCurrent() && !(error instanceof DashboardClientError && error.code === "stale-generation")) { this.failed = true; this.drafts.notify(); }
          throw error;
        }
      },
      mutate: (request, input) => this.mutate(request, context(input), base),
      attachment: (board, id, input) => base.client.attachment(board, id, context(input)),
    }, watch: request => {
      if (!this.visible || this.disposed) return () => undefined;
      const watched = { ...request, onFailure: (error: DashboardClientError) => { this.failed = true; this.drafts.notify(); request.onFailure(error); } };
      let cancel = base.watch(watched);
      const release = () => { if (this.releases.delete(release)) { cancel(); this.resumes.delete(release); } };
      this.releases.add(release);
      this.resumes.set(release, { pause: () => cancel(), resume: () => { cancel = base.watch(watched); } });
      return release;
    } };
  }
  private validBoard(board: string): string {
    if (!parseControlCenterToken("board", board).ok) throw new DashboardClientError("invalid-request");
    return board;
  }
  navigate(board: string, taskId: string | null = null): void {
    if (this.disposed) return;
    this.validBoard(board);
    if (taskId !== null && !parseControlCenterToken("task", taskId).ok) throw new DashboardClientError("invalid-request");
    const target = { board, taskId };
    if (this.navigation) this.navigation(target); else this.pending = target;
  }
  async requestNavigation(board: string, taskId: string | null, confirm: (decision: Extract<CloseDecision, { kind: "confirm-discard" }>) => Promise<boolean>): Promise<boolean> {
    this.validBoard(board);
    if (taskId !== null && !parseControlCenterToken("task", taskId).ok) throw new DashboardClientError("invalid-request");
    const generation = ++this.navigationGeneration;
    const decision = this.closeDecision();
    if (decision.kind === "confirm-discard" && !await confirm(decision)) return false;
    if (this.disposed || generation !== this.navigationGeneration) return false;
    this.navigate(board, taskId);
    return true;
  }
  private async mutate(request: DashboardRequest, context: DashboardRequestContext, base: KanbanHostServices): Promise<DashboardMutationResult> {
    const scope: KanbanDraftScope = { board: request.board ?? this.board, ...(request.id ? { taskId: request.id } : { createColumn: request.body?.["triage"] ? "triage" : "todo" }) };
    if (!context.isCurrent?.()) throw new DashboardClientError("cancelled");
    const submitted = this.drafts.capture(scope);
    this.saving++; this.drafts.notify();
    try {
      const result = await base.client.mutate(request, context);
      if (!context.isCurrent?.()) throw new DashboardClientError("stale-generation");
      if (result.kind === "uncertain") {
        this.mutationNotice = "Write uncertain; retained draft requires review before retry.";
        this.drafts.report(scope, `Write outcome uncertain. Draft retained. ${result.fields.map(field => `${field.field}: ${field.outcome} (actual: ${JSON.stringify(field.actual) ?? "unknown"})`).join("; ")}`);
      } else if (result.kind === "applied" && request.id && request.board) {
        const readback = await this.services.client.read({ route: "GET /tasks/{task_id}", board: request.board, id: request.id }, context);
        this.drafts.confirmFields(scope, request.body ?? {}, requireObject(readback["task"] ?? null), submitted);
        this.drafts.report(scope, null);
      }
      if (result.kind === "applied") this.mutationNotice = "";
      return result;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.mutationNotice = "Save not confirmed; draft retained.";
      if (!this.disposed) this.drafts.report(scope, "Save was not confirmed. Draft retained; reread the task before retrying.");
      throw error;
    } finally { this.saving--; this.drafts.notify(); }
  }
  status(): string {
    const stale = this.failed || this.lastSuccess === null || this.state.clock.now() - this.lastSuccess >= 30_000;
    return `${this.state.connection} / ${this.board} · ${!this.visible ? "Paused" : stale ? "Stale" : "Fresh"}${this.lastSuccess === null ? "" : ` · ${new Date(this.lastSuccess).toLocaleTimeString()}`}${this.saving ? " · Saving" : ""}${this.mutationNotice ? ` · ${this.mutationNotice}` : ""}`;
  }
  closeDecision(): CloseDecision {
    const draft = this.drafts.closeDecision();
    return this.saving ? { kind: "confirm-discard", dirtyCount: draft.kind === "confirm-discard" ? draft.dirtyCount : 0, saving: true } : draft;
  }
  setVisible(visible: boolean): void {
    if (this.visible === visible || this.disposed) return;
    this.visible = visible; this.generation++;
    this.lifetime.abort(); this.lifetime = new AbortController();
    for (const watch of this.resumes.values()) { if (visible) watch.resume(); else watch.pause(); }
    this.drafts.setVisible(visible);
    if (visible) this.refresh?.();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++;
    this.lifetime.abort();
    for (const release of this.releases) release();
    this.navigation = null; this.refresh = null; this.pending = null;
    this.drafts.dispose();
  }
}
