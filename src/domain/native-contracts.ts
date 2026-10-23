import { createHash } from "node:crypto";

export const NATIVE_CONTRACT_FINGERPRINT = "fba8d2144ab73427bc5cc4ff3196498c622a0f580e236320e2f96f0216211a0f";
export const NATIVE_CONTRACT_MAX_BYTES = 262_144;

export type NativeCapability = {
  readonly method: string;
  readonly path: string;
  readonly disposition: "supported" | "adapted" | "excluded";
  readonly allowedBodyFields: readonly string[];
};
export type NativeSource = {
  readonly path: string;
  readonly sha256: string;
  readonly dirty: boolean;
};
export type NativeContract = {
  readonly version: string;
  readonly commit: string;
  readonly managementProfile: "default";
  readonly sources: readonly NativeSource[];
  readonly capabilities: readonly NativeCapability[];
};
export type NativeContractResult =
  | { readonly status: "supported"; readonly value: NativeContract }
  | { readonly status: "malformed" | "unsupported-schema" | "unsupported-version" | "authentication-required"; readonly reason: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function capability(value: unknown): value is NativeCapability {
  return record(value) && typeof value.method === "string" && typeof value.path === "string"
    && (value.disposition === "supported" || value.disposition === "adapted" || value.disposition === "excluded")
    && strings(value.allowedBodyFields);
}

function source(value: unknown): value is NativeSource {
  return record(value) && typeof value.path === "string" && typeof value.sha256 === "string"
    && /^[0-9a-f]{64}$/.test(value.sha256) && typeof value.dirty === "boolean";
}

function canonical(value: unknown, depth = 0): string | undefined {
  if (depth > 32) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    const entries = value.map((entry: unknown) => canonical(entry, depth + 1));
    return entries.some((entry) => entry === undefined) ? undefined : `[${entries.join(",")}]`;
  }
  if (!record(value)) return undefined;
  const entries: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const entry = canonical(value[key], depth + 1);
    if (entry === undefined) return undefined;
    entries.push(`${JSON.stringify(key)}:${entry}`);
  }
  return `{${entries.join(",")}}`;
}

export function parseNativeContracts(serialized: string): NativeContractResult {
  if (Buffer.byteLength(serialized, "utf8") > NATIVE_CONTRACT_MAX_BYTES) {
    return { status: "malformed", reason: "capture-too-large" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch (error) {
    if (error instanceof SyntaxError) return { status: "malformed", reason: "invalid-json" };
    throw error;
  }
  if (!record(raw)) return { status: "malformed", reason: "capture-object-required" };
  if (raw.schemaVersion !== 1) return { status: "unsupported-schema", reason: "unknown-capture-schema" };
  const identity = raw.identity;
  if (!record(identity) || typeof identity.version !== "string" || typeof identity.commit !== "string"
    || identity.managementProfile !== "default" || identity.connection !== "m1-pro-file") {
    return { status: "unsupported-version", reason: "missing-or-changed-identity" };
  }
  const auth = raw.auth;
  if (!record(auth) || auth.authRequired !== false || auth.mode !== "loopback-session-token") {
    return { status: "authentication-required", reason: "loopback-token-contract-required" };
  }
  if (auth.httpHeader !== "X-Hermes-Session-Token" || auth.websocketQuery !== "token"
    || auth.bootstrapVariable !== "window.__HERMES_SESSION_TOKEN__"
    || auth.requiredEvenWhenAuthRequiredFalse !== true) {
    return { status: "authentication-required", reason: "changed-auth-contract" };
  }
  if (!record(raw.workflow) || !Array.isArray(raw.workflow.columns) || !record(raw.workflow.manual)) {
    return { status: "unsupported-version", reason: "missing-workflow-contract" };
  }
  if (!Array.isArray(raw.sources) || raw.sources.length === 0 || !raw.sources.every(source)
    || !Array.isArray(raw.routes) || raw.routes.length === 0 || !raw.routes.every(capability)) {
    return { status: "unsupported-version", reason: "missing-source-or-route-contract" };
  }
  const normalized = canonical(raw);
  if (normalized === undefined) return { status: "malformed", reason: "invalid-or-deep-capture" };
  if (createHash("sha256").update(normalized).digest("hex") !== NATIVE_CONTRACT_FINGERPRINT) {
    return { status: "unsupported-version", reason: "unrecognized-source-or-contract-fingerprint" };
  }
  return {
    status: "supported",
    value: Object.freeze({
      version: identity.version,
      commit: identity.commit,
      managementProfile: "default",
      sources: Object.freeze(raw.sources.map((entry) => Object.freeze({
        path: entry.path, sha256: entry.sha256, dirty: entry.dirty,
      }))),
      capabilities: Object.freeze(raw.routes.map((entry) => Object.freeze({
        method: entry.method, path: entry.path, disposition: entry.disposition,
        allowedBodyFields: Object.freeze([...entry.allowedBodyFields]),
      }))),
    }),
  };
}
