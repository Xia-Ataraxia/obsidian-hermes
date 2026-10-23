import { DASHBOARD_LIMITS, DashboardClientError } from "../types/dashboard-client";
import type { DashboardRequestContext } from "../types/dashboard-client";
import type { DashboardConnection } from "../types/dashboard-connection";
import { assertCurrent, dashboardHttp, dashboardOrigin, decodeDashboardText } from "./dashboard-http";
import type { DashboardWireResponse } from "./dashboard-http";
import { parseDashboardJson, requireObject } from "./dashboard-response";
import { verifyDashboardWire } from "./dashboard-wire-policy";

export class DashboardSession {
  private token: string | null = null;
  readonly origin: URL;
  constructor(readonly connection: DashboardConnection) {
    this.origin = dashboardOrigin(connection);
    connection.signal.addEventListener("abort", () => { this.token = null; }, { once: true });
  }
  clear(): void { this.token = null; }
  async authenticate(context: DashboardRequestContext): Promise<string> {
    assertCurrent(this.connection, context);
    if (this.token) return this.token;
    const signal = AbortSignal.any([this.connection.signal, ...(context.signal ? [context.signal] : [])]);
    const page = await dashboardHttp({ url: this.origin, method: "GET", cap: DASHBOARD_LIMITS.bootstrapBytes, timeoutMs: DASHBOARD_LIMITS.timeoutMs, signal });
    assertCurrent(this.connection, context);
    const html = decodeDashboardText(page.bytes);
    if (page.status !== 200 || /window\.__HERMES_AUTH_REQUIRED__\s*=\s*true\b/.test(html)) throw this.authRequired();
    const literals = [...html.matchAll(/window\.__HERMES_SESSION_TOKEN__\s*=\s*("(?:[^"\\\r\n]|\\.)*")\s*;/g)];
    const literal = literals[0]?.[1];
    if (literals.length !== 1 || !literal) throw this.authRequired();
    const token = parseDashboardJson(literal);
    if (typeof token !== "string" || !/^[A-Za-z0-9._~+\/-]{16,1024}$/.test(token)) throw this.authRequired();
    const status = await dashboardHttp({ url: new URL("/api/status", this.origin), method: "GET", token, cap: DASHBOARD_LIMITS.jsonBytes, timeoutMs: DASHBOARD_LIMITS.timeoutMs, signal });
    assertCurrent(this.connection, context);
    if (status.status === 401 || status.status === 403) throw this.authRequired();
    if (status.status !== 200) throw new DashboardClientError("native-error", status.status);
    const data = requireObject(parseDashboardJson(decodeDashboardText(status.bytes)));
    if (data["auth_required"] !== false) throw this.authRequired();
    const protectedRead = await dashboardHttp({ url: new URL("/api/plugins/kanban/profiles?profile=default", this.origin), method: "GET", token, cap: DASHBOARD_LIMITS.jsonBytes, timeoutMs: DASHBOARD_LIMITS.timeoutMs, signal });
    assertCurrent(this.connection, context);
    if (protectedRead.status === 401 || protectedRead.status === 403) throw this.authRequired();
    if (protectedRead.status !== 200) throw new DashboardClientError("native-error", protectedRead.status);
    if (!Array.isArray(requireObject(parseDashboardJson(decodeDashboardText(protectedRead.bytes)))["profiles"])) throw new DashboardClientError("malformed-response");
    this.token = token;
    return token;
  }
  async send(input: { readonly url: URL; readonly method: string; readonly body?: string; readonly cap: number }, context: DashboardRequestContext): Promise<DashboardWireResponse> {
    verifyDashboardWire(this.origin, input);
    const token = await this.authenticate(context);
    assertCurrent(this.connection, context);
    const response = await dashboardHttp({ ...input, token, timeoutMs: DASHBOARD_LIMITS.timeoutMs, signal: AbortSignal.any([this.connection.signal, ...(context.signal ? [context.signal] : [])]) });
    assertCurrent(this.connection, context);
    if (response.status === 401) {
      this.clear();
      if (input.method === "GET") {
        const refreshed = await this.authenticate(context);
        const retry = await dashboardHttp({ ...input, token: refreshed, timeoutMs: DASHBOARD_LIMITS.timeoutMs, signal: AbortSignal.any([this.connection.signal, ...(context.signal ? [context.signal] : [])]) });
        assertCurrent(this.connection, context);
        if (retry.status === 401) { this.clear(); throw this.authRequired(); }
        return retry;
      }
      throw this.authRequired();
    }
    return response;
  }
  nativeFailure(response: DashboardWireResponse): DashboardClientError {
    let detail = "Native dashboard refused the request";
    try {
      const data = requireObject(parseDashboardJson(decodeDashboardText(response.bytes)));
      const message = data["detail"] ?? data["error"];
      if (typeof message === "string") detail = this.sanitize(message);
    } catch (error) { if (!(error instanceof DashboardClientError)) throw error; }
    return new DashboardClientError("native-error", response.status, detail);
  }
  sanitize(message: string): string {
    const clean = this.token ? message.split(this.token).join("[redacted]") : message;
    return clean.replace(/[\x00-\x1f\x7f<>]/g, " ").replace(/(?:https?:\/\/\S+|(?:token|password|secret|authorization)\s*[:=]\s*\S+)/gi, "[redacted]").slice(0, 512);
  }
  private authRequired(): DashboardClientError { return new DashboardClientError("authentication-required", 401, { detail: "Open the original dashboard to authenticate", originalDashboard: this.origin.href }); }
}
