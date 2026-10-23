import { DashboardClientError } from "../types/dashboard-client";
import type { DashboardObject, DashboardRequest, DashboardRequestContext } from "../types/dashboard-client";
import type { DashboardClient } from "./dashboard-client";
import type { DashboardSession } from "./dashboard-auth";
import { requireObject } from "./dashboard-response";

export async function checkMutationPreconditions(input: { readonly client: DashboardClient; readonly request: DashboardRequest; readonly draft: DashboardObject }, context: DashboardRequestContext): Promise<void> {
  const { request, draft, client } = input;
  const ids = request.route === "PATCH /tasks/{task_id}" && request.id ? [request.id] : request.route === "POST /tasks/bulk" && Array.isArray(draft["ids"]) ? draft["ids"] : [];
  if (ids.length === 0 || !request.board) return;
  const status = draft["status"];
  const workflow = typeof status === "string" ? await client.read({ route: "GET /workflow" }, context) : null;
  for (const id of ids) {
    if (typeof id !== "string") throw new DashboardClientError("invalid-request");
    const current = await client.task(request.board, id, context);
    if (current.status === "archived") throw new DashboardClientError("unsupported-operation");
    if (typeof status === "string" && workflow) {
      const manual = requireObject(workflow["manual"] ?? null);
      const allowed = manual[current.status];
      if (!Array.isArray(allowed) || !allowed.includes(status)) throw new DashboardClientError("invalid-request", 0, "Native workflow does not permit this transition");
    }
  }
}
export function parseBulkResult(data: DashboardObject, draft: DashboardObject, session: DashboardSession) {
  const rows = data["results"], ids = draft["ids"];
  if (!Array.isArray(rows) || !Array.isArray(ids) || rows.length !== ids.length) throw new DashboardClientError("malformed-response");
  return rows.map((raw, index) => {
    const row = requireObject(raw);
    const id = row["id"], ok = row["ok"], error = row["error"];
    if (typeof id !== "string" || id !== ids[index] || typeof ok !== "boolean" || error !== undefined && typeof error !== "string") throw new DashboardClientError("malformed-response");
    return { id, ok, error: typeof error === "string" ? session.sanitize(error) : null };
  });
}
