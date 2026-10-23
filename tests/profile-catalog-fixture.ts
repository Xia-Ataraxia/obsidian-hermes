import { requireTestPath, testPython } from "./isolated-environment";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyFixtureHost } from "../scripts/qa/fixture-guard";
import { parseScopedIdentity } from "../src/domain/control-center-validation";
import { PROFILE_METADATA_PYTHON } from "../src/domain/profile-metadata-python";
import { ClosedProfileMetadataReader } from "../src/ui/profile-metadata-reader";
import type { ProfileMetadataExecutor } from "../src/ui/profile-metadata-reader";
import { ProfileCatalogReader } from "../src/ui/profile-catalog-reader";
import { DashboardClient } from "../src/ui/dashboard-client";
import type { DashboardSkill } from "../src/types/dashboard-client";
import type { ProfileKey } from "../src/types/control-center";

export const PYTHON = testPython();
export const SOURCE_ROOT = requireTestPath("HERMES_CONTRACT_SOURCE");
export function profileKey(name = "default", connection = "m1-pro-file"): ProfileKey {
  const parsed = parseScopedIdentity({ kind: "profile", connection, profile: name });
  if (!parsed.ok || parsed.value.kind !== "profile") throw new TypeError("Invalid synthetic profile");
  return parsed.value;
}
export const localProjection: ProfileMetadataExecutor = async (request, signal) => {
  verifyFixtureHost();
  const result = await promisify(execFile)(PYTHON, ["-I", "-B", "-c", PROFILE_METADATA_PYTHON, JSON.stringify(request)], { signal, maxBuffer: 4_194_304, timeout: 15_000, env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" } });
  return result.stdout;
};
export function syntheticTree() {
  verifyFixtureHost();
  const root = mkdtempSync(join(tmpdir(), "profile-catalog-"));
  const write = (path: string, text: string) => { const full = join(root, path); mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, text); return full; };
  write("config.yaml", "skills:\n  disabled: ['off']\n  platform_disabled:\n    telegram: [chat-only]\n  external_dirs: [external]\n");
  write("skills/.bundled_manifest", "bundled:abc\n");
  write("skills/.curator_suppressed", "");
  write("skills/.hub/lock.json", '{"installed":{}}');
  write("skills/off/SKILL.md", "---\nname: 'off'\n---\nPRIVATE_INSTRUCTIONS_MUST_NOT_ESCAPE\n");
  write("skills/one/SKILL.md", "---\nname: duplicate\n---\nFirst\n");
  write("skills/two/SKILL.md", "---\nname: duplicate\n---\nSecond\n");
  write("skills/chat-only/SKILL.md", "---\nname: chat-only\nplatforms: [linux]\nmetadata:\n  hermes:\n    session_platforms: [telegram]\n---\nPrivate\n");
  write("external/duplicate/SKILL.md", "---\nname: duplicate\n---\nExternal\n");
  const reader = new ClosedProfileMetadataReader({ connection: "m1-pro-file", root, sourceRoot: SOURCE_ROOT }, localProjection);
  return { root, write, reader, close: () => rmSync(root, { recursive: true, force: true }) };
}
export function catalogSurface(metadata: ClosedProfileMetadataReader, skills: readonly DashboardSkill[] = [{ name: "off", description: "synthetic", category: "", enabled: false, usage: 0, provenance: "agent" }]) {
  verifyFixtureHost();
  let names = ["default", "zero-jobs", "python"];
  let failure = false;
  let malformed = false;
  const token = "0123456789abcdef0123456789abcdef";
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url); requests.push(url.pathname + url.search);
    if (url.pathname === "/") return new Response(`<script>window.__HERMES_SESSION_TOKEN__="${token}";</script>`);
    if (url.pathname === "/api/status") return Response.json({ auth_required: false });
    if (request.headers.get("X-Hermes-Session-Token") !== token) return new Response(null, { status: 401 });
    if (url.pathname.endsWith("/profiles")) return Response.json({ profiles: names.map(name => ({ name })) }, { status: failure ? 500 : 200 });
    if (url.pathname === "/api/skills") return malformed ? new Response("{") : Response.json(skills);
    return new Response(null, { status: 404 });
  } });
  const lifetime = new AbortController();
  const client = new DashboardClient({ alias: "m1-pro-file", generation: 1, baseUrl: `http://127.0.0.1:${server.port}`, signal: lifetime.signal });
  const reader = new ProfileCatalogReader(profileKey().connection, client, metadata);
  return { reader, requests, setNames(value: string[]) { names = value; }, fail() { failure = true; }, malformedSkills() { malformed = true; }, async close() { reader.dispose(); client.dispose(); lifetime.abort(); await server.stop(true); } };
}
