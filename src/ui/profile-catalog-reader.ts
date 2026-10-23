import { parseControlCenterToken, parseScopedIdentity, serializeScopedKey } from "../domain/control-center-validation";
import { inspectProfileSkills } from "../domain/profile-skill-parser";
import type { ConnectionId, ProfileKey, ProfileRoster, ReadCoverage } from "../types/control-center";
import type { DashboardRequestContext } from "../types/dashboard-client";
import { DashboardClientError } from "../types/dashboard-client";
import { ProfileCatalogError } from "../types/profile-catalog";
import type { ProfileCatalog, ProfileMetadataReader, ProfileSkillCatalog, ProfileSkillMetadata } from "../types/profile-catalog";
import type { DashboardClient } from "./dashboard-client";
import { requireObject } from "./dashboard-response";

export class ProfileCatalogReader implements ProfileCatalog {
  private readonly lifetime = new AbortController();
  private rosterGeneration = 0;
  private selectionGeneration = 0;
  constructor(private readonly connection: ConnectionId, private readonly client: DashboardClient, private readonly metadata: ProfileMetadataReader) {}

  private context(input: DashboardRequestContext, current: () => boolean): DashboardRequestContext {
    return { signal: AbortSignal.any([this.lifetime.signal, ...input.signal ? [input.signal] : []]), isCurrent: () => current() && (input.isCurrent?.() ?? true) };
  }
  private check(context: DashboardRequestContext): void {
    if (context.signal?.aborted) throw new ProfileCatalogError("aborted");
    if (context.isCurrent?.() === false) throw new ProfileCatalogError("stale");
  }
  async roster(input: DashboardRequestContext = {}): Promise<ProfileRoster> {
    const generation = ++this.rosterGeneration;
    const context = this.context(input, () => generation === this.rosterGeneration);
    this.check(context);
    try {
      const raw = await this.client.read({ route: "GET /profiles" }, context);
      this.check(context);
      const entries = raw["profiles"];
      if (!Array.isArray(entries)) throw new ProfileCatalogError("malformed-metadata");
      const profiles: ProfileKey[] = [];
      for (const entry of entries) {
        const name = parseControlCenterToken("profile", requireObject(entry)["name"]);
        if (!name.ok || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name.value) || profiles.some(p => p.profile === name.value)) throw new ProfileCatalogError("malformed-metadata");
        profiles.push({ kind: "profile", connection: this.connection, profile: name.value });
      }
      return { connection: this.connection, profiles, coverage: profiles.some(p => p.profile === "default") ? { kind: "complete" } : { kind: "incomplete", reasons: ["missing-source"] }, freshness: { kind: "fresh", lastSuccessAt: Date.now() } };
    } catch (error) {
      this.check(context);
      if (!(error instanceof DashboardClientError || error instanceof ProfileCatalogError)) throw error;
      return { connection: this.connection, profiles: [], coverage: { kind: "incomplete", reasons: ["transport-failure"] }, freshness: { kind: "stale", lastSuccessAt: null, reason: "transport-failure" } };
    }
  }
  async skills(requested: ProfileKey, input: DashboardRequestContext = {}, platform?: string): Promise<ProfileSkillCatalog> {
    const parsed = parseScopedIdentity(requested);
    if (!parsed.ok || parsed.value.kind !== "profile") throw new ProfileCatalogError("invalid-scope");
    const profile = parsed.value;
    if (profile.connection !== this.connection || profile.profile === "all" || platform !== undefined && !/^[a-z0-9_-]{1,64}$/.test(platform)) throw new ProfileCatalogError("invalid-scope");
    const generation = ++this.selectionGeneration;
    const context = this.context(input, () => generation === this.selectionGeneration);
    this.check(context);
    const outcomes = await Promise.allSettled([this.client.skills(profile.profile, context), this.metadata.read(profile, context)]);
    this.check(context);
    const [native, supplement] = outcomes;
    const failed: ReadCoverage = { kind: "incomplete", reasons: ["transport-failure"] };
    let metadata: ProfileSkillMetadata | null = null;
    if (supplement.status === "fulfilled") {
      if (serializeScopedKey(supplement.value.profile) !== serializeScopedKey(profile)) throw new ProfileCatalogError("invalid-scope");
      metadata = supplement.value;
    }
    const coverage = native.status === "rejected" || metadata === null ? failed : metadata.coverage;
    return { profile, platform: platform ?? null, visible: native.status === "fulfilled" ? native.value : [], visibleCoverage: native.status === "fulfilled" ? { kind: "complete" } : failed,
      metadata, skills: metadata ? inspectProfileSkills(metadata, platform ?? null) : [], coverage,
      freshness: native.status === "fulfilled" && metadata !== null ? { kind: "fresh", lastSuccessAt: Date.now() } : { kind: "stale", lastSuccessAt: null, reason: "transport-failure" }, session: "unobserved" };
  }
  dispose(): void { this.lifetime.abort(); }
}
