import { serializeScopedKey } from "../domain/control-center-validation";
import { matchesCronOwner } from "../domain/cron-execution-definition";
import { parseJobsJson } from "../domain/jobs-json-parser";
import { buildReadJobsJson } from "../domain/read-command-builder";
import { acceptStructuredJson } from "../domain/response-bound";
import type { ProfileKey } from "../types/control-center";
import { DashboardClientError, type DashboardRequestContext } from "../types/dashboard-client";
import type { ProfileRef } from "../types/hermes-cron";
import type { ProfileCatalog, ProfileSkillCatalog } from "../types/profile-catalog";
import type { InspectorCron, ProfileInspection } from "../types/profile-inspector";
import type { SshReadOnlyAdapter } from "./ssh-read-only-adapter";

export function inspectorProfileRef(profile: ProfileKey, catalog: ProfileSkillCatalog): ProfileRef | null {
  const metadata = catalog.metadata;
  if (serializeScopedKey(catalog.profile) !== serializeScopedKey(profile)) throw new DashboardClientError("invalid-request");
  if (metadata === null) return null;
  if (serializeScopedKey(metadata.profile) !== serializeScopedKey(profile)) throw new DashboardClientError("invalid-request");
  return { alias: profile.connection, profileId: profile.profile, home: metadata.canonicalHome };
}

function check(context: DashboardRequestContext): void {
  if (context.signal?.aborted || context.isCurrent?.() === false) throw new DashboardClientError("cancelled");
}

export async function readInspectorCron(adapter: SshReadOnlyAdapter, ref: ProfileRef, context: DashboardRequestContext): Promise<InspectorCron> {
  check(context);
  const command = buildReadJobsJson(ref.home);
  if (!command.ok) return { status: "unavailable", jobs: [], detail: command.detail };
  const result = await adapter.run(ref.alias, command.command);
  check(context);
  if (result.transport !== "connected" || result.exitCode !== 0 || result.capExceeded) {
    return { status: "unavailable", jobs: [], detail: "Owner-scoped jobs could not be read completely." };
  }
  if (result.stdout.trim() === "") return { status: "missing", jobs: [], detail: "No jobs.json was returned for this owner; job count is unknown." };
  const json = acceptStructuredJson<unknown>(result.stdout, result.capExceeded);
  if (!json.ok) return { status: "unavailable", jobs: [], detail: json.detail };
  const parsed = parseJobsJson({ alias: ref.alias, profileId: ref.profileId }, json.value);
  if (!parsed.recognized || parsed.jobs.some(job => !matchesCronOwner(job, ref))) {
    return { status: "unavailable", jobs: [], detail: "Unrecognized owner-scoped cron data." };
  }
  return { status: "read", jobs: parsed.jobs, detail: parsed.unparsedFields.length ? "Some native fields are not interpreted by this build." : null };
}

export async function readProfileInspection(catalog: ProfileCatalog, adapter: SshReadOnlyAdapter, profile: ProfileKey, context: DashboardRequestContext): Promise<ProfileInspection> {
  const skills = await catalog.skills(profile, context);
  check(context);
  const ref = inspectorProfileRef(profile, skills);
  const cron = ref === null ? { status: "unavailable", jobs: [], detail: "Profile home metadata is unavailable." } satisfies InspectorCron
    : await readInspectorCron(adapter, ref, context);
  return { catalog: skills, ref, cron };
}
