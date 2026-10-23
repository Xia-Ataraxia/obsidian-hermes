import type { ProfileKey, IncompleteReason, ReadCoverage } from "../types/control-center";
import type { DashboardJson } from "../types/dashboard-client";
import { PROFILE_LIMITS, ProfileCatalogError } from "../types/profile-catalog";
import type { MetadataStatus, ProfileSkillMetadata, SkillCandidate, SkillConfiguration, SkillField } from "../types/profile-catalog";
import { parseDashboardJson, requireObject } from "../ui/dashboard-response";

function text(value: DashboardJson | undefined): string {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f]/.test(value)) throw new ProfileCatalogError("malformed-metadata");
  return value;
}
function status(value: DashboardJson | undefined): MetadataStatus {
  switch (value) {
    case "read": case "missing": case "unreadable": case "malformed": case "unsupported": case "changed": case "capped": return value;
    default: throw new ProfileCatalogError("malformed-metadata");
  }
}
function list(value: DashboardJson | undefined): readonly DashboardJson[] {
  if (!Array.isArray(value) || value.length > PROFILE_LIMITS.candidates) throw new ProfileCatalogError("malformed-metadata");
  return value;
}
function field(value: DashboardJson | undefined): SkillField {
  const row = requireObject(value ?? null);
  return { status: status(row["status"]), shape: text(row["shape"]), values: list(row["values"]).map(text) };
}
function fieldMap(value: DashboardJson | undefined): Readonly<Record<string, SkillField>> {
  return Object.fromEntries(Object.entries(requireObject(value ?? null)).map(([key, entry]) => [text(key), field(entry)]));
}
function configuration(value: DashboardJson | undefined): SkillConfiguration {
  const row = requireObject(value ?? null);
  const discovery = row["projectDiscovery"];
  if (discovery !== "enabled" && discovery !== "disabled" && discovery !== "unknown") throw new ProfileCatalogError("malformed-metadata");
  return { status: status(row["status"]), disabled: field(row["disabled"]), platformDisabled: fieldMap(row["platformDisabled"]), platformStatus: status(row["platformStatus"]), externalDirs: field(row["externalDirs"]), createDir: field(row["createDir"]), trustedProjectDirs: field(row["trustedProjectDirs"]), projectDiscovery: discovery };
}
function candidate(value: DashboardJson): SkillCandidate {
  const row = requireObject(value);
  const source = row["source"], provenance = row["provenance"];
  if (source !== "local" && source !== "create" && source !== "external") throw new ProfileCatalogError("malformed-metadata");
  if (provenance !== "hub" && provenance !== "bundled" && provenance !== "external" && provenance !== "agent" && provenance !== "unknown") throw new ProfileCatalogError("malformed-metadata");
  const root = text(row["root"]), path = text(row["path"]), canonicalPath = text(row["canonicalPath"]), relativePath = text(row["relativePath"]);
  const digest = row["digest"] === null ? null : text(row["digest"]);
  if (![root, path, canonicalPath].every(p => p.startsWith("/") && !p.split("/").includes("..")) || !path.startsWith(`${root}/`) || relativePath.startsWith("/") || relativePath.split("/").includes("..") || digest !== null && !/^[a-f0-9]{64}$/.test(digest)) throw new ProfileCatalogError("malformed-metadata");
  return { source, root, path, canonicalPath, relativePath, digest, name: row["name"] === null ? null : text(row["name"]), declaredName: row["declaredName"] === null ? null : text(row["declaredName"]), metadataStatus: status(row["metadataStatus"]), restrictions: fieldMap(row["restrictions"]), nameSetProvenance: provenance };
}
function reason(value: DashboardJson): IncompleteReason {
  switch (value) {
    case "missing-source": case "unsupported-schema": case "malformed-data": case "missing-attribution": case "row-cap": case "byte-cap": case "deadline": case "transport-failure": return value;
    default: throw new ProfileCatalogError("malformed-metadata");
  }
}
export function parseProfileMetadata(payload: string, profile: ProfileKey): ProfileSkillMetadata {
  if (Buffer.byteLength(payload) > PROFILE_LIMITS.outputBytes) throw new ProfileCatalogError("malformed-metadata");
  const row = requireObject(parseDashboardJson(payload));
  if (row["profile"] !== profile.profile || row["connection"] !== profile.connection) throw new ProfileCatalogError("invalid-scope");
  const reasons = list(row["reasons"]).map(reason);
  const first = reasons[0];
  const coverage: ReadCoverage = first === undefined ? { kind: "complete" } : { kind: "incomplete", reasons: [first, ...reasons.slice(1)] };
  const candidates = list(row["candidates"]).map(candidate);
  if (new Set(candidates.map(c => JSON.stringify([c.source, c.root, c.path]))).size !== candidates.length) throw new ProfileCatalogError("malformed-metadata");
  return { profile, home: text(row["home"]), canonicalHome: text(row["canonicalHome"]), hostPlatform: text(row["hostPlatform"]), configuration: configuration(row["configuration"]), candidates,
    roots: list(row["roots"]).map(raw => { const root = requireObject(raw); return { source: text(root["source"]), path: text(root["path"]), status: status(root["status"]) }; }),
    manifests: Object.fromEntries(Object.entries(requireObject(row["manifests"] ?? null)).map(([key, value]) => [text(key), status(value)])), coverage };
}
