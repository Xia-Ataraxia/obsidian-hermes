import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { PROFILE_METADATA_PYTHON } from "../src/domain/profile-metadata-python";
import { parseProfileMetadata } from "../src/domain/profile-metadata-response";
import { inspectProfileSkills } from "../src/domain/profile-skill-parser";
import { ClosedProfileMetadataReader } from "../src/ui/profile-metadata-reader";
import { PROFILE_LIMITS } from "../src/types/profile-catalog";
import { gate } from "./dashboard-client-fixture";
import { catalogSurface, localProjection, profileKey, PYTHON, SOURCE_ROOT, syntheticTree } from "./profile-catalog-fixture";

test("rejects the old selection when a newer selection finishes", async () => {
  const tree = syntheticTree(), seen = gate<void>(), release = gate<void>(); let calls = 0;
  const metadata = new ClosedProfileMetadataReader({ connection: "m1-pro-file", root: tree.root, sourceRoot: SOURCE_ROOT }, async (request, signal) => {
    if (++calls === 1) { seen.resolve(); await release.promise; }
    return localProjection(request, signal);
  });
  const surface = catalogSurface(metadata);
  try {
    const previous = surface.reader.skills(profileKey()).catch((error: unknown) => error);
    await seen.promise;
    const current = await surface.reader.skills(profileKey(), {}, "telegram");
    release.resolve();
    expect(await previous).toMatchObject({ code: "stale" });
    expect(current.platform).toBe("telegram");
  } finally { release.resolve(); await surface.close(); tree.close(); }
});

test("disposal prevents late metadata delivery", async () => {
  const tree = syntheticTree(), seen = gate<void>(), release = gate<void>();
  const metadata = new ClosedProfileMetadataReader({ connection: "m1-pro-file", root: tree.root, sourceRoot: SOURCE_ROOT }, async (request, signal) => { seen.resolve(); await release.promise; return localProjection(request, signal); });
  const surface = catalogSurface(metadata);
  try {
    const pending = surface.reader.skills(profileKey()).catch((error: unknown) => error);
    await seen.promise; surface.reader.dispose(); release.resolve(); expect(await pending).toMatchObject({ code: "aborted" });
  } finally { release.resolve(); await surface.close(); tree.close(); }
});

for (const cap of ["candidates", "directories", "fileBytes", "totalBytes", "deadlineMs"] as const) {
  test(`reports incomplete/unknown when ${cap} bound is exceeded`, async () => {
    const tree = syntheticTree();
    const input = { connection: "m1-pro-file", profile: "default", root: tree.root, sourceRoot: SOURCE_ROOT, limits: { ...PROFILE_LIMITS, [cap]: 1 } };
    try {
      const result = await promisify(execFile)(PYTHON, ["-I", "-B", "-c", PROFILE_METADATA_PYTHON, JSON.stringify(input)], { maxBuffer: 4_194_304, timeout: 15_000 });
      const metadata = parseProfileMetadata(result.stdout, profileKey());
      expect(metadata.coverage.kind).toBe("incomplete");
      const expected = cap === "deadlineMs" ? "deadline" : cap === "candidates" || cap === "directories" ? "row-cap" : "byte-cap";
      expect(metadata.coverage.kind === "incomplete" ? metadata.coverage.reasons : []).toContain(expected);
      expect(metadata.candidates.length).toBeLessThanOrEqual(1);
      expect(inspectProfileSkills(metadata, "telegram").every(row => row.resolution === "unknown")).toBe(true);
    } finally { tree.close(); }
  });
}

test("normalizes authored string-array selection and exact relative aliases", async () => {
  const tree = syntheticTree(); tree.write("config.yaml", "skills:\n  disabled: '[\"one\"]'\n  external_dirs: [external]\n");
  try {
    const metadata = await tree.reader.read(profileKey(), {});
    const rows = inspectProfileSkills(metadata, "telegram");
    expect(metadata.configuration.disabled.shape).toBe("str");
    expect(rows.find(row => row.loadName === "one")?.configuredGlobal).toBe("disabled");
    expect(rows.find(row => row.loadName === "two")?.configuredGlobal).toBe("enabled");
  } finally { tree.close(); }
});

test("prefers identical root SKILL.md over deeper copy by native rank", async () => {
  const tree = syntheticTree(); const content = "---\nname: identical\n---\nSame bytes\n";
  tree.write("skills/SKILL.md", content); tree.write("skills/nested/SKILL.md", content);
  try {
    const rows = inspectProfileSkills(await tree.reader.read(profileKey(), {}), null).filter(row => row.name === "identical");
    expect(rows.find(row => row.relativePath === ".")?.resolution).toBe("unique");
    expect(rows.find(row => row.relativePath === "nested")?.resolution).toBe("shadowed");
  } finally { tree.close(); }
});

test("preserves hub/bundled name-set provenance separately from source root", async () => {
  const tree = syntheticTree();
  tree.write("skills/.hub/lock.json", '{"installed":{"duplicate":{"install_path":"one"}}}');
  tree.write("skills/.bundled_manifest", "off:hash\n");
  try {
    const metadata = await tree.reader.read(profileKey(), {});
    expect(metadata.candidates.filter(row => row.name === "duplicate")).toHaveLength(3);
    expect(metadata.candidates.filter(row => row.name === "duplicate").every(row => row.nameSetProvenance === "hub")).toBe(true);
    expect(metadata.candidates.find(row => row.name === "off")?.nameSetProvenance).toBe("bundled");
  } finally { tree.close(); }
});

test("retains authored long name while using native truncated load identity", async () => {
  const tree = syntheticTree(); const name = "a".repeat(70);
  tree.write("skills/long/SKILL.md", `---\nname: ${name}\n---\nPrivate\n`);
  try { const row = (await tree.reader.read(profileKey(), {})).candidates.find(row => row.path.includes("/long/")); expect(row?.declaredName).toBe(name); expect(row?.name).toBe("a".repeat(64)); }
  finally { tree.close(); }
});

test("keeps lexical symlink views distinct even when canonical paths match", async () => {
  const tree = syntheticTree(); symlinkSync(join(tree.root, "skills/one"), join(tree.root, "skills/alias"));
  try {
    const rows = inspectProfileSkills(await tree.reader.read(profileKey(), {}), null).filter(row => row.name === "duplicate");
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map(row => row.identity)).size).toBe(4);
    expect(new Set(rows.map(row => row.canonicalPath)).size).toBe(3);
  } finally { tree.close(); }
});

test("keeps alias-based configured selection unknown with unreadable candidates", async () => {
  const tree = syntheticTree(); tree.write("config.yaml", "skills:\n  disabled: [one]\n");
  tree.write("skills/bad/SKILL.md", "---\nname: [\n---\nPrivate\n");
  try {
    const rows = inspectProfileSkills(await tree.reader.read(profileKey(), {}), null);
    expect(rows.find(row => row.relativePath === "one")?.resolution).toBe("unknown");
    expect(rows.find(row => row.relativePath === "one")?.configuredGlobal).toBe("unknown");
  } finally { tree.close(); }
});

test("returns parser-unavailable metadata as unknown without creating sources", async () => {
  const tree = syntheticTree();
  const input = { connection: "m1-pro-file", profile: "default", root: tree.root, sourceRoot: SOURCE_ROOT, limits: PROFILE_LIMITS };
  try {
    const result = await promisify(execFile)(PYTHON, ["-I", "-B", "-S", "-c", PROFILE_METADATA_PYTHON, JSON.stringify(input)], { maxBuffer: 4_194_304, timeout: 15_000 });
    const metadata = parseProfileMetadata(result.stdout, profileKey());
    expect(metadata.configuration.status).toBe("unsupported");
    expect(inspectProfileSkills(metadata, null).every(row => row.configuredGlobal === "unknown")).toBe(true);
  } finally { tree.close(); }
});

test("detects a configuration change during the one-shot read", async () => {
  const tree = syntheticTree();
  const input = { connection: "m1-pro-file", profile: "default", root: tree.root, sourceRoot: SOURCE_ROOT, limits: PROFILE_LIMITS };
  const fault = "import sys\nfrom pathlib import Path\ndef change(frame,event,arg):\n if event == 'return' and frame.f_code.co_name == 'configuration':\n  Path(frame.f_globals['home'] / 'config.yaml').write_text('skills: {}\\n')\n  sys.settrace(None)\n return change\nsys.settrace(change)\n";
  try {
    const result = await promisify(execFile)(PYTHON, ["-I", "-B", "-c", fault + PROFILE_METADATA_PYTHON, JSON.stringify(input)], { maxBuffer: 4_194_304, timeout: 15_000 });
    const metadata = parseProfileMetadata(result.stdout, profileKey());
    expect(metadata.configuration.status).toBe("changed");
    expect(inspectProfileSkills(metadata, null).every(row => row.resolution === "unknown" && row.configuredGlobal === "unknown")).toBe(true);
  } finally { tree.close(); }
});
