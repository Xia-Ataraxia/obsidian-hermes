import type { ProfileKey, ProfileRoster, ReadCoverage, Freshness } from "./control-center";
import type { DashboardSkill, DashboardRequestContext } from "./dashboard-client";

export type MetadataStatus = "read" | "missing" | "unreadable" | "malformed" | "unsupported" | "changed" | "capped";
export type SkillField = { readonly status: MetadataStatus; readonly shape: string; readonly values: readonly string[] };
export type SkillConfiguration = {
  readonly status: MetadataStatus;
  readonly disabled: SkillField;
  readonly platformDisabled: Readonly<Record<string, SkillField>>;
  readonly platformStatus: MetadataStatus;
  readonly externalDirs: SkillField;
  readonly createDir: SkillField;
  readonly trustedProjectDirs: SkillField;
  readonly projectDiscovery: "enabled" | "disabled" | "unknown";
};
export type SkillCandidate = {
  readonly source: "local" | "create" | "external";
  readonly root: string;
  readonly path: string;
  readonly canonicalPath: string;
  readonly name: string | null;
  readonly declaredName: string | null;
  readonly relativePath: string;
  readonly digest: string | null;
  readonly metadataStatus: MetadataStatus;
  readonly restrictions: Readonly<Record<string, SkillField>>;
  readonly nameSetProvenance: "hub" | "bundled" | "external" | "agent" | "unknown";
};
export type SkillInspection = SkillCandidate & {
  readonly identity: string;
  readonly resolution: "unique" | "ambiguous" | "shadowed" | "unknown";
  readonly loadName: string | null;
  readonly configuredGlobal: "enabled" | "disabled" | "unknown";
  readonly configuredPlatform: "enabled" | "disabled" | "unknown";
  readonly osCompatibility: "compatible" | "restricted" | "unknown";
  readonly effective: "unknown";
};
export type ProfileSkillMetadata = {
  readonly profile: ProfileKey;
  readonly home: string;
  readonly canonicalHome: string;
  readonly hostPlatform: string;
  readonly configuration: SkillConfiguration;
  readonly candidates: readonly SkillCandidate[];
  readonly roots: readonly { readonly source: string; readonly path: string; readonly status: MetadataStatus }[];
  readonly manifests: Readonly<Record<string, MetadataStatus>>;
  readonly coverage: ReadCoverage;
};
export type ProfileSkillCatalog = {
  readonly profile: ProfileKey;
  readonly platform: string | null;
  /** Native visible/loadable rows, never evidence of session activation or canonical identity. */
  readonly visible: readonly DashboardSkill[];
  readonly visibleCoverage: ReadCoverage;
  readonly metadata: ProfileSkillMetadata | null;
  readonly skills: readonly SkillInspection[];
  readonly coverage: ReadCoverage;
  readonly freshness: Freshness;
  readonly session: "unobserved";
};
export interface ProfileMetadataReader {
  read(profile: ProfileKey, context: DashboardRequestContext): Promise<ProfileSkillMetadata>;
}
export interface ProfileCatalog {
  roster(context?: DashboardRequestContext): Promise<ProfileRoster>;
  skills(profile: ProfileKey, context?: DashboardRequestContext, platform?: string): Promise<ProfileSkillCatalog>;
  dispose(): void;
}
export class ProfileCatalogError extends Error {
  override readonly name = "ProfileCatalogError";
  constructor(readonly code: "invalid-scope" | "malformed-metadata" | "aborted" | "stale" | "read-failed") { super(code); }
}
export const PROFILE_LIMITS = { candidates: 2048, directories: 8192, depth: 32, fileBytes: 1_048_576, totalBytes: 16_777_216, outputBytes: 4_194_304, deadlineMs: 10_000 } as const;
