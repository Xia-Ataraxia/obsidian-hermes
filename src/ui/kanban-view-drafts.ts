import { parseScopedIdentity } from "../domain/control-center-validation";
import { DashboardClientError } from "../types/dashboard-client";
import type { DashboardJson, DashboardObject } from "../types/dashboard-client";
import type { Freshness } from "../types/control-center";
import type { CloseDecision, ControlCenterLeaf, ControlCenterState } from "./control-center-state";
import type { KanbanDraftScope } from "./kanban-view-contract";

type RecordDraft = { readonly leaf: ControlCenterLeaf<DashboardObject>; remote: DashboardObject; issue: string | null };
const keyOf = (scope: KanbanDraftScope) => JSON.stringify([scope.board, scope.taskId ?? null, scope.createColumn ?? null]);
const revision = (value: DashboardObject) => JSON.stringify([value["title"], value["body"], value["assignee"], value["priority"], value["model_override"], value["provider_override"]]);

/** Memory-only drafts belong to this mounted leaf; HTTP refresh remains with the native host. */
export class KanbanViewDrafts {
  private readonly records = new Map<string, RecordDraft>();
  private readonly listeners = new Set<() => void>();
  private visible = true;
  private disposed = false;
  constructor(private readonly state: ControlCenterState) {}
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  notify(): void { if (!this.disposed) for (const listener of this.listeners) listener(); }
  private record(scope: KanbanDraftScope): RecordDraft {
    if (this.disposed) throw new DashboardClientError("cancelled");
    const key = keyOf(scope), found = this.records.get(key);
    if (found) return found;
    const entity = parseScopedIdentity({ kind: scope.taskId ? "task" : "board", connection: this.state.connection, board: scope.board, ...(scope.taskId ? { taskId: scope.taskId } : {}) });
    if (!entity.ok) throw new DashboardClientError("invalid-request");
    const leaf = this.state.createLeaf<DashboardObject>();
    const row: RecordDraft = { leaf, remote: {}, issue: null };
    const receive = leaf.selectExternal({ entity: entity.value, channel: scope.createColumn ? `create:${scope.createColumn}` : "native-editor", load: async () => row.remote, revision });
    receive({}, { kind: "unknown", lastSuccessAt: null });
    leaf.setVisible(this.visible);
    leaf.subscribe(() => this.notify());
    this.records.set(key, row);
    return row;
  }
  begin(scope: KanbanDraftScope): (value: DashboardObject, freshness: Freshness) => boolean {
    const row = this.record(scope);
    const entity = parseScopedIdentity({ kind: scope.taskId ? "task" : "board", connection: this.state.connection, board: scope.board, ...(scope.taskId ? { taskId: scope.taskId } : {}) });
    if (!entity.ok) throw new DashboardClientError("invalid-request");
    const receive = row.leaf.selectExternal({ entity: entity.value, channel: scope.createColumn ? `create:${scope.createColumn}` : "native-editor", load: async () => row.remote, revision });
    return (value, freshness) => {
      if (!receive(value, freshness)) return false;
      row.remote = value;
      return true;
    };
  }
  get(scope: KanbanDraftScope, field: string, fallback: DashboardJson): DashboardJson {
    const row = this.records.get(keyOf(scope));
    const draft = row?.leaf.snapshot.draft;
    return draft && Object.hasOwn(draft, field) ? draft[field]! : fallback;
  }
  edit(scope: KanbanDraftScope, field: string, value: DashboardJson): void {
    const row = this.record(scope);
    row.leaf.edit({ ...row.leaf.snapshot.draft, [field]: value });
  }
  clear(scope: KanbanDraftScope, field?: string): void {
    const row = this.records.get(keyOf(scope));
    if (!row) return;
    if (field === undefined) { row.leaf.discardDraft(); row.issue = null; }
    else {
      const remaining = { ...row.leaf.snapshot.draft };
      delete remaining[field];
      if (Object.keys(remaining).length) row.leaf.edit(remaining);
      else row.leaf.discardDraft();
    }
    this.notify();
  }
  issue(scope: KanbanDraftScope): string | null {
    const row = this.records.get(keyOf(scope));
    return row?.issue ?? (row?.leaf.snapshot.conflict ? "Remote fields changed. Your draft is retained; review the current task before saving." : null);
  }
  report(scope: KanbanDraftScope, issue: string | null): void { this.record(scope).issue = issue; this.notify(); }
  capture(scope: KanbanDraftScope): DashboardObject { return { ...this.records.get(keyOf(scope))?.leaf.snapshot.draft }; }
  confirmFields(scope: KanbanDraftScope, requested: DashboardObject, actual: DashboardObject, submitted: DashboardObject): void {
    const row = this.records.get(keyOf(scope));
    if (!row) return;
    for (const [field, value] of Object.entries(requested)) {
      const draft = row.leaf.snapshot.draft?.[field], original = submitted[field];
      const sent = field === "priority" && typeof original === "string" ? Number(original) || 0 : ["title", "assignee", "model_override"].includes(field) && typeof original === "string" ? original.trim() : original;
      if (Object.hasOwn(submitted, field) && JSON.stringify(draft) === JSON.stringify(original) && JSON.stringify(sent) === JSON.stringify(value) && JSON.stringify(actual[field]) === JSON.stringify(value)) this.clear(scope, field);
    }
  }
  closeDecision(): CloseDecision {
    let dirtyCount = 0;
    for (const row of this.records.values()) {
      const decision = row.leaf.closeDecision();
      if (decision.kind === "confirm-discard") dirtyCount += decision.dirtyCount;
    }
    return dirtyCount ? { kind: "confirm-discard", dirtyCount, saving: false } : { kind: "allow" };
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const row of this.records.values()) row.leaf.setVisible(visible);
  }
  dispose(): void {
    this.disposed = true;
    for (const row of this.records.values()) row.leaf.dispose();
    this.records.clear();
    this.listeners.clear();
  }
}
