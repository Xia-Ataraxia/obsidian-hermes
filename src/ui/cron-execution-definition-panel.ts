import type { CronAuthoredField, CronJobRecord } from "../types/hermes-cron";
import { cronJobIdentity } from "../domain/cron-execution-definition";
import { serializeScopedKey } from "../domain/control-center-validation";

export interface CronDefinitionElement {
  createEl(tag: "h3" | "p" | "dl" | "dt" | "dd" | "details" | "summary" | "pre", options?: {
    readonly text?: string;
    readonly cls?: string;
    readonly attr?: Readonly<Record<string, string>>;
  }): CronDefinitionElement;
}

type Field = CronAuthoredField<string | boolean | readonly string[]>;

function fieldText(field: Field): string {
  switch (field.provenance) {
    case "authored": return typeof field.value === "string" ? field.value : JSON.stringify(field.value);
    case "inherited": return "Inherited; runtime value unknown";
    case "unknown": return field.raw === null || field.raw === "null" ? "Unknown / not authored" : `Unknown authored value: ${field.raw}`;
    default: return assertNever(field);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported cron provenance: ${String(value)}`);
}

export function renderCronExecutionDefinition(parent: CronDefinitionElement, job: CronJobRecord): void {
  const section = parent.createEl("details", { cls: "hcv-disclosure", attr: { "data-cron-definition": "true" } });
  section.createEl("summary", { text: "Execution definition", cls: "hcv-disclosure-summary" });
  const definition = job.executionDefinition;
  if (definition === undefined || definition === null) {
    section.createEl("p", { text: "Definition unknown; refresh the owner's jobs.json to inspect authored values.", attr: { "data-definition-state": "unknown" } });
    return;
  }
  const identity = cronJobIdentity(job);
  if (identity === null || definition.identity === null || serializeScopedKey(identity) !== serializeScopedKey(definition.identity)) {
    section.createEl("p", { text: "Owner mismatch; execution definition withheld.", attr: { "data-definition-state": "owner-mismatch" } });
    return;
  }
  section.createEl("p", { text: `${identity.connection} / owner ${identity.storageOwnerProfile} / job ${identity.jobId}` });
  section.createEl("p", { text: `Execution mode: ${definition.mode}`, attr: { "data-execution-mode": definition.mode } });
  section.createEl("p", { text: "Authored definition only. Effective model, skills, tools and working directory require an execution snapshot. The scheduler's active profile home is not proof of a per-job profile override." });
  const list = section.createEl("dl", { cls: "hcv-facts" });
  const fields: readonly (readonly [string, Field])[] = [
    ["Prompt", definition.prompt], ["Script", definition.script], ["no_agent", definition.noAgent],
    ["Working directory", definition.workdir], ["skill (raw)", definition.skill], ["skills (raw)", definition.skills],
    ["Toolsets", definition.toolsets], ["Execution profile", definition.executionProfile],
    ["Model", definition.model], ["Provider", definition.provider], ["Reasoning", definition.reasoning],
    ["Delivery", definition.delivery], ["Failure delivery", definition.failureDelivery],
    ["Schedule", definition.schedule], ["Schedule display", definition.scheduleDisplay],
  ];
  for (const [label, field] of fields) {
    list.createEl("dt", { text: `${label} (${field.provenance})`, cls: "hcv-fact-label" });
    const value = list.createEl("dd", { cls: "hcv-fact-value", attr: { "data-provenance": field.provenance } });
    value.createEl("pre", { text: fieldText(field), cls: "hcv-verbatim" });
  }
  section.createEl("p", { text: `Native skill selection: ${definition.skillSource}; ${definition.selectedSkills === null ? "unknown" : JSON.stringify(definition.selectedSkills)}. Non-null skills takes precedence, including an empty list or string; the loader trims and deduplicates.` });
  section.createEl("p", { text: "Empty authored toolsets means zero tools, including MCP. Nonempty overrides may merge configured MCP; denylists still apply. Missing configuration remains unknown." });
  for (const issue of [...definition.issues, ...job.unparsedFields.map((name) => `unparsed:${name}`)]) {
    section.createEl("p", { text: issue, attr: { "data-definition-issue": issue } });
  }
}
