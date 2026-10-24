import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import type { PluginInfo, SkillInfo } from "../src/hermes/inspect";

// bun shares one module registry across test files, so every "obsidian" mock declares the same names (see chat.test.ts).
mock.module("obsidian", () => ({ parseYaml: Bun.YAML.parse, MarkdownRenderer: { render: async () => {} } }));
const { byLeastRecent, InspectClient, nextDisabled, parseDetail, pluginLastUsed } = await import("../src/hermes/inspect");

const H = "/home/u/.hermes", P = `${H}/profiles/xia`, LOCAL = `${P}/skills`, OMH = "/home/u/.omh/profiles/xia/skills", SHARED = `${H}/skills-shared`;
const CRAFT = `${P}/plugins/craft-skills`, MEMO = `${P}/plugins/memo`, DUSTY = `${P}/plugins/dusty`;
const NS = "agent-plugin-craft-skills-4bef6edb";

const cfg = `skills:
  disabled: [gone, cat/byrdir, "${NS}:ship"]
  platform_disabled:
    telegram: [local-one]
plugins:
  enabled: [craft-skills, memo]
  disabled: [dusty]
  entries:
    omh:
      settings: { omh_home: ~/.omh/profiles/xia/ }
    memo:
      settings:
        api_key: sk-secret
        endpoint: https://user:pw@example.com/v1
        nested: { auth_token: abc, depth: 3 }
memory:
  provider: memo
`;

const rows = [
  [3, SHARED, "core/plan", "name: plan", null],
  [1, LOCAL, "core/plan", "name: plan\ndescription: Plans", 1],
  [1, LOCAL, "core/edit", "name: edit", 0],
  [1, LOCAL, "hubby", "name: hubby", null],
  [1, LOCAL, "local-one", "", null],
  [1, LOCAL, "gone", "name: gone", null],
  [1, LOCAL, "hermes-agent", "name: hermes-agent", 1],
  [3, OMH, "omh-skill", "name: omh-skill", null],
  [3, SHARED, "cat/byrdir", "name: byrdir", null],
  [4, `${CRAFT}/skills`, "ship", "name: ship\ndescription: Ships", null],
  [4, `${DUSTY}/skills`, "dust", "name: dust", null],
  [4, `${H}/hermes-agent/plugins/disk-cleanup/skills`, "sweep", "", null],
];

const sections = (extra: [string, string][] = []): Map<string, string> => new Map([
  ["home", "/home/u"],
  ["cfg", cfg],
  ["sksum", "123 45"],
  [`manifest u craft-skills ${CRAFT}/plugin.json`, JSON.stringify({ name: "craft-skills", version: "1.2.0", extensions: { "com.nousresearch.hermes": { provides_tools: ["craft_run"] } } })],
  [`manifest u memo ${MEMO}/plugin.yaml`, "name: memo\nkind: backend\nversion: 0.3\nrequires_env:\n  - MEMO_KEY\nprovides_hooks: [on_turn]\n"],
  [`manifest u dusty ${DUSTY}/plugin.yaml`, "name: dusty\n"],
  [`manifest b memo ${H}/hermes-agent/plugins/memory/memo/plugin.yaml`, "name: memo\nversion: 9\n"],
  [`manifest b disk-cleanup ${H}/hermes-agent/plugins/disk-cleanup/plugin.yaml`, "name: disk-cleanup\n"],
  ["skills", JSON.stringify(rows)],
  ["usage", JSON.stringify({ plan: [1700000000, 5], "local-one": [null, 0], ship: [1700000100, 2] })],
  ["hub", JSON.stringify({ hubby: ["github", "community", "safe"] })],
  ["bundled", "plan\nedit\nhermes-agent"],
  ["install", JSON.stringify({ memo: { source: "https://tok:x@github.com/a/memo.git", revision: "0123456789abcdef0123456789abcdef01234567", pinned: true } })],
  ...extra,
  ["end", ""],
]);

test("parseDetail classifies sources, dedupes by tier, matches disabled spellings and masks secrets", async () => {
  const detail = await parseDetail(sections(), 1);
  if (typeof detail === "string") throw new Error(detail);
  expect(detail.skills.map(skill => [skill.name, skill.source, skill.enabled])).toEqual([
    ["plan", "bundled", true],
    ["edit", "modified", true],
    ["hubby", "hub", true],
    ["local-one", "local", true],
    ["gone", "local", false],
    ["hermes-agent", "bundled", true],
    ["omh-skill", "omh", true],
    ["byrdir", "shared", false],
    [`${NS}:ship`, "plugin", false],
  ]);
  const skill = (name: string): SkillInfo => detail.skills.find(item => item.name === name)!;
  expect(skill("plan")).toMatchObject({ tier: 1, path: `${LOCAL}/core/plan/SKILL.md`, category: "core", lastUsed: 1700000000, uses: 5, description: "Plans" });
  expect(skill("local-one")).toMatchObject({ platformOff: ["telegram"], lastUsed: null, uses: 0 });
  expect(skill("hubby").verdict).toBe("safe");
  expect(skill("omh-skill").owner).toBe("omh");
  expect(skill(`${NS}:ship`)).toMatchObject({ owner: "craft-skills", category: "craft-skills", tier: 4, lastUsed: 1700000100, uses: 2 });
  const shadowed = await parseDetail(sections([["skills", JSON.stringify([[1, LOCAL, "ship", "", null], rows[9]])]]), 1);
  expect(typeof shadowed !== "string" && shadowed.skills.map(item => [item.name, item.lastUsed])).toEqual([["ship", 1700000100], [`${NS}:ship`, null]]);
  expect(skill("hermes-agent").readOnly).toBe("Essential");

  expect(detail.plugins.map(plugin => [plugin.key, plugin.origin, plugin.status])).toEqual([
    ["craft-skills", "user", "enabled"],
    ["memo", "user", "enabled"],
    ["dusty", "user", "disabled"],
  ]);
  const [craft, memo] = detail.plugins;
  expect(craft).toMatchObject({ namespace: NS, tools: ["craft_run"], skills: 1, readOnly: null });
  expect(memo).toMatchObject({
    kind: "backend", version: "0.3", env: ["MEMO_KEY"], hooks: ["on_turn"],
    source: "https://github.com/a/memo.git @0123456 · pinned",
    readOnly: "Active via memory.provider; switch it in config.yaml",
    settings: [["api_key", "••••"], ["endpoint", "https://example.com/v1"], ["nested.auth_token", "••••"], ["nested.depth", "3"]],
  });
  expect(JSON.stringify(detail)).not.toMatch(/sk-secret|pw@|tok:x|abc/);
  expect(detail).toMatchObject({ home: "/home/u", sksum: "123 45", platformDisabled: { telegram: ["local-one"] } });
});

test("parseDetail locks toggles when skills.disabled isn't a plain list and rejects a cut-off read", async () => {
  const locked = await parseDetail(new Map([["cfg", "skills:\n  disabled: oops\n"], ["skills", JSON.stringify([[1, LOCAL, "a", "", null]])], ["end", ""]]), 1);
  if (typeof locked === "string") throw new Error(locked);
  expect(locked.disabled).toBeNull();
  expect(locked.skills[0]?.readOnly).toBe("skills.disabled isn't a plain list; edit config.yaml");
  const mixed = await parseDetail(new Map([["cfg", "skills:\n  disabled: [a, 1]\n"], ["skills", JSON.stringify([[1, LOCAL, "a", "", null]])], ["end", ""]]), 1);
  expect(typeof mixed !== "string" && [mixed.disabled, mixed.skills[0]?.readOnly]).toEqual([null, "skills.disabled isn't a plain list; edit config.yaml"]);
  expect(await parseDetail(new Map([["home", "/home/u"]]), 1)).toBe("Incomplete read");
  expect(await parseDetail(new Map([["cfg", "skills: ["], ["end", ""]]), 1)).toBe("Couldn't parse config.yaml");
});

test("nextDisabled appends the name once and drops every spelling; plugin skills match by name only", () => {
  const local = { tier: 1, name: "byrdir", rdir: "cat/byrdir" } as SkillInfo;
  const plugin = { tier: 4, name: "ns:ship", rdir: "ship" } as SkillInfo;
  expect(nextDisabled(["a"], local, false)).toEqual(["a", "byrdir"]);
  expect(nextDisabled(["cat/byrdir"], local, false)).toEqual(["cat/byrdir"]);
  expect(nextDisabled(["a", "byrdir", "cat/byrdir"], local, true)).toEqual(["a"]);
  expect(nextDisabled(["ship", "ns:ship"], plugin, true)).toEqual(["ship"]);
});

test("least recently used sorts first and plugin use takes the latest tool or skill", () => {
  const at = (name: string, lastUsed: number | null): SkillInfo => ({ name, lastUsed }) as SkillInfo;
  expect([at("b", 5), at("c", null), at("a", null), at("d", 1)].sort(byLeastRecent).map(skill => skill.name)).toEqual(["a", "c", "d", "b"]);
  const plugin = (name: string, tools: string[]): PluginInfo => ({ key: name, name, tools }) as unknown as PluginInfo;
  expect(pluginLastUsed(plugin("x", ["t1", "t2"]), { t1: 10, t2: 30, other: 99 }, [])).toBe(30);
  expect(pluginLastUsed(plugin("memo", []), { memo_save: 40, memox: 99 }, [])).toBe(40);
  const owned = [{ owner: "craft", tier: 4, lastUsed: 50 }, { owner: "other", tier: 4, lastUsed: 99 }] as SkillInfo[];
  expect(pluginLastUsed(plugin("craft", []), {}, owned)).toBe(50);
  expect(pluginLastUsed(plugin("idle", []), { other_x: 1 }, [])).toBeNull();
});

test("the client reads and saves only what the cached Detail lists, and enables plugins without touching grants", async () => {
  const sent: string[] = [];
  const last = (): string => sent[sent.length - 1]!;
  const detailOut = [...sections([["cfgsum", "678 90"]])].map(([name, body]) => `\u001e${name}\n${body}\n`).join("");
  let printed = "";
  const client = new InspectClient({ run: async (_alias: string, command: { remoteCommand: string }) => {
    const script = Buffer.from(command.remoteCommand.match(/printf %s (\S+)/)![1]!, "base64").toString();
    sent.push(script);
    const stdout = script.includes("S cfgsum") ? detailOut : script.includes("S body") ? "\u001esum\n1 3\n\u001ebody\nhi\nx" : `\u001eok\n${printed}`;
    return { transport: "connected", exitCode: 0, stdout, stderr: "", capExceeded: false };
  } } as never);
  const skill = `${LOCAL}/core/plan/SKILL.md`;
  expect(await client.save("h", "xia", "SOUL.md", "1 3", "x")).toEqual({ ok: false, message: "Changed on the server. Reload first." });
  expect(await client.read("h", "xia", skill)).toBe("Not a readable file");
  expect(sent).toHaveLength(0);
  expect(await client.read("h", "xia", "SOUL.md")).toEqual({ text: "hi\n", sum: "1 3" });

  const detail = await client.detail("h", "xia");
  if (typeof detail === "string") throw new Error(detail);
  expect(detail.cfgsum).toBe("678 90");
  const count = sent.length;
  expect(await client.read("h", "xia", "config.yaml")).toBe("Not a readable file");
  expect(sent).toHaveLength(count);
  expect(await client.read("h", "xia", skill)).toEqual({ text: "hi\n", sum: "1 3" });
  expect(await client.save("h", "xia", skill, "1 3", "new")).toEqual({ ok: true });
  expect(last()).toContain(`cksum)" = '678 90' ] || { echo "Changed on the server. Reload first." >&2; exit 3; }`);
  expect(last()).toContain("pwd -P");
  expect(await client.save("h", "xia", "SOUL.md", "1 3", "new")).toEqual({ ok: true });

  const craft = detail.plugins[0]!;
  printed = "✓ Plugin craft-skills enabled.\nNon-interactive session: capabilities NOT granted (fail closed). Run\n`hermes plugins capabilities craft-skills` to review.";
  expect(await client.togglePlugin("h", "xia", craft, true)).toEqual({ ok: true, ungranted: true });
  const enable = sent.find(script => script.includes("plugins enable"))!;
  expect(enable).not.toContain("allow-tool-override");
  printed = "Plugin 'craft-skills' is already enabled.";
  expect(await client.togglePlugin("h", "xia", craft, true)).toEqual({ ok: true });
  expect(await client.togglePlugin("h", "xia", craft, false)).toEqual({ ok: true });

  // The detail, read, save and plugin scripts all parse.
  for (const script of sent) expect(spawnSync("sh", ["-n"], { input: script }).status).toBe(0);
});

test("save refuses a malformed sum or cfgsum, quote injection included, without reaching the host", async () => {
  let cfgsum = "678 90", calls = 0;
  const client = new InspectClient({ run: async () => {
    calls++;
    const stdout = [...sections([["cfgsum", cfgsum]])].map(([name, body]) => `\u001e${name}\n${body}\n`).join("");
    return { transport: "connected", exitCode: 0, stdout, stderr: "", capExceeded: false };
  } } as never);
  const refused = async (sum: string): Promise<void> => {
    const before = calls;
    expect(await client.save("h", "xia", `${LOCAL}/core/plan/SKILL.md`, sum, "x")).toEqual({ ok: false, message: "Changed on the server. Reload first." });
    expect(calls).toBe(before);
  };
  await client.detail("h", "xia");
  for (const sum of ["1 3' ; touch PWNED ; '", "1 3\n", "", "missing'"]) await refused(sum);
  for (const bad of ["1 2' ; touch PWNED ; '", ""]) {
    cfgsum = bad;
    await client.detail("h", "xia", true);
    await refused("1 3");
  }
});

test("a failed usage read resolves null and isn't cached; a detail read without fresh joins the one in flight", async () => {
  let calls = 0;
  const client = new InspectClient({ run: async () => {
    calls++;
    if (calls === 1) return { transport: "timeout", exitCode: null, stdout: "", stderr: "", capExceeded: false };
    if (calls === 2) throw new Error("ssh down");
    return { transport: "connected", exitCode: 0, stdout: "\u001etools\n{\"web_search\":1700000000}\n\u001eend\n", stderr: "", capExceeded: false };
  } } as never);
  expect(await client.tools("h", "xia")).toBeNull();
  expect(await client.tools("h", "xia")).toBeNull();
  expect(await client.tools("h", "xia")).toEqual({ web_search: 1700000000 });
  expect(await client.tools("h", "xia")).toEqual({ web_search: 1700000000 });
  expect(calls).toBe(3);
  // The inspector's stale refresh joins a detail read in flight; a post-write read (fresh) starts its own.
  const first = client.detail("h", "xia");
  expect(client.detail("h", "xia")).toBe(first);
  const fresh = client.detail("h", "xia", true);
  expect(fresh).not.toBe(first);
  await Promise.all([first, fresh]);
  expect(calls).toBe(5);
});
