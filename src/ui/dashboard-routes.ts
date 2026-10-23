import { parseControlCenterToken, parseRouteCapability } from "../domain/control-center-validation";
import { ROUTE_CAPABILITIES } from "../types/control-center";
import { DASHBOARD_LIMITS, DashboardClientError } from "../types/dashboard-client";
import type { DashboardRequest, DashboardObject, DashboardJson } from "../types/dashboard-client";
import { parseDashboardJson, requireObject } from "./dashboard-response";

export function scopeToken(kind: "board" | "profile" | "task", value: unknown): string {
  const parsed = parseControlCenterToken(kind, value);
  if (!parsed.ok || kind === "profile" && parsed.value === "all") throw new DashboardClientError("invalid-request");
  return parsed.value;
}
export function skillName(value: string): string {
  if (!/^[\p{L}\p{N}_. -]+(?:\/[\p{L}\p{N}_. -]+)*$/u.test(value) || value.length > 256 || value.split("/").some(part => part === "." || part === "..")) throw new DashboardClientError("invalid-request");
  return value;
}
function validField(key: string, value: DashboardJson): boolean {
  if (value === null) return true;
  switch (key) {
    case "priority": case "max_runtime_seconds": case "goal_max_turns": return typeof value === "number" && Number.isSafeInteger(value);
    case "clear_model_override": case "clear_reasoning_effort": case "triage": case "goal_mode": return typeof value === "boolean";
    case "metadata": return typeof value === "object" && !Array.isArray(value);
    case "parents": case "ids": return Array.isArray(value) && value.length <= 1000 && value.every(id => parseControlCenterToken("task", id).ok);
    case "skills": return Array.isArray(value) && value.length <= 1000 && value.every(name => typeof name === "string" && name.length <= 256);
    case "status": return typeof value === "string" && ["triage", "todo", "scheduled", "ready", "blocked", "review", "done"].includes(value);
    case "title": case "body": case "assignee": case "tenant": case "workspace_kind": case "workspace_path": case "idempotency_key": case "model_override": case "provider_override": case "reasoning_effort": case "project_id": case "result": case "block_reason": case "summary": case "author": return typeof value === "string";
    case "parent_id": case "child_id": return parseControlCenterToken("task", value).ok;
    default: return false;
  }
}
function parseBody(request: DashboardRequest, allowed: readonly string[]): DashboardObject | undefined {
  if (request.body === undefined) return undefined;
  const text = JSON.stringify(request.body);
  if (Buffer.byteLength(text) > DASHBOARD_LIMITS.requestBytes) throw new DashboardClientError("response-cap");
  const body = requireObject(parseDashboardJson(text));
  if (Object.entries(body).some(([key, value]) => !allowed.includes(key) || !validField(key, value))) throw new DashboardClientError("unsupported-operation");
  if (body["title"] !== undefined && body["title"] !== null && (typeof body["title"] !== "string" || !body["title"].trim())) throw new DashboardClientError("invalid-request");
  if (body["status"] === "done" && request.completionConfirmed !== true) throw new DashboardClientError("invalid-request", 0, "Completion requires explicit confirmation");
  if (request.route === "POST /tasks" && typeof body["title"] !== "string" || request.route === "POST /tasks/{task_id}/comments" && (typeof body["body"] !== "string" || !body["body"].trim()) || request.route === "POST /tasks/bulk" && (!Array.isArray(body["ids"]) || body["ids"].length === 0)) throw new DashboardClientError("invalid-request");
  if (request.route === "POST /links" && (typeof body["parent_id"] !== "string" || typeof body["child_id"] !== "string" || body["parent_id"] === body["child_id"])) throw new DashboardClientError("invalid-request");
  return body;
}
export function prepareDashboardRequest(origin: URL, request: DashboardRequest) {
  const parsed = parseRouteCapability(request.route);
  if (!parsed.ok || parsed.value === "WEBSOCKET /events") throw new DashboardClientError("unsupported-operation");
  const capability = ROUTE_CAPABILITIES[parsed.value];
  const [method, template] = parsed.value.split(" ");
  if (!method || !template) throw new DashboardClientError("unsupported-operation");
  const body = parseBody(request, capability.bodyFields);
  if (capability.access === "read" && request.body !== undefined || method !== "GET" && method !== "DELETE" && body === undefined) throw new DashboardClientError("invalid-request");
  let path = template;
  if (template.includes("{")) {
    const id = template.includes("{task_id}") ? scopeToken("task", request.id) : request.id;
    if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !template.includes("{task_id}") && !/^[1-9][0-9]{0,15}$/.test(id)) throw new DashboardClientError("invalid-request");
    path = template.replace(/\{[a-z_]+\}/, encodeURIComponent(id));
  } else if (request.id !== undefined) throw new DashboardClientError("invalid-request");
  const url = new URL(`/api/plugins/kanban${path}`, origin);
  url.searchParams.set("profile", "default");
  if (capability.scope === "board") url.searchParams.set("board", scopeToken("board", request.board));
  else if (request.board !== undefined) throw new DashboardClientError("invalid-request");
  const query = request.query ?? {};
  const allowed = queryFields(parsed.value);
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.includes(key) || typeof value !== "string" || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw new DashboardClientError("invalid-request");
    url.searchParams.set(key, value);
  }
  if (query["tail"] !== undefined && (!/^\d+$/.test(query["tail"]) || Number(query["tail"]) < 1 || Number(query["tail"]) > 2_000_000)) throw new DashboardClientError("invalid-request");
  if (query["run_state_type"] !== undefined !== (query["run_state_name"] !== undefined) || query["run_state_type"] !== undefined && !["status", "outcome"].includes(query["run_state_type"])) throw new DashboardClientError("invalid-request");
  if (method === "DELETE") { scopeToken("task", query["parent_id"]); scopeToken("task", query["child_id"]); }
  return { url, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cap: parsed.value === "GET /attachments/{attachment_id}" ? DASHBOARD_LIMITS.binaryBytes : DASHBOARD_LIMITS.jsonBytes };
}
function queryFields(route: string): readonly string[] {
  switch (route) {
    case "GET /board": return ["tenant", "include_archived", "workflow_template_id", "current_step_key"];
    case "GET /tasks/{task_id}": return ["run_state_type", "run_state_name"];
    case "GET /tasks/{task_id}/log": return ["tail"];
    case "GET /home-channels": return ["task_id"];
    case "GET /diagnostics": return ["task_id"];
    case "DELETE /links": return ["parent_id", "child_id"];
    default: return [];
  }
}
