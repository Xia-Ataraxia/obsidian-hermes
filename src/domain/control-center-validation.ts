import { CONTROL_CENTER_TIMING, ROUTE_CAPABILITIES } from "../types/control-center";
import type { AbsolutePath, BoundaryResult, ControlCenterToken, Freshness, RequestScope, RouteCapabilityName, ScopedIdentity, TokenKind } from "../types/control-center";
import { isQuotable } from "./posix-single-quote";
import { checkAbsolutePath, checkAlias, checkJobId, checkProfileId, checkWithinRoot } from "./remote-token-validator";

function unreachable(value: never): never {
  throw new TypeError(`Unsupported control-center variant: ${String(value)}`);
}

/** Conservative tokens contain no shell/SQL syntax; paths remain data, never commands. */
function isToken<K extends TokenKind>(value: unknown, kind: K): value is ControlCenterToken<K> {
  if (typeof value !== "string" || !isQuotable(value)) return false;
  switch (kind) {
    case "connection": return checkAlias(value).ok && value !== "." && value !== "..";
    case "profile":
    case "board": return checkProfileId(value).ok;
    case "task":
    case "job": return checkJobId(value).ok;
    case "event": return /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
    case "path": return value.length <= 4096 && checkAbsolutePath(value).ok
      && value.split("/").every((segment) => segment === "" || /^[\p{L}\p{N} ._@+-]+$/u.test(segment));
    default: return unreachable(kind);
  }
}

export function parseControlCenterToken<K extends TokenKind>(kind: K, value: unknown): BoundaryResult<ControlCenterToken<K>> {
  return isToken(value, kind) ? { ok: true, value } : { ok: false, code: "invalid-token" };
}

/** Lexical containment only: discovery/reader must still enforce existing-path and symlink policy. */
export function parseControlCenterPath(value: unknown, root: unknown): BoundaryResult<AbsolutePath> {
  if (!isToken(value, "path") || !isToken(root, "path")) return { ok: false, code: "invalid-token" };
  return checkWithinRoot(value, root).ok ? { ok: true, value } : { ok: false, code: "path-escape" };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

/** Reject extra fields; return a fresh immutable identity so later input mutation cannot change scope. */
export function parseScopedIdentity(value: unknown): BoundaryResult<ScopedIdentity> {
  if (!record(value) || !isToken(value.connection, "connection")) return { ok: false, code: "invalid-shape" };
  const connection = value.connection;
  switch (value.kind) {
    case "connection":
      if (fields(value, ["kind", "connection"])) return { ok: true, value: Object.freeze({ kind: "connection", connection }) };
      break;
    case "profile":
      if (fields(value, ["kind", "connection", "profile"]) && isToken(value.profile, "profile")) {
        return { ok: true, value: Object.freeze({ kind: "profile", connection, profile: value.profile }) };
      }
      break;
    case "board":
      if (fields(value, ["kind", "connection", "board"]) && isToken(value.board, "board")) {
        return { ok: true, value: Object.freeze({ kind: "board", connection, board: value.board }) };
      }
      break;
    case "task":
      if (fields(value, ["kind", "connection", "board", "taskId"]) && isToken(value.board, "board") && isToken(value.taskId, "task")) {
        return { ok: true, value: Object.freeze({ kind: "task", connection, board: value.board, taskId: value.taskId }) };
      }
      break;
    case "event":
      if (fields(value, ["kind", "connection", "board", "eventId"]) && isToken(value.board, "board") && isToken(value.eventId, "event")) {
        return { ok: true, value: Object.freeze({ kind: "event", connection, board: value.board, eventId: value.eventId }) };
      }
      break;
    case "job":
      if (fields(value, ["kind", "connection", "storageOwnerProfile", "jobId"]) && isToken(value.storageOwnerProfile, "profile") && isToken(value.jobId, "job")) {
        return { ok: true, value: Object.freeze({ kind: "job", connection, storageOwnerProfile: value.storageOwnerProfile, jobId: value.jobId }) };
      }
      break;
    default: return { ok: false, code: "invalid-shape" };
  }
  return { ok: false, code: "invalid-shape" };
}

/** Canonical field order, independent of caller object order; safe for Map keys and round trips. */
export function serializeScopedKey(value: ScopedIdentity): string {
  switch (value.kind) {
    case "connection": return JSON.stringify({ kind: value.kind, connection: value.connection });
    case "profile": return JSON.stringify({ kind: value.kind, connection: value.connection, profile: value.profile });
    case "board": return JSON.stringify({ kind: value.kind, connection: value.connection, board: value.board });
    case "task": return JSON.stringify({ kind: value.kind, connection: value.connection, board: value.board, taskId: value.taskId });
    case "event": return JSON.stringify({ kind: value.kind, connection: value.connection, board: value.board, eventId: value.eventId });
    case "job": return JSON.stringify({ kind: value.kind, connection: value.connection, storageOwnerProfile: value.storageOwnerProfile, jobId: value.jobId });
    default: return unreachable(value);
  }
}

export function parseScopedKey(serialized: unknown): BoundaryResult<ScopedIdentity> {
  if (typeof serialized !== "string") return { ok: false, code: "invalid-shape" };
  if (serialized.length > 1024) return { ok: false, code: "too-large" };
  try {
    const value: unknown = JSON.parse(serialized);
    return parseScopedIdentity(value);
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: false, code: "invalid-json" };
    throw error;
  }
}

function isCapability(value: unknown): value is RouteCapabilityName {
  return typeof value === "string" && Object.hasOwn(ROUTE_CAPABILITIES, value);
}
/** Accept templates only. Concrete URL construction/parameter validation belongs to the client. */
export function parseRouteCapability(value: unknown): BoundaryResult<RouteCapabilityName> {
  return isCapability(value) ? { ok: true, value } : { ok: false, code: "unsupported-capability" };
}

export function sameRequestScope(left: RequestScope, right: RequestScope): boolean {
  return Number.isSafeInteger(left.connectionGeneration) && left.connectionGeneration >= 0
    && Number.isSafeInteger(left.requestGeneration) && left.requestGeneration >= 0
    && left.connectionGeneration === right.connectionGeneration && left.requestGeneration === right.requestGeneration
    && serializeScopedKey(left.entity) === serializeScopedKey(right.entity);
}

/** Caller supplies time for deterministic refresh state; a transport failure is immediately stale. */
export function readFreshness(lastSuccessAt: number | null, now: number, transportFailed: boolean): Freshness {
  const success = lastSuccessAt !== null && Number.isFinite(lastSuccessAt) && lastSuccessAt >= 0 && lastSuccessAt <= now ? lastSuccessAt : null;
  if (transportFailed) return { kind: "stale", lastSuccessAt: success, reason: "transport-failure" };
  if (success === null || !Number.isFinite(now)) return { kind: "unknown", lastSuccessAt: null };
  return now - success >= CONTROL_CENTER_TIMING.staleAfterMs
    ? { kind: "stale", lastSuccessAt: success, reason: "age" }
    : { kind: "fresh", lastSuccessAt: success };
}
