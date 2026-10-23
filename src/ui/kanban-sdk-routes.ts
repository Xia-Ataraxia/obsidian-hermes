import { ROUTE_CAPABILITIES } from "../types/control-center";
import { parseRouteCapability } from "../domain/control-center-validation";
import { DASHBOARD_LIMITS, DashboardClientError } from "../types/dashboard-client";
import type { DashboardRequest } from "../types/dashboard-client";
import { parseDashboardJson, requireObject } from "./dashboard-response";
import type { KanbanHostServices } from "./kanban-host-services";

/** Translate only paths emitted by the pinned page; no URL/origin escape hatch. */
export function nativeSdkRequest(path: string, init: RequestInit = {}): DashboardRequest {
  if (!path.startsWith("/api/plugins/kanban/") || /[\\#\x00-\x20]/.test(path) || path.includes("..") || path.length > 4096) throw new DashboardClientError("unsupported-operation");
  const url = new URL(path, "https://kanban.invalid");
  const relative = url.pathname.slice("/api/plugins/kanban".length);
  if (relative.includes("%") || relative.includes("..")) throw new DashboardClientError("invalid-request");
  const match = relative.match(/^\/(tasks|attachments|runs)\/([A-Za-z0-9_-]+)(\/comments|\/attachments|\/log)?$/);
  const template = match ? `/${match[1]}/{${match[1] === "tasks" ? "task_id" : match[1] === "runs" ? "run_id" : "attachment_id"}}${match[3] ?? ""}` : relative;
  // /tasks/bulk is a literal route, not a task identifier.
  const parsed = parseRouteCapability(`${init.method ?? "GET"} ${relative === "/tasks/bulk" ? relative : template}`);
  if (!parsed.ok || parsed.value === "WEBSOCKET /events") throw new DashboardClientError("unsupported-operation");
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (url.searchParams.getAll(key).length !== 1) throw new DashboardClientError("invalid-request");
    if (key === "profile") { if (value !== "default") throw new DashboardClientError("invalid-request"); }
    else if (key !== "board") query[key] = value;
  }
  if (init.body !== undefined && (typeof init.body !== "string" || new TextEncoder().encode(init.body).length > DASHBOARD_LIMITS.requestBytes)) throw new DashboardClientError("invalid-request");
  const body = typeof init.body === "string" ? requireObject(parseDashboardJson(init.body)) : undefined;
  return {
    route: parsed.value,
    ...(ROUTE_CAPABILITIES[parsed.value].scope === "board" ? { board: url.searchParams.get("board") || "default" } : {}),
    ...(match && relative !== "/tasks/bulk" ? { id: match[2] } : {}),
    query,
    ...(body === undefined ? {} : { body }),
  };
}

export function kanbanSdkTransport(services: KanbanHostServices, signal: AbortSignal) {
  const context = { signal };
  return {
    async fetchJSON(path: string, init?: RequestInit) {
      const request = nativeSdkRequest(path, init);
      signal.throwIfAborted();
      if (request.route.startsWith("GET ")) return services.client.read(request, context);
      // The adapted page collected the completion summary through the leaf dialog.
      const completionConfirmed = request.body?.["status"] === "done" && typeof request.body["summary"] === "string" && request.body["summary"].trim().length > 0;
      const result = await services.client.mutate({ ...request, completionConfirmed }, context);
      signal.throwIfAborted();
      services.onMutation(result);
      switch (result.kind) {
        case "applied": return result.response;
        case "bulk": return { results: result.results };
        case "uncertain": throw result.failure;
      }
    },
    async authedFetch(path: string, init?: RequestInit) {
      const request = nativeSdkRequest(path, init);
      signal.throwIfAborted();
      if (request.route !== "GET /attachments/{attachment_id}" || !request.board || !request.id) throw new DashboardClientError("unsupported-operation");
      const bytes = await services.client.attachment(request.board, request.id, context);
      signal.throwIfAborted();
      return new Response(new Blob([Uint8Array.from(bytes)], { type: "application/octet-stream" }));
    },
  };
}
