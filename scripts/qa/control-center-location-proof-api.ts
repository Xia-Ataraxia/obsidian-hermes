import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { nativeDefaultProfileRoot } from "../../src/domain/control-center-native-root";
import { CONTROL_CENTER_LOCATION_PYTHON } from "../../src/domain/control-center-location-python";
import { DashboardClient } from "../../src/ui/dashboard-client";
import { ControlCenterClient } from "../../src/ui/control-center-client";
import { verifyDashboardWire } from "../../src/ui/dashboard-wire-policy";
import { parseDashboardJson, requireObject } from "../../src/ui/dashboard-response";
import { ProfileCatalogError } from "../../src/types/profile-catalog";
import { DashboardClientError } from "../../src/types/dashboard-client";
import type { DashboardObject } from "../../src/types/dashboard-client";
import { verifyHost, ownedPath } from "./fixture-guard";

const base = ownedPath("/private/tmp/hermes-control-center-m1-01a161c0/task-20/location-proof");
const host = verifyHost();
const results: { readonly id: string; readonly observable: string }[] = [];
const record = (id: string, observable: string) => results.push({ id, observable });
const good = { profiles: [{ name: "default", path: "/synthetic/home space", is_default: true }, { name: "xia", path: "/synthetic/home space/profiles/xia", is_default: false }] };
assert.equal(nativeDefaultProfileRoot(good), "/synthetic/home space");
record("native-default-path", "Unique native default.path preserved including whitespace");
const invalid: readonly [string, DashboardObject][] = [
  ["missing-array", {}], ["empty-array", { profiles: [] }],
  ["missing-default", { profiles: [good.profiles[1] ?? {}] }],
  ["duplicate-default", { profiles: [good.profiles[0] ?? {}, good.profiles[0] ?? {}] }],
  ["wrong-default-name", { profiles: [{ name: "xia", path: "/x", is_default: true }] }],
  ["relative-path", { profiles: [{ name: "default", path: "relative", is_default: true }] }],
  ["control-path", { profiles: [{ name: "default", path: "/bad\npath", is_default: true }] }],
  ["traversal-path", { profiles: [{ name: "default", path: "/a/../b", is_default: true }] }],
  ["missing-flag", { profiles: [{ name: "default", path: "/x" }] }],
  ["string-flag", { profiles: [{ name: "default", path: "/x", is_default: "true" }] }],
];
for (const [id, data] of invalid) {
  assert.throws(() => nativeDefaultProfileRoot(data), error => error instanceof ProfileCatalogError && error.code === "read-failed");
  record(id, "Parser rejected ambiguous or invalid location");
}
const origin = new URL("http://127.0.0.1:9119");
verifyDashboardWire(origin, { url: new URL("/api/profiles", origin), method: "GET" });
record("wire-get", "Exact GET /api/profiles allowed");
for (const input of [
  { url: new URL("/api/profiles", origin), method: "POST" },
  { url: new URL("/api/profiles", origin), method: "DELETE" },
  { url: new URL("/api/profiles?profile=xia", origin), method: "GET" },
  { url: new URL("/api/profiles", origin), method: "GET", body: "{}" },
  { url: new URL("http://example.com/api/profiles"), method: "GET" },
  { url: new URL("/api/profiles/default", origin), method: "GET" },
]) assert.throws(() => verifyDashboardWire(origin, input), error => error instanceof DashboardClientError && error.code === "unsupported-operation");
record("wire-bypasses", "POST, DELETE, query, body, foreign origin and child path rejected");
function gate() { let resolve: () => void = () => undefined; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
let seen = gate(), release = gate(), held = false;
const token = randomBytes(32).toString("hex");
const requests: { readonly method: string; readonly path: string }[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  requests.push({ method: request.method, path });
  if (path === "/") return new Response(`<script>window.__HERMES_SESSION_TOKEN__=${JSON.stringify(token)};</script>`);
  if (request.headers.get("X-Hermes-Session-Token") !== token) return new Response(null, { status: 401 });
  if (path === "/api/status") return Response.json({ auth_required: false });
  if (path === "/api/plugins/kanban/profiles") return Response.json({ profiles: [] });
  assert.equal(path, "/api/profiles"); assert.equal(request.method, "GET");
  if (held) { seen.resolve(); await release.promise; }
  return Response.json(good);
} });
const boundPort = server.port;
writeFileSync(`${base}/final-method-resources.json`, JSON.stringify({ pid: process.pid, port: boundPort, host, started: new Date().toISOString(), root: base }));
const controller = new AbortController();
const connection = { alias: "location-qa", generation: 1, baseUrl: `http://127.0.0.1:${server.port}`, signal: controller.signal };
const client = new ControlCenterClient(connection);
try {
  await assert.rejects(async () => client.profileLocations({ isCurrent: () => false }), error => error instanceof DashboardClientError && error.code === "stale-generation");
  assert.equal(requests.length, 0); record("stale-before-request", "No request sent for stale generation");
  assert.equal(nativeDefaultProfileRoot(await client.profileLocations()), "/synthetic/home space");
  record("shared-client-read", "Stable facade authenticates and reads native profiles route");
  held = true; let current = true;
  const late = client.profileLocations({ isCurrent: () => current });
  const rejectedLate = assert.rejects(late, error => error instanceof DashboardClientError && error.code === "stale-generation");
  await seen.promise; current = false; release.resolve(); await rejectedLate;
  record("late-generation", "Late successful response rejected after generation changed");
  seen = gate(); release = gate(); const abort = new AbortController();
  const pending = client.profileLocations({ signal: abort.signal });
  const rejectedAbort = assert.rejects(pending, error => error instanceof DashboardClientError && error.code === "cancelled");
  await seen.promise; abort.abort(); release.resolve(); await rejectedAbort;
  record("pending-abort", "Actual arrived request cancelled through context signal");
  held = false; client.pause();
  await assert.rejects(async () => client.profileLocations(), error => error instanceof DashboardClientError && error.code === "cancelled");
  client.resume({ ...connection, generation: 2 });
  assert.equal(nativeDefaultProfileRoot(await client.profileLocations()), "/synthetic/home space");
  record("pause-resume", "Same facade refuses paused read then succeeds after fresh connection");
  client.dispose(); client.dispose();
  assert.throws(() => client.resume(connection), error => error instanceof DashboardClientError && error.code === "cancelled");
  record("repeat-dispose", "Repeated dispose safe; disposed scope cannot reconnect");
} finally { release.resolve(); client.dispose(); controller.abort(); await server.stop(true); }
const nativeController = new AbortController();
const native = new DashboardClient({ alias: "m1-readonly", generation: 1, baseUrl: "http://127.0.0.1:9119", signal: nativeController.signal });
let nativeCount = 0;
try {
  const data = await native.profileLocations();
  const root = nativeDefaultProfileRoot(data);
  assert.ok(root.startsWith("/")); assert.ok(Array.isArray(data.profiles)); nativeCount = data.profiles.length;
  record("live-native-root", "Authenticated native /api/profiles yielded one validated default root; path redacted");
} finally { native.dispose(); nativeController.abort(); }
const source = requireObject(parseDashboardJson(execFileSync("python3", ["-I", "-B", "-c", CONTROL_CENTER_LOCATION_PYTHON], { encoding: "utf8", timeout: 15_000, maxBuffer: 4096 })));
assert.equal(source.provenance, "matching-native-launcher-and-dashboard-process");
assert.equal(typeof source.sourceRoot, "string"); assert.equal(Object.keys(source).length, 2);
record("live-process-source", "Exact serving process/launcher source identified; only sourceRoot/provenance output");
const files = ["src/domain/control-center-native-root.ts", "src/domain/control-center-location-python.ts", "src/ui/dashboard-client.ts", "src/ui/control-center-client.ts", "src/ui/dashboard-wire-policy.ts", "scripts/qa/control-center-location-proof-api.ts"];
const hashes = Object.fromEntries(files.map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
const receipt = { host, results, nativeProfileCount: nativeCount, hashes, requests, cleanup: { port: boundPort, stopped: true, clientDisposed: true, nativeClientDisposed: true }, innerExit: 0 };
writeFileSync(`${base}/final-method-result.json`, JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
