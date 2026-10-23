import type { JobKey } from "../types/control-center";
import type { CronAuthoredField, CronExecutionDefinition, CronJobRecord, ProfileRef, SourceKey } from "../types/hermes-cron";
import { parseScopedIdentity } from "./control-center-validation";
import { asBoolean, asRecord, asStrictString } from "./json-scalars";
import { readScheduleDisplay } from "./schedule-display-reader";

/** The jobs.json reader's owner is authoritative; authored `profile` never participates. */
export function cronJobIdentity(job: Pick<CronJobRecord, "source" | "id">): JobKey | null {
  if (job.source.profileId === "all") return null;
  const parsed = parseScopedIdentity({ kind: "job", connection: job.source.alias,
    storageOwnerProfile: job.source.profileId, jobId: job.id });
  return parsed.ok && parsed.value.kind === "job" ? parsed.value : null;
}

export function matchesCronOwner(job: Pick<CronJobRecord, "source" | "id">, owner: SourceKey): boolean {
  return cronJobIdentity(job) !== null && job.source.alias === owner.alias && job.source.profileId === owner.profileId;
}

/** Detail requests cannot substitute an execution profile or a different owner's home. */
export function matchesCronProfile(job: Pick<CronJobRecord, "source" | "id">, profile: ProfileRef): boolean {
  if (!matchesCronOwner(job, profile)) return false;
  return profile.profileId === "default"
    ? profile.home.endsWith("/.hermes")
    : profile.home.endsWith(`/.hermes/profiles/${profile.profileId}`);
}

function field<T>(input: unknown, parse: (value: unknown) => T | null, inherited = true): CronAuthoredField<T> {
  const raw = JSON.stringify(input) ?? null;
  if (input === undefined || input === null) {
    return { provenance: inherited ? "inherited" : "unknown", value: null, raw };
  }
  const value = parse(input);
  return value === null || raw === null ? { provenance: "unknown", value: null, raw }
    : { provenance: "authored", value, raw };
}

function strings(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || !value.every((item: unknown): item is string => typeof item === "string")) return null;
  return [...value];
}

function stringOrStrings(value: unknown): string | readonly string[] | null {
  return typeof value === "string" ? value : strings(value);
}

function scheduleText(value: unknown): string | null {
  const schedule = readScheduleDisplay(value, null);
  return asRecord(value) !== null && schedule.kind !== "unknown" && schedule.raw !== null ? JSON.stringify(value) : null;
}

function reasoning(value: unknown): string | null {
  if (value === false) return "false";
  if (typeof value === "string") {
    return ["none", "false", "disabled", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value.trim().toLowerCase()) ? value : null;
  }
  const record = asRecord(value);
  if (record === null) return null;
  const effort = record["effort"];
  return record["enabled"] === false || (typeof effort === "string" && effort.trim() !== "") ? JSON.stringify(record) : null;
}

/** Input is an owner-scoped raw jobs.json row, before native loader skill rewriting. */
export function parseCronExecutionDefinition(owner: SourceKey, row: Readonly<Record<string, unknown>>): CronExecutionDefinition {
  const prompt = field(row["prompt"], asStrictString, false);
  const script = field(row["script"], asStrictString, false);
  const noAgent = field(row["no_agent"], asBoolean);
  const skill = field(row["skill"], asStrictString);
  const skills = field(row["skills"], stringOrStrings);
  const skillSource = row["skills"] !== undefined && row["skills"] !== null ? "skills"
    : row["skill"] !== undefined && row["skill"] !== null ? "skill" : "none";
  const selection = skillSource === "skills" ? skills : skill;
  const selectionValue = selection.value;
  const selectedSkills = skillSource === "none" ? [] : selectionValue === null ? null
    : [...new Set((typeof selectionValue === "string" ? [selectionValue] : selectionValue).map((name) => name.trim()).filter(Boolean))];
  const identity = cronJobIdentity({ source: owner, id: asStrictString(row["id"]) ?? "" });
  const issues: string[] = [];
  if (identity === null) issues.push("invalid-owner-identity");
  if (skillSource === "skills" && skill.value !== null && skill.value.trim() !== (selectedSkills?.[0] ?? "")) {
    issues.push("skill-skills-conflict");
  }
  const hasScript = script.value !== null && script.value.trim() !== "";
  const malformedMode = noAgent.provenance === "unknown" || (script.provenance === "unknown" && script.raw !== null && script.raw !== "null");
  const mode = malformedMode ? "unknown" : noAgent.value === true ? (hasScript ? "script-only" : "unknown")
    : hasScript ? "script-context" : "agent";
  if (noAgent.value === true && !hasScript) issues.push("no-agent-without-script");
  const fields = {
    prompt, script, noAgent, skill, skills,
    workdir: field(row["workdir"], asStrictString),
    toolsets: field(row["enabled_toolsets"], strings),
    executionProfile: field(row["profile"], asStrictString),
    model: field(row["model"], asStrictString),
    provider: field(row["provider"], asStrictString),
    reasoning: field(row["reasoning_effort"], reasoning),
    delivery: field(row["deliver"], stringOrStrings),
    failureDelivery: field(row["failure_deliver"], stringOrStrings),
    schedule: field(row["schedule"], scheduleText, false),
    scheduleDisplay: field(row["schedule_display"], asStrictString, false),
  };
  for (const [name, parsed] of Object.entries(fields)) {
    if (parsed.provenance === "unknown" && parsed.raw !== null && parsed.raw !== "null") issues.push(`unknown:${name}`);
  }
  return { identity, mode, ...fields, selectedSkills, skillSource, issues };
}
