import type { RouteCapabilityName } from "./control-center";

export type DashboardJson = null | boolean | number | string | readonly DashboardJson[] | DashboardObject;
export type DashboardObject = { readonly [key: string]: DashboardJson };
export type DashboardReadRoute = Extract<RouteCapabilityName, `GET ${string}`>;
export type DashboardWriteRoute = Extract<RouteCapabilityName, `POST ${string}` | `PATCH ${string}` | `DELETE ${string}`>;
/** Closed route templates; parameters are parsed before constructing any URL. */
export type DashboardRequest = {
  readonly route: DashboardReadRoute | DashboardWriteRoute;
  readonly board?: string;
  readonly id?: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: DashboardObject;
  readonly completionConfirmed?: boolean;
};
export type DashboardRequestContext = {
  readonly signal?: AbortSignal;
  /** Owner closes over current entity/request generation; checked before and after every await. */
  readonly isCurrent?: () => boolean;
};
export type DashboardFailureCode = "authentication-required" | "unsupported-operation" | "invalid-request" | "malformed-response" | "response-cap" | "timeout" | "cancelled" | "stale-generation" | "transport" | "native-error";
export class DashboardClientError extends Error {
  override readonly name = "DashboardClientError";
  readonly detail: string;
  readonly originalDashboard: string | null;
  constructor(readonly code: DashboardFailureCode, readonly status = 0, message: string | { readonly detail: string; readonly originalDashboard: string } = "") {
    const detail = typeof message === "string" ? message : message.detail;
    super(detail || `Dashboard: ${code}`);
    this.detail = detail;
    this.originalDashboard = typeof message === "string" ? null : message.originalDashboard;
  }
}
export type DashboardTask = DashboardObject & { readonly id: string; readonly title: string; readonly status: string; readonly assignee: string | null };
export type DashboardFieldState = { readonly field: string; readonly inputField: string; readonly requested: DashboardJson; readonly actual: DashboardJson | undefined; readonly outcome: "matches" | "differs" | "unknown" };
export type DashboardReconciliation = { readonly id: string; readonly actual: DashboardTask | null; readonly fields: readonly DashboardFieldState[]; readonly failure: DashboardClientError | null };
export type DashboardMutationResult =
  | { readonly kind: "applied"; readonly response: DashboardObject }
  | { readonly kind: "bulk"; readonly results: readonly { readonly id: string; readonly ok: boolean; readonly error: string | null }[]; readonly reconciliations: readonly DashboardReconciliation[]; readonly draft: DashboardObject }
  | { readonly kind: "uncertain"; readonly failure: DashboardClientError; readonly draft: DashboardObject; readonly actual: DashboardTask | null; readonly fields: readonly DashboardFieldState[]; readonly reconciliationFailure: DashboardClientError | null; readonly reconciliations: readonly DashboardReconciliation[] };
export type DashboardEvent = { readonly id: number; readonly task_id: string | null; readonly run_id: number | null; readonly kind: string; readonly payload: DashboardJson; readonly created_at: number };
export type DashboardEventBatch = { readonly events: readonly DashboardEvent[]; readonly cursor: number };
export type DashboardSubscription = { close(): void; readonly closed: Promise<DashboardClientError | null> };
export type DashboardSkill = { readonly name: string; readonly description: string; readonly category: string | null; readonly enabled: boolean; readonly usage: number; readonly provenance: "hub" | "bundled" | "external" | "agent" };
export type DashboardSkillContent = { readonly name: string; readonly content: string; readonly path: string };
export const DASHBOARD_LIMITS = { timeoutMs: 10_000, bootstrapBytes: 1_048_576, jsonBytes: 4_194_304, binaryBytes: 16_777_216, socketBytes: 1_048_576, requestBytes: 1_048_576 } as const;
