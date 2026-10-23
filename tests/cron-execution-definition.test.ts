import { describe, expect, test } from "bun:test";
import { cronJobIdentity, matchesCronOwner, matchesCronProfile } from "../src/domain/cron-execution-definition";
import { parseJobsJson } from "../src/domain/jobs-json-parser";
import { serializeScopedKey } from "../src/domain/control-center-validation";
import { renderCronExecutionDefinition } from "../src/ui/cron-execution-definition-panel";
import type { CronDefinitionElement } from "../src/ui/cron-execution-definition-panel";
import type { CronJobRecord, SourceKey } from "../src/types/hermes-cron";

const OWNER: SourceKey = { alias: "m1-file", profileId: "default" };
function parsed(fields: Readonly<Record<string, unknown>> = {}, owner = OWNER): CronJobRecord {
  const job = parseJobsJson(owner, { jobs: [{ id: "same-id", ...fields }] }).jobs[0];
  if (job === undefined) throw new TypeError("Expected fixture job");
  return job;
}

function surface() {
  const nodes: { tag: string; text: string; attr: Readonly<Record<string, string>> }[] = [];
  const root: CronDefinitionElement = {
    createEl(tag, options) {
      nodes.push({ tag, text: options?.text ?? "", attr: options?.attr ?? {} });
      return root;
    },
  };
  return { root, nodes };
}

describe("authored cron definitions", () => {
  test.each([false, " HIGH ", "disabled", { enabled: false }, { enabled: true, effort: "thinking" }])("preserves native reasoning form %j", (value) => {
    // Given a native-supported reasoning shape; when parsed; then its exact authored JSON survives.
    const reasoning = parsed({ reasoning_effort: value }).executionDefinition?.reasoning;
    expect(reasoning?.provenance).toBe("authored");
    expect(reasoning?.raw).toBe(JSON.stringify(value));
  });
  test.each([
    [{ prompt: "synthetic-agent" }, "agent"],
    [{ script: "synthetic-context.py", no_agent: false }, "script-context"],
    [{ script: "synthetic-only.py", no_agent: true }, "script-only"],
    [{ no_agent: true }, "unknown"],
    [{ no_agent: "yes", script: "synthetic.py" }, "unknown"],
  ] as const)("identifies mode for %j", (fields, mode) => {
    // Given an authored job; when parsed; then execution mode follows the native no_agent split.
    expect(parsed(fields).executionDefinition?.mode).toBe(mode);
  });

  test.each([
    [{ skills: [" alpha ", "alpha", " ", "beta"], skill: "legacy" }, ["alpha", "beta"], "skills"],
    [{ skills: [], skill: "legacy" }, [], "skills"],
    [{ skills: "", skill: "legacy" }, [], "skills"],
    [{ skills: " alpha ", skill: "legacy" }, ["alpha"], "skills"],
    [{ skills: null, skill: " legacy " }, ["legacy"], "skill"],
    [{ skill: "legacy" }, ["legacy"], "skill"],
    [{}, [], "none"],
    [{ skills: 17, skill: "legacy" }, null, "skills"],
  ] as const)("selects native skills without cross-field fallback for %j", (fields, names, source) => {
    // Given distinct plural and legacy inputs; when parsed; then only the native winner is selected.
    const definition = parsed(fields).executionDefinition;
    expect(definition?.selectedSkills).toEqual(names);
    expect(definition?.skillSource).toBe(source);
  });

  test("retains raw singular and plural fields before loader normalization", () => {
    // Given conflicting whitespace and duplicate authored fields.
    const fields = { skill: " legacy ", skills: ["alpha", "alpha", " beta "] };
    // When parsing the owner-scoped raw store.
    const definition = parsed(fields).executionDefinition;
    // Then raw values survive and the conflict is observable independently of normalized selection.
    expect(definition?.skill.raw).toBe(JSON.stringify(fields.skill));
    expect(definition?.skills.raw).toBe(JSON.stringify(fields.skills));
    expect(definition?.issues).toContain("skill-skills-conflict");
  });

  test("keeps duplicate IDs isolated by owner and connection despite authored execution profiles", () => {
    // Given identical IDs authored to run with a third profile.
    const owners = [OWNER, { ...OWNER, profileId: "xia" }, { ...OWNER, alias: "other-host" }];
    // When deriving identity from each raw source.
    const keys = owners.map((owner) => cronJobIdentity(parsed({ profile: "executor" }, owner)));
    // Then every scoped key differs and retains its storage owner.
    const serialized = keys.map((key) => key === null ? null : serializeScopedKey(key));
    expect(new Set(serialized).size).toBe(3);
    expect(keys.map((key) => String(key?.storageOwnerProfile))).toEqual(["default", "xia", "default"]);
    expect(parsed({ profile: "executor" }).executionDefinition?.executionProfile.value).toBe("executor");
  });

  test("rejects all-profile sources and owner/profile-home substitution", () => {
    // Given a job stored under default with an authored xia execution profile.
    const job = parsed({ profile: "xia" });
    // When checking proposed detail/read owners.
    const accepted = [
      matchesCronOwner(job, { ...OWNER, profileId: "xia" }),
      matchesCronProfile(job, { ...OWNER, home: "/Users/test/.hermes/profiles/xia" }),
      parseJobsJson({ ...OWNER, profileId: "all" }, { jobs: [{ id: "same-id" }] }).recognized,
      matchesCronProfile(job, { ...OWNER, home: "/Users/test/.hermes" }),
    ];
    // Then only the actual storage-owner profile/home is usable.
    expect(accepted).toEqual([false, false, false, true]);
  });

  test("labels malformed fields and keeps unknown keys visible on their own row", () => {
    // Given malformed values and a forward-version field.
    const fields = { script: { content: "synthetic" }, no_agent: true, enabled_toolsets: "*", reasoning_effort: "telepathic", schedule: { kind: "new-kind" }, new_field: 1 };
    // When parsing without coercing the malformed inputs.
    const job = parsed(fields);
    // Then the raw evidence survives with unknown classification.
    expect(job.executionDefinition?.issues).toEqual(expect.arrayContaining(["no-agent-without-script", "unknown:script", "unknown:toolsets", "unknown:reasoning", "unknown:schedule"]));
    expect(job.executionDefinition?.script.raw).toBe(JSON.stringify(fields.script));
    expect(job.unparsedFields).toEqual(["new_field"]);
  });

  test("retains every authored execution field and distinguishes empty toolsets from inheritance", () => {
    // Given fully authored execution settings.
    const fields = { prompt: "synthetic-prompt", script: "synthetic.py", workdir: "/synthetic", no_agent: false, enabled_toolsets: [], model: "fixture-model", provider: "fixture-provider", reasoning_effort: "high", deliver: ["local"], failure_deliver: "origin", schedule: { kind: "cron", expr: "0 9 * * *" }, schedule_display: "fixture-display" };
    // When parsing each setting into a provenance-bearing field.
    const definition = parsed(fields).executionDefinition;
    // Then explicit values remain authored; absent settings do not manufacture runtime values.
    expect(definition?.toolsets).toEqual({ provenance: "authored", value: [], raw: "[]" });
    expect(definition?.workdir.value).toBe(fields.workdir);
    expect(definition?.prompt.value).toBe(fields.prompt);
    expect(definition?.script.value).toBe(fields.script);
    expect(definition?.model.value).toBe(fields.model);
    expect(definition?.provider.value).toBe(fields.provider);
    expect(definition?.reasoning.value).toBe(fields.reasoning_effort);
    expect(definition?.delivery.value).toEqual(fields.deliver);
    expect(definition?.failureDelivery.value).toBe(fields.failure_deliver);
    expect(definition?.schedule.raw).toBe(JSON.stringify(fields.schedule));
    expect(definition?.scheduleDisplay.value).toBe(fields.schedule_display);
    expect(parsed().executionDefinition?.toolsets).toEqual({ provenance: "inherited", value: null, raw: null });
    expect(parsed().executionDefinition?.executionProfile).toEqual({ provenance: "inherited", value: null, raw: null });
  });
});

describe("read-only definition surface", () => {
  test("renders authored content inertly with provenance and no executable controls", () => {
    // Given script and prompt strings containing markup and shell syntax.
    const job = parsed({ prompt: "<img src=x onerror=alert(1)>", script: "$(touch /synthetic)\n<script>fixture</script>", no_agent: true });
    const rendered = surface();
    // When rendering the real panel against a structural DOM recording sink.
    renderCronExecutionDefinition(rendered.root, job);
    // Then exact content is passed only as text and authored provenance is visible.
    expect(rendered.nodes.filter((node) => node.tag === "pre").map((node) => node.text)).toContain(job.prompt ?? "");
    expect(rendered.nodes.filter((node) => node.tag === "pre").map((node) => node.text)).toContain(job.executionDefinition?.script.value ?? "");
    expect(rendered.nodes.some((node) => node.attr["data-provenance"] === "authored")).toBe(true);
    expect(rendered.nodes.some((node) => ["button", "a", "input", "script"].includes(node.tag))).toBe(false);
  });

  test("withholds definitions when a record is rebound to another owner", () => {
    // Given an owner-scoped definition rebound to a sibling job source.
    const job = { ...parsed({ script: "synthetic-secret" }), source: { ...OWNER, profileId: "xia" } };
    const rendered = surface();
    // When rendering the mismatched record.
    renderCronExecutionDefinition(rendered.root, job);
    // Then no authored fields are rendered and mismatch is explicit.
    expect(rendered.nodes.some((node) => node.attr["data-definition-state"] === "owner-mismatch")).toBe(true);
    expect(rendered.nodes.filter((node) => node.tag === "pre")).toHaveLength(0);
  });

  test("shows absent restored definitions as unknown", () => {
    // Given a metadata-only restored record.
    const job = { ...parsed(), executionDefinition: null };
    const rendered = surface();
    // When rendering without runtime evidence.
    renderCronExecutionDefinition(rendered.root, job);
    // Then the unknown state has no inherited or authored values.
    expect(rendered.nodes.some((node) => node.attr["data-definition-state"] === "unknown")).toBe(true);
    expect(rendered.nodes.some((node) => node.attr["data-provenance"] !== undefined)).toBe(false);
  });
});
