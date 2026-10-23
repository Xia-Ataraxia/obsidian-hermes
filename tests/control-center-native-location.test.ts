import assert from "node:assert/strict";
import { test } from "bun:test";
import { nativeDefaultProfileRoot } from "../src/domain/control-center-native-root";
import { verifyDashboardWire } from "../src/ui/dashboard-wire-policy";
import { ProfileCatalogError } from "../src/types/profile-catalog";
import { DashboardClientError } from "../src/types/dashboard-client";
import type { DashboardObject } from "../src/types/dashboard-client";
import { locationFixture, nativeLocations } from "./native-location-fixture";

test("preserves the unique native default location including whitespace", () => {
  assert.equal(nativeDefaultProfileRoot(nativeLocations), "/synthetic/home space");
});
const invalid: readonly [string, DashboardObject][] = [
  ["missing-array", {}], ["empty-array", { profiles: [] }],
  ["missing-default", { profiles: [nativeLocations.profiles[1] ?? {}] }],
  ["duplicate-default", { profiles: [nativeLocations.profiles[0] ?? {}, nativeLocations.profiles[0] ?? {}] }],
  ["wrong-default-name", { profiles: [{ name: "xia", path: "/x", is_default: true }] }],
  ["relative-path", { profiles: [{ name: "default", path: "relative", is_default: true }] }],
  ["control-path", { profiles: [{ name: "default", path: "/bad\npath", is_default: true }] }],
  ["traversal-path", { profiles: [{ name: "default", path: "/a/../b", is_default: true }] }],
  ["missing-flag", { profiles: [{ name: "default", path: "/x" }] }],
  ["string-flag", { profiles: [{ name: "default", path: "/x", is_default: "true" }] }],
];
for (const [id, data] of invalid) test(`rejects native location ${id}`, () => {
  assert.throws(() => nativeDefaultProfileRoot(data), error => error instanceof ProfileCatalogError && error.code === "read-failed");
});
const origin = new URL("http://127.0.0.1:9119");
test("permits only the exact native profiles GET wire operation", () => {
  verifyDashboardWire(origin, { url: new URL("/api/profiles", origin), method: "GET" });
});
const forbidden = [
  { url: new URL("/api/profiles", origin), method: "POST" },
  { url: new URL("/api/profiles", origin), method: "DELETE" },
  { url: new URL("/api/profiles?profile=xia", origin), method: "GET" },
  { url: new URL("/api/profiles", origin), method: "GET", body: "{}" },
  { url: new URL("http://example.com/api/profiles"), method: "GET" },
  { url: new URL("/api/profiles/default", origin), method: "GET" },
];
for (const [index, input] of forbidden.entries()) test(`refuses native profiles wire bypass ${index}`, () => {
  assert.throws(() => verifyDashboardWire(origin, input), error => error instanceof DashboardClientError && error.code === "unsupported-operation");
});
test("sends no request for a stale generation", async () => {
  const f = locationFixture();
  try {
    await assert.rejects(async () => f.client.profileLocations({ isCurrent: () => false }), error => error instanceof DashboardClientError && error.code === "stale-generation");
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});
test("authenticates and reads the native location through the shared client", async () => {
  const f = locationFixture();
  try { assert.equal(nativeDefaultProfileRoot(await f.client.profileLocations()), "/synthetic/home space"); }
  finally { await f.close(); }
});
test("rejects an arrived successful location response after generation changes", async () => {
  const f = locationFixture(); f.hold(); let current = true;
  try {
    const rejected = assert.rejects(f.client.profileLocations({ isCurrent: () => current }), error => error instanceof DashboardClientError && error.code === "stale-generation");
    await f.seen; current = false; f.release(); await rejected;
  } finally { await f.close(); }
});
test("cancels an arrived native location request through the context signal", async () => {
  const f = locationFixture(); f.hold(); const abort = new AbortController();
  try {
    const rejected = assert.rejects(f.client.profileLocations({ signal: abort.signal }), error => error instanceof DashboardClientError && error.code === "cancelled");
    await f.seen; abort.abort(); f.release(); await rejected;
  } finally { await f.close(); }
});
test("refuses paused native reads and succeeds after resume", async () => {
  const f = locationFixture();
  try {
    f.client.pause();
    await assert.rejects(async () => f.client.profileLocations(), error => error instanceof DashboardClientError && error.code === "cancelled");
    f.client.resume({ ...f.connection, generation: 2 });
    assert.equal(nativeDefaultProfileRoot(await f.client.profileLocations()), "/synthetic/home space");
  } finally { await f.close(); }
});
test("repeated native client disposal prevents reconnect", async () => {
  const f = locationFixture();
  try {
    f.client.dispose(); f.client.dispose();
    assert.throws(() => f.client.resume(f.connection), error => error instanceof DashboardClientError && error.code === "cancelled");
  } finally { await f.close(); }
});
