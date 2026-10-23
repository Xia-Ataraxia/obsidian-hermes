import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { inspectProfileSkills } from "../src/domain/profile-skill-parser";
import { parseProfileMetadata } from "../src/domain/profile-metadata-response";
import { ClosedProfileMetadataReader } from "../src/ui/profile-metadata-reader";
import { PROFILE_LIMITS } from "../src/types/profile-catalog";
import { catalogSurface, localProjection, profileKey, syntheticTree } from "./profile-catalog-fixture";

describe("native profile catalog", () => {
  test("keeps zero-job and existing reserved-looking API members", async () => {
    const tree = syntheticTree(), surface = catalogSurface(tree.reader);
    try {
      const roster = await surface.reader.roster();
      expect(roster.profiles.map(p => String(p.profile))).toEqual(["default", "zero-jobs", "python"]);
      expect(roster.coverage.kind).toBe("complete");
      expect(surface.requests.some(path => path.includes("jobs"))).toBe(false);
    } finally { await surface.close(); tree.close(); }
  });
  test("reports missing-default discrepancy without inventing a member", async () => {
    const tree = syntheticTree(), surface = catalogSurface(tree.reader);
    surface.setNames(["zero-jobs"]);
    try {
      const roster = await surface.reader.roster();
      expect(roster.profiles.map(p => String(p.profile))).toEqual(["zero-jobs"]);
      expect(roster.coverage.kind).toBe("incomplete");
    } finally { await surface.close(); tree.close(); }
  });
  test("reports enumeration failure as incomplete", async () => {
    const tree = syntheticTree(), surface = catalogSurface(tree.reader);
    surface.fail();
    try { expect((await surface.reader.roster()).coverage.kind).toBe("incomplete"); }
    finally { await surface.close(); tree.close(); }
  });
  test("keeps canonical duplicate copies and exact relative load names", async () => {
    const tree = syntheticTree();
    try {
      const rows = inspectProfileSkills(await tree.reader.read(profileKey(), {}), "telegram");
      const duplicates = rows.filter(row => row.name === "duplicate");
      expect(duplicates).toHaveLength(3);
      expect(new Set(duplicates.map(row => row.identity)).size).toBe(3);
      expect(duplicates.filter(row => row.source === "local").map(row => [row.resolution, row.loadName])).toEqual([["ambiguous", "one"], ["ambiguous", "two"]]);
      expect(duplicates.find(row => row.source === "external")?.resolution).toBe("shadowed");
    } finally { tree.close(); }
  });
  test("distinguishes global/platform selection, OS and session restrictions", async () => {
    const tree = syntheticTree();
    try {
      const rows = inspectProfileSkills(await tree.reader.read(profileKey(), {}), "telegram");
      expect(rows.find(row => row.name === "off")?.configuredGlobal).toBe("disabled");
      const chat = rows.find(row => row.name === "chat-only");
      expect([chat?.configuredGlobal, chat?.configuredPlatform, chat?.osCompatibility, chat?.effective]).toEqual(["enabled", "disabled", "restricted", "unknown"]);
      expect(chat?.restrictions["session_platforms"]?.values).toEqual(["telegram"]);
    } finally { tree.close(); }
  });
  test("keeps essential skill enabled despite authored disable", async () => {
    const tree = syntheticTree();
    tree.write("config.yaml", "skills:\n  disabled: '[\"hermes-agent\"]'\n");
    tree.write("skills/essential/SKILL.md", "---\nname: hermes-agent\n---\nManual\n");
    try { expect(inspectProfileSkills(await tree.reader.read(profileKey(), {}), "telegram").find(row => row.name === "hermes-agent")?.configuredPlatform).toBe("enabled"); }
    finally { tree.close(); }
  });
  for (const mode of ["missing", "malformed", "unreadable", "shape"] as const) {
    test(`preserves unknown configuration when config is ${mode}`, async () => {
      const tree = syntheticTree();
      switch (mode) {
        case "missing": rmSync(join(tree.root, "config.yaml")); break;
        case "malformed": tree.write("config.yaml", "skills: [\n"); break;
        case "unreadable": chmodSync(join(tree.root, "config.yaml"), 0); break;
        case "shape": tree.write("config.yaml", "skills:\n  disabled: {wrong: shape}\n"); break;
      }
      try {
        const metadata = await tree.reader.read(profileKey(), {});
        expect(inspectProfileSkills(metadata, "telegram").every(row => row.configuredGlobal === "unknown")).toBe(true);
        expect(metadata.coverage.kind).toBe("incomplete");
      } finally { chmodSync(join(tree.root, "skills"), 0o755); tree.close(); }
    });
  }
  test("does not infer agent provenance from absent manifests", async () => {
    const tree = syntheticTree(); rmSync(join(tree.root, "skills/.hub/lock.json"));
    try { expect((await tree.reader.read(profileKey(), {})).candidates.every(row => row.nameSetProvenance === "unknown")).toBe(true); }
    finally { tree.close(); }
  });
  test("retains unknown manifest rows and emits no instruction bodies", async () => {
    const tree = syntheticTree(); tree.write("skills/bad/SKILL.md", "---\nname: [\n---\nSECRET_BODY\n");
    try {
      const metadata = await tree.reader.read(profileKey(), {});
      expect(metadata.candidates.find(row => row.path.includes("/bad/"))?.metadataStatus).toBe("malformed");
      expect(JSON.stringify(metadata)).not.toContain("PRIVATE_INSTRUCTIONS_MUST_NOT_ESCAPE");
      expect(JSON.stringify(metadata)).not.toContain("SECRET_BODY");
    } finally { tree.close(); }
  });
  test("accepts dangling identity marker and existing reserved profile", async () => {
    const tree = syntheticTree(); mkdirSync(join(tree.root, "profiles/python"), { recursive: true }); symlinkSync("missing-config", join(tree.root, "profiles/python/config.yaml"));
    try { expect((await tree.reader.read(profileKey("python"), {})).configuration.status).toBe("missing"); }
    finally { tree.close(); }
  });
  for (const kind of ["tombstone", "markerless"] as const) {
    test(`refuses metadata for native ${kind} profile`, async () => {
      const tree = syntheticTree(); mkdirSync(join(tree.root, "profiles/ghost"), { recursive: true });
      if (kind === "tombstone") { tree.write("profiles/ghost/config.yaml", "{}"); tree.write("profiles/.deleted/ghost", "deleted"); }
      try { const metadata = await tree.reader.read(profileKey("ghost"), {}); expect(metadata.candidates).toHaveLength(0); expect(metadata.coverage.kind).toBe("incomplete"); }
      finally { tree.close(); }
    });
  }
  test("caps traversal safely on symlink cycles", async () => {
    const tree = syntheticTree(); symlinkSync(join(tree.root, "skills"), join(tree.root, "skills/loop"));
    try { const metadata = await tree.reader.read(profileKey(), {}); expect(metadata.candidates.length).toBeLessThan(20); expect(metadata.coverage.kind).toBe("incomplete"); }
    finally { tree.close(); }
  });
  test("reports source drift without scanning guessed semantics", async () => {
    const tree = syntheticTree();
    const reader = new ClosedProfileMetadataReader({ connection: "m1-pro-file", root: tree.root, sourceRoot: tree.root }, localProjection);
    try { const metadata = await reader.read(profileKey(), {}); expect(metadata.candidates).toHaveLength(0); expect(metadata.coverage.kind).toBe("incomplete"); }
    finally { tree.close(); }
  });
  test("rejects abort and stale scope before executing", async () => {
    const tree = syntheticTree(); const controller = new AbortController(); controller.abort();
    try { await expect(tree.reader.read(profileKey(), { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" }); await expect(tree.reader.read(profileKey(), { isCurrent: () => false })).rejects.toMatchObject({ code: "stale" }); }
    finally { tree.close(); }
  });
  test("keeps visible API rows when supplemental sources drift", async () => {
    const tree = syntheticTree();
    const metadata = new ClosedProfileMetadataReader({ connection: "m1-pro-file", root: tree.root, sourceRoot: tree.root }, localProjection);
    const surface = catalogSurface(metadata);
    try { const result = await surface.reader.skills(profileKey()); expect(result.visible).toHaveLength(1); expect(result.coverage.kind).toBe("incomplete"); expect(result.session).toBe("unobserved"); }
    finally { await surface.close(); tree.close(); }
  });
  test("keeps supplemental candidates when native skills JSON is malformed", async () => {
    const tree = syntheticTree(), surface = catalogSurface(tree.reader); surface.malformedSkills();
    try { const result = await surface.reader.skills(profileKey()); expect(result.skills.length).toBeGreaterThan(0); expect(result.visibleCoverage.kind).toBe("incomplete"); }
    finally { await surface.close(); tree.close(); }
  });
  test("refuses wrong connection and oversized boundary responses", async () => {
    const tree = syntheticTree();
    try { await expect(tree.reader.read(profileKey("default", "other"), {})).rejects.toMatchObject({ code: "invalid-scope" }); expect(() => parseProfileMetadata(" ".repeat(PROFILE_LIMITS.outputBytes + 1), profileKey())).toThrow(); }
    finally { tree.close(); }
  });
  test("preserves unknown platform selection without ambient session inference", async () => {
    const tree = syntheticTree(), surface = catalogSurface(tree.reader);
    try { const result = await surface.reader.skills(profileKey()); expect(result.skills.find(row => row.name === "chat-only")?.configuredPlatform).toBe("unknown"); expect(result.skills.every(row => row.effective === "unknown")).toBe(true); }
    finally { await surface.close(); tree.close(); }
  });
});


test("keeps native nullable categories separate from selected and effective state", async () => {
  const tree = syntheticTree();
  const surface = catalogSurface(tree.reader, [
    { name: "off", description: "Synthetic", category: null, enabled: false, usage: 0, provenance: "agent" },
    { name: "chat-only", description: "Synthetic", category: "qa", enabled: true, usage: 0, provenance: "agent" },
  ]);
  try {
    const result = await surface.reader.skills(profileKey(), {}, "telegram");
    expect(result.visible.map(row => row.category)).toEqual([null, "qa"]);
    expect(result.visibleCoverage.kind).toBe("complete");
    expect(result.skills.find(row => row.name === "off")?.configuredGlobal).toBe("disabled");
    expect(result.skills.find(row => row.name === "chat-only")?.configuredPlatform).toBe("disabled");
    expect(result.skills.every(row => row.effective === "unknown")).toBe(true);
    expect(result.session).toBe("unobserved");
    expect(surface.requests.filter(path => path.startsWith("/api/skills"))).toEqual(["/api/skills?profile=default"]);
  } finally { await surface.close(); tree.close(); }
});

test("retains YAML 1.1 booleans and quoted selection strings", async () => {
  const tree = syntheticTree();
  tree.write("config.yaml", "skills:\n  disabled: [y, n, off, 'off']\n  project_discovery: off\n");
  try {
    const metadata = await tree.reader.read(profileKey(), {});
    expect(metadata.configuration.status).toBe("read");
    expect(metadata.configuration.disabled.values).toEqual(["True", "False", "False", "off"]);
    expect(metadata.configuration.projectDiscovery).toBe("disabled");
  } finally { tree.close(); }
});

for (const [label, yaml, status] of [
  ["duplicate keys", "skills: {}\nskills: {}\n", "malformed"],
  ["alias", "skills: &shared {}\nother: *shared\n", "unsupported"],
  ["unsafe tag", "skills: !!python/object/apply:os.system ['false']\n", "malformed"],
  ["depth", "skills: " + "[".repeat(33) + "0" + "]".repeat(33), "unsupported"],
  ["events", "irrelevant: [" + Array(10001).fill("0").join(",") + "]\n", "unsupported"],
] as const) {
  test(`keeps ${label} YAML configuration unknown`, async () => {
    const tree = syntheticTree(); tree.write("config.yaml", yaml);
    try {
      const metadata = await tree.reader.read(profileKey(), {});
      expect(metadata.configuration.status).toBe(status);
      expect(inspectProfileSkills(metadata, null).every(row => row.configuredGlobal === "unknown")).toBe(true);
    } finally { tree.close(); }
  });
}
