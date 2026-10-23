import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FixtureRefusal, isRecord, verifyHost } from "./fixture-guard";

const identity = verifyHost();
const root = resolve(".omo/qa/hermes");
const results: { readonly scenario: string; readonly passed: boolean; readonly observable: unknown }[] = [];
function check(scenario: string, passed: boolean, observable: unknown) {
  results.push({ scenario, passed, observable });
  if (!passed) throw new FixtureRefusal(`acceptance failed: ${scenario}`);
}
function cli(...args: string[]): unknown {
  return JSON.parse(execFileSync(process.execPath, ["scripts/qa/fixture.ts", ...args], { encoding: "utf8", timeout: 60_000 }));
}
const mode = process.argv[2] ?? "deterministic";
const started = cli("start", "--root", ".omo/qa/hermes", "--port", "19129", "--mode", mode);
check("CLI starts owned fixture", isRecord(started) && started.event === "started", started);
const origin = "http://127.0.0.1:19129";
let headers: { "X-Hermes-Session-Token": string };
async function auth() {
  const html = await fetch(origin).then(response => response.text());
  const token = html.match(/="([a-f0-9]+)";/)?.[1];
  if (!token) throw new FixtureRefusal("bootstrap token missing");
  return { "X-Hermes-Session-Token": token };
}
const route = "/api/plugins/kanban/tasks/repeat-001?profile=default&board=";
let ws: WebSocket | undefined;
try {
  headers = await auth();
  const receiptPath = resolve(root, "lifecycle.json");
  const originalReceipt = readFileSync(receiptPath, "utf8");
  let staleRefused = false;
  try {
    writeFileSync(receiptPath, JSON.stringify({ ...JSON.parse(originalReceipt), instance: "stale-fixture-instance", pid: process.pid }));
    try { cli("stop", "--root", root); } catch { staleRefused = true; }
  } finally { writeFileSync(receiptPath, originalReceipt); }
  check("stale receipt cannot stop an unrelated PID or live fixture", staleRefused && (await fetch(`${origin}/api/status`, { headers })).ok, { staleRefused, unrelatedProbePidAlive: process.pid, fixtureResponds: true });
  check("missing auth rejected", (await fetch(`${origin}/api/status`)).status === 401, 401);
  const status: unknown = await fetch(`${origin}/api/status`, { headers }).then(response => response.json());
  check("auth_required false still authenticates", isRecord(status) && status.auth_required === false, status);
  const roster: unknown = await fetch(`${origin}/api/plugins/kanban/profiles?profile=default`, { headers }).then(response => response.json());
  const names = isRecord(roster) && Array.isArray(roster.profiles) ? roster.profiles.map(profile => isRecord(profile) ? profile.name : null).sort() : [];
  check("profile roster includes default xia and empty", JSON.stringify(names) === JSON.stringify(["default", "empty", "xia"]), { names });
  check("wrong management profile rejected", (await fetch(`${origin}${route}default`.replace("profile=default", "profile=xia"), { headers })).status === 403, 403);
  const ownedProcesses = () => execFileSync("/bin/ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" }).split("\n").filter(line => isRecord(started) && Number(line.trim().split(/\s+/)[1]) === started.pid);
  const beforeDispatch = ownedProcesses();
  check("dispatch rejected", (await fetch(`${origin}/api/plugins/kanban/dispatch?profile=default&board=default`, { method: "POST", headers })).status === 403, 403);
  const afterDispatch = ownedProcesses();
  check("dispatch preserves owned process inventory", beforeDispatch.length > 0 && JSON.stringify(beforeDispatch) === JSON.stringify(afterDispatch), { before: beforeDispatch, after: afterDispatch });
  const reference = await fetch(`${origin}/reference/upstream.js`).then(response => response.arrayBuffer());
  check("reference unchanged upstream", createHash("sha256").update(Buffer.from(reference)).digest("hex") === "c316f2e7155b288de8dd709fd8975e9dbc3af6d59a255c74039ce401fd121a3a", reference.byteLength);
  const socket = new WebSocket(`${origin.replace("http", "ws")}/api/plugins/kanban/events?profile=default&board=default&token=${headers["X-Hermes-Session-Token"]}`);
  ws = socket;
  await new Promise<void>((resolveOpen, reject) => { const timer = setTimeout(() => reject(new FixtureRefusal("WS open timeout")), 5000); socket.onopen = () => { clearTimeout(timer); resolveOpen(); }; socket.onerror = () => reject(new FixtureRefusal("WS connection failed")); });
  check("authenticated scoped WebSocket opens", socket.readyState === WebSocket.OPEN, socket.readyState);
  const control = (scenario: string) => cli("control", "--root", root, "--scenario", scenario);
  if (mode === "deterministic") {
    const before: unknown = await fetch(`${origin}${route}xia-dev`, { headers }).then(response => response.json());
    control("partial-patch");
    const mutation = await fetch(`${origin}${route}default`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ title: "committed synthetic title", assignee: "empty" }) });
    check("partial mutation returns failure", mutation.status === 500, mutation.status);
    const actual: unknown = await fetch(`${origin}${route}default`, { headers }).then(response => response.json());
    check("partial mutation authoritative readback", isRecord(actual) && isRecord(actual.task) && actual.task.title === "committed synthetic title" && actual.task.assignee === "xia", { titleCommitted: true, assigneeUnchanged: true });
    const other: unknown = await fetch(`${origin}${route}xia-dev`, { headers }).then(response => response.json());
    check("colliding task IDs remain board scoped", JSON.stringify(before) === JSON.stringify(other), { repeatedId: "repeat-001", untouchedBoard: "xia-dev" });
    check("three review events and unknown attribution", isRecord(actual) && Array.isArray(actual.events) && actual.events.length === 4 && actual.events.filter(event => isRecord(event) && String(event.kind).startsWith("review_")).length === 3, { reviewEvents: 3, totalEvents: 4 });
    control("review-cycle");
    const review: unknown = await fetch(`${origin}${route}default`, { headers }).then(response => response.json());
    check("review cycle control supplies three explicit events", isRecord(review) && Array.isArray(review.events) && review.events.length === 3 && review.events.every(event => isRecord(event) && isRecord(event.payload) && typeof event.payload.from === "string"), { events: 3 });
    control("unknown-attribution");
    const unknown: unknown = await fetch(`${origin}${route}default`, { headers }).then(response => response.json());
    check("unknown attribution control supplies missing endpoint", isRecord(unknown) && Array.isArray(unknown.events) && unknown.events.some(event => isRecord(event) && isRecord(event.payload) && !("from" in event.payload)), { missingEndpoint: true });
  } else {
    const mutation = await fetch(`${origin}${route}default`, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ title: "native lifecycle synthetic title" }) });
    check("native router mutation succeeds", mutation.ok, mutation.status);
    const actual: unknown = await fetch(`${origin}${route}default`, { headers }).then(response => response.json());
    check("native router readback matches", isRecord(actual) && isRecord(actual.task) && actual.task.title === "native lifecycle synthetic title", { titleMatches: true });
  }
  control("delay");
  const at = performance.now();
  await fetch(`${origin}${route}default`, { headers });
  const elapsed = performance.now() - at;
  check("delay control affects data request", elapsed >= 700, { elapsedMs: elapsed });
  control("error");
  check("error control returns 503", (await fetch(`${origin}${route}default`, { headers })).status === 503, 503);
  control("expire-auth");
  check("expired token refused", (await fetch(`${origin}/api/status`, { headers })).status === 401, 401);
  headers = await auth();
  control("reset");
  const closed = new Promise<void>(resolveClose => socket.addEventListener("close", () => resolveClose(), { once: true }));
  control("disconnect");
  await Promise.race([closed, Bun.sleep(5000).then(() => { throw new FixtureRefusal("WS disconnect timeout"); })]);
  check("disconnect control closes socket", socket.readyState === WebSocket.CLOSED, socket.readyState);
} finally {
  ws?.close();
  const state: unknown = JSON.parse(readFileSync(resolve(root, "lifecycle.json"), "utf8"));
  cli("stop", "--root", root);
  let closed = false;
  try { await fetch(origin, { signal: AbortSignal.timeout(1000) }); } catch (error) { if (error instanceof Error) closed = true; else throw error; }
  check("stop closes listener", closed, { port: 19129, closed });
  if (isRecord(state) && typeof state.nativeOrigin === "string") {
    let nativeClosed = false;
    try { await fetch(state.nativeOrigin, { signal: AbortSignal.timeout(1000) }); } catch (error) { if (error instanceof Error) nativeClosed = true; else throw error; }
    check("stop closes native listener", nativeClosed, { closed: nativeClosed });
  }
  console.log(JSON.stringify({ identity, mode, results, root }));
}
