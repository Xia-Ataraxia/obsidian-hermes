import { DashboardClientError } from "../types/dashboard-client";
import type { DashboardFieldState, DashboardJson, DashboardObject, DashboardReconciliation, DashboardRequest, DashboardRequestContext } from "../types/dashboard-client";
import type { DashboardClient } from "./dashboard-client";
import { object, parseDashboardTask } from "./dashboard-response";

export function rethrowLifecycle(error: DashboardClientError): void {
  if (error.code === "cancelled" || error.code === "stale-generation") throw error;
}
export async function reconcileDashboard(input: { readonly client: DashboardClient; readonly request: DashboardRequest; readonly draft: DashboardObject }, context: DashboardRequestContext): Promise<readonly DashboardReconciliation[]> {
  const { request, draft, client } = input;
  const ids = request.route === "PATCH /tasks/{task_id}" && request.id ? [request.id] : request.route === "POST /tasks/bulk" && Array.isArray(draft["ids"]) ? draft["ids"] : [];
  const results: DashboardReconciliation[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !request.board) throw new DashboardClientError("invalid-request");
    try {
      const detail = await client.read({ route: "GET /tasks/{task_id}", board: request.board, id }, context);
      results.push({ id, actual: parseDashboardTask(detail), fields: reconcileFields(draft, detail), failure: null });
    } catch (error) {
      if (!(error instanceof DashboardClientError)) throw error;
      rethrowLifecycle(error);
      results.push({ id, actual: null, fields: reconcileFields(draft, null), failure: error });
    }
  }
  return results;
}
function reconcileFields(draft: DashboardObject, detail: DashboardObject | null): readonly DashboardFieldState[] {
  const task = detail ? parseDashboardTask(detail) : null;
  const runs = detail?.["runs"];
  const latest = Array.isArray(runs) ? runs.filter(object).reduce<DashboardObject | null>((selected, run) => typeof run["id"] === "number" && (selected === null || Number(selected["id"]) < run["id"]) ? run : selected, null) : null;
  return Object.entries(draft).flatMap(([field, requested]): DashboardFieldState[] => {
    if (requested === null) return [];
    const state = (storageField: string, wanted: DashboardJson, actual: DashboardJson | undefined): DashboardFieldState => ({ inputField: field, field: storageField, requested: wanted, actual, outcome: actual === undefined ? "unknown" : JSON.stringify(actual) === JSON.stringify(wanted) ? "matches" : "differs" });
    switch (field) {
      case "ids": return [];
      case "clear_model_override": return requested === true ? [state("task.model_override", null, task?.["model_override"]), state("task.provider_override", null, task?.["provider_override"])] : [];
      case "clear_reasoning_effort": return requested === true ? [state("task.reasoning_effort", null, task?.["reasoning_effort"])] : [];
      case "summary": return [state("task.latest_summary", requested, task?.["latest_summary"])];
      case "metadata": return [state("latestRun.metadata", requested, latest?.["metadata"])];
      case "assignee": return [state("task.assignee", requested === "" ? null : requested, task?.["assignee"])];
      case "model_override": case "provider_override": return draft["clear_model_override"] === true ? [] : [state(`task.${field}`, requested, task?.[field])];
      case "reasoning_effort": return draft["clear_reasoning_effort"] === true ? [] : [state("task.reasoning_effort", requested, task?.[field])];
      default: return [state(`task.${field}`, requested, task?.[field])];
    }
  });
}
