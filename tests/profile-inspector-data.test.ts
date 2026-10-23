import { expect, test } from "bun:test";
import { parseScopedIdentity } from "../src/domain/control-center-validation";
import type { ProfileKey } from "../src/types/control-center";
import { readInspectorCron, inspectorProfileRef } from "../src/ui/profile-inspector-data";
import { SshReadOnlyAdapter } from "../src/ui/ssh-read-only-adapter";
import type { ProfileSkillCatalog } from "../src/types/profile-catalog";

function key(name = "xia"): ProfileKey {
  const parsed = parseScopedIdentity({ kind: "profile", connection: "fixture", profile: name });
  if (!parsed.ok || parsed.value.kind !== "profile") throw new TypeError("Invalid fixture profile");
  return parsed.value;
}
const ref = { alias: "fixture", profileId: "xia", home: "/synthetic/.hermes/profiles/xia" };
function adapter(stdout: string, exitCode: number | null = 0, capExceeded = false) {
  return new SshReadOnlyAdapter({ runner: async () => ({ stdout, stderr: "", exitCode, capExceeded }) });
}
function catalog(profile = key()): ProfileSkillCatalog {
  return { profile, metadata: null, skills: [], visible: [], visibleCoverage: { kind: "complete" }, coverage: { kind: "unknown" }, freshness: { kind: "unknown", lastSuccessAt: null }, session: "unobserved", platform: null };
}

test("only an explicit valid empty jobs array establishes zero jobs", async () => {
  expect(await readInspectorCron(adapter('{"jobs":[]}'), ref, {})).toMatchObject({ status: "read", jobs: [] });
  expect(await readInspectorCron(adapter(""), ref, {})).toMatchObject({ status: "missing" });
  expect(await readInspectorCron(adapter("{"), ref, {})).toMatchObject({ status: "unavailable" });
  expect(await readInspectorCron(adapter('{}'), ref, {})).toMatchObject({ status: "unavailable" });
});

test.each([1, 127, 255, null])("successful-looking JSON with inner exit %s is unavailable", async exit => {
  expect((await readInspectorCron(adapter('{"jobs":[]}', exit), ref, {})).status).toBe("unavailable");
});

test("capped job JSON never establishes a complete empty list", async () => {
  expect((await readInspectorCron(adapter('{"jobs":[]}', 0, true), ref, {})).status).toBe("unavailable");
});

test("the storage owner remains xia when authored execution names default", async () => {
  const result = await readInspectorCron(adapter(JSON.stringify({ jobs: [{ id: "same-job", profile: "default", script: "<script>inert</script>" }] })), ref, {});
  expect(result.jobs[0]?.source).toEqual({ alias: "fixture", profileId: "xia" });
  expect(result.jobs[0]?.executionDefinition?.executionProfile.value).toBe("default");
  expect(result.jobs[0]?.executionDefinition?.script.value).toBe("<script>inert</script>");
});

test("abandoned reads cannot return the prior owner's jobs", async () => {
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const seen = new Promise<void>(resolve => { started = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  const delayed = new SshReadOnlyAdapter({ runner: async () => { started?.(); await wait; return { stdout: '{"jobs":[]}', stderr: "", exitCode: 0, capExceeded: false }; } });
  const pending = readInspectorCron(delayed, ref, { signal: controller.signal });
  await seen;
  controller.abort();
  release?.();
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });
});

test("metadata absence cannot be replaced by a guessed roster home", () => {
  expect(inspectorProfileRef(key(), catalog())).toBeNull();
  expect(() => inspectorProfileRef(key("default"), catalog())).toThrow();
});
