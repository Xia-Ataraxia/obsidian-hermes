import { ROUTE_CAPABILITIES } from "../types/control-center";
import { parseRouteCapability } from "../domain/control-center-validation";
import { DashboardClientError } from "../types/dashboard-client";
import { parseDashboardJson, requireObject } from "./dashboard-response";
import { prepareDashboardRequest, scopeToken, skillName } from "./dashboard-routes";

export function verifyDashboardWire(origin: URL, input: { readonly url: URL; readonly method: string; readonly body?: string }): void {
  const url = input.url;
  if (url.origin !== origin.origin || url.username || url.password || url.hash) throw new DashboardClientError("unsupported-operation");
  if (url.pathname === "/api/profiles") {
    if (input.method !== "GET" || input.body !== undefined || url.search) throw new DashboardClientError("unsupported-operation");
    return;
  }
  if (url.pathname === "/api/skills" || url.pathname === "/api/skills/content") {
    if (input.method !== "GET" || input.body !== undefined) throw new DashboardClientError("unsupported-operation");
    scopeToken("profile", url.searchParams.get("profile"));
    const fields = url.pathname.endsWith("/content") ? ["profile", "name"] : ["profile"];
    if (fields.includes("name")) skillName(url.searchParams.get("name") ?? "");
    if ([...url.searchParams.keys()].length !== fields.length || fields.some(key => url.searchParams.getAll(key).length !== 1)) throw new DashboardClientError("invalid-request");
    return;
  }
  for (const route of Object.keys(ROUTE_CAPABILITIES)) {
    const parsed = parseRouteCapability(route);
    if (!parsed.ok || parsed.value === "WEBSOCKET /events") continue;
    const [method, template] = route.split(" ");
    if (!template || method !== input.method) continue;
    const pattern = new RegExp(`^/api/plugins/kanban${template.replace(/\{[a-z_]+\}/, "([A-Za-z0-9_-]+)")}$`);
    const match = url.pathname.match(pattern);
    if (!match) continue;
    if (url.searchParams.getAll("profile").join() !== "default") throw new DashboardClientError("invalid-request");
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (url.searchParams.getAll(key).length !== 1) throw new DashboardClientError("invalid-request");
      if (key !== "profile" && key !== "board") query[key] = value;
    }
    const id = match[1], board = url.searchParams.get("board");
    prepareDashboardRequest(origin, { route: parsed.value, ...(board === null ? {} : { board }), ...(id ? { id } : {}), query, ...(input.body === undefined ? {} : { body: requireObject(parseDashboardJson(input.body)) }), completionConfirmed: true });
    return;
  }
  throw new DashboardClientError("unsupported-operation");
}
