import { DASHBOARD_LIMITS, DashboardClientError } from "../types/dashboard-client";
import type { DashboardJson, DashboardMutationResult, DashboardObject, DashboardRequest, DashboardRequestContext, DashboardSkill, DashboardSkillContent, DashboardTask } from "../types/dashboard-client";
import type { DashboardConnection } from "../types/dashboard-connection";
import { DashboardSession } from "./dashboard-auth";
import { decodeDashboardText } from "./dashboard-http";
import { parseDashboardJson, parseDashboardTask, parseSkillContent, parseSkills, requireObject } from "./dashboard-response";
import { checkMutationPreconditions, parseBulkResult } from "./dashboard-mutation";
import { reconcileDashboard, rethrowLifecycle } from "./dashboard-reconcile";
import { validateDashboardRead } from "./dashboard-read-schema";
import { prepareDashboardRequest, scopeToken, skillName } from "./dashboard-routes";
import { subscribeDashboard } from "./dashboard-socket";
import type { DashboardSocketRequest } from "./dashboard-socket";

export class DashboardClient {
  private readonly session: DashboardSession;
  private readonly lifetime = new AbortController();
  constructor(connection: DashboardConnection) {
    this.session = new DashboardSession({ ...connection, signal: AbortSignal.any([connection.signal, this.lifetime.signal]) });
  }
  async ready(context: DashboardRequestContext = {}): Promise<void> { await this.session.authenticate(context); }
  dispose(): void { this.lifetime.abort(); this.session.clear(); }
  subscribe(input: DashboardSocketRequest, context: DashboardRequestContext = {}) { return subscribeDashboard(this.session, input, context); }
  async read(request: DashboardRequest, context: DashboardRequestContext = {}): Promise<DashboardObject> {
    const wire = prepareDashboardRequest(this.session.origin, request);
    if (wire.method !== "GET" || request.route === "GET /attachments/{attachment_id}") throw new DashboardClientError("unsupported-operation");
    const response = await this.session.send(wire, context);
    if (response.status < 200 || response.status >= 300) throw this.session.nativeFailure(response);
    const data = requireObject(parseDashboardJson(decodeDashboardText(response.bytes)));
    if (request.route === "GET /tasks/{task_id}" && parseDashboardTask(data).id !== request.id) throw new DashboardClientError("malformed-response");
    if (!request.route.startsWith("GET ")) throw new DashboardClientError("unsupported-operation");
    const route = request.route;
    switch (route) {
      case "POST /tasks": case "PATCH /tasks/{task_id}": case "POST /tasks/{task_id}/comments": case "POST /links": case "DELETE /links": case "POST /tasks/bulk": throw new DashboardClientError("unsupported-operation");
      default: return validateDashboardRead(route, data);
    }
  }
  async task(board: string, id: string, context: DashboardRequestContext = {}): Promise<DashboardTask> {
    return parseDashboardTask(await this.read({ route: "GET /tasks/{task_id}", board, id }, context));
  }
  async attachment(board: string, id: string, context: DashboardRequestContext = {}): Promise<Uint8Array> {
    const wire = prepareDashboardRequest(this.session.origin, { route: "GET /attachments/{attachment_id}", board, id });
    const response = await this.session.send(wire, context);
    if (response.status !== 200) throw this.session.nativeFailure(response);
    return response.bytes;
  }
  async skills(profile: string, context: DashboardRequestContext = {}): Promise<readonly DashboardSkill[]> {
    return parseSkills(await this.skillRead({ profile }, context));
  }
  async profileLocations(context: DashboardRequestContext = {}): Promise<DashboardObject> {
    const response = await this.session.send({ url: new URL("/api/profiles", this.session.origin), method: "GET", cap: DASHBOARD_LIMITS.jsonBytes }, context);
    if (response.status !== 200) throw this.session.nativeFailure(response);
    return requireObject(parseDashboardJson(decodeDashboardText(response.bytes)));
  }
  async skillContent(profile: string, name: string, context: DashboardRequestContext = {}): Promise<DashboardSkillContent> {
    return parseSkillContent(await this.skillRead({ profile, name }, context));
  }
  private async skillRead(input: { readonly profile: string; readonly name?: string }, context: DashboardRequestContext): Promise<DashboardJson> {
    const url = new URL(input.name === undefined ? "/api/skills" : "/api/skills/content", this.session.origin);
    url.searchParams.set("profile", scopeToken("profile", input.profile));
    if (input.name !== undefined) url.searchParams.set("name", skillName(input.name));
    const response = await this.session.send({ url, method: "GET", cap: DASHBOARD_LIMITS.jsonBytes }, context);
    if (response.status !== 200) throw this.session.nativeFailure(response);
    return parseDashboardJson(decodeDashboardText(response.bytes));
  }
  async mutate(request: DashboardRequest, context: DashboardRequestContext = {}): Promise<DashboardMutationResult> {
    const wire = prepareDashboardRequest(this.session.origin, request);
    if (wire.method === "GET") throw new DashboardClientError("unsupported-operation");
    const draft = wire.body ? requireObject(parseDashboardJson(wire.body)) : {};
    await checkMutationPreconditions({ client: this, request, draft }, context);
    try {
      const response = await this.session.send(wire, context);
      if (response.status < 200 || response.status >= 300) throw this.session.nativeFailure(response);
      const data = requireObject(parseDashboardJson(decodeDashboardText(response.bytes)));
      if (request.route === "POST /tasks" || request.route === "PATCH /tasks/{task_id}") parseDashboardTask(data);
      if (request.route === "POST /tasks/bulk") return { kind: "bulk", results: parseBulkResult(data, draft, this.session), draft, reconciliations: await reconcileDashboard({ client: this, request, draft }, context) };
      return { kind: "applied", response: data };
    } catch (error) {
      if (!(error instanceof DashboardClientError)) throw error;
      rethrowLifecycle(error);
      const reconciliations = await reconcileDashboard({ client: this, request, draft }, context);
      const first = reconciliations[0];
      return { kind: "uncertain", failure: error, draft, actual: first?.actual ?? null, fields: first?.fields ?? [], reconciliationFailure: first?.failure ?? null, reconciliations };
    }
  }
}
export async function authenticatedDashboardProbe(connection: DashboardConnection): Promise<void> {
  const client = new DashboardClient(connection);
  try { await client.ready(); } finally { client.dispose(); }
}
