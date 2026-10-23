import { nativeDashboardFixture } from "./native-dashboard-fixture";
import { randomBytes } from "node:crypto";
import { verifyFixtureHost } from "../scripts/qa/fixture-guard";
import { DashboardClient } from "../src/ui/dashboard-client";
import { parseDashboardJson, requireObject } from "../src/ui/dashboard-response";
import type { DashboardConnection } from "../src/types/dashboard-connection";
import contracts from "./fixtures/hermes-contracts.json";

let native: Awaited<ReturnType<typeof nativeDashboardFixture>> | undefined;
export async function lifecycle(command: "start" | "stop" | "control", extra: readonly string[] = []): Promise<void> {
  verifyFixtureHost();
  switch (command) {
    case "start": native = await nativeDashboardFixture(); return;
    case "stop": await native?.stop(); native = undefined; return;
    case "control": {
      if (!native) throw new TypeError("Native fixture not started");
      const html = await fetch(native.origin).then(response => response.text());
      const token = html.match(/="([a-f0-9]+)";/)?.[1];
      if (!token) throw new TypeError("Native bootstrap missing");
      const response = await fetch(`${native.origin}/__fixture/control`, { method: "POST", headers: { "X-Hermes-Session-Token": token, "Content-Type": "application/json" }, body: JSON.stringify({ scenario: extra[1] }), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new TypeError(`Fixture control failed: ${response.status}`);
      return;
    }
  }
}
export function fixtureClient(origin = native?.origin) {
  if (!origin) throw new TypeError("Native fixture not started");
  const controller = new AbortController();
  const connection: DashboardConnection = { alias: "fixture", generation: 1, baseUrl: origin, signal: controller.signal };
  return { client: new DashboardClient(connection), controller, connection };
}
export function gate<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
export function faultFixture() {
  verifyFixtureHost();
  let token = randomBytes(32).toString("hex");
  let mode = "normal";
  let skills: unknown = [{ name: "synthetic", description: "Synthetic skill", category: "qa", enabled: true, usage: 0, provenance: "agent" }];
  let writes = 0;
  let bootstraps = 0;
  let title = "Synthetic original";
  let cleared = false;
  const seen = gate<void>();
  const release = gate<void>();
  const requests: { readonly method: string; readonly path: string; readonly board: string | null; readonly profile: string | null }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    async fetch(request, owner) {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname, board: url.searchParams.get("board"), profile: url.searchParams.get("profile") });
      if (url.pathname === "/") { bootstraps++; return new Response(mode === "gated" ? "<script>window.__HERMES_AUTH_REQUIRED__=true;</script>" : `<script>window.__HERMES_SESSION_TOKEN__=${JSON.stringify(mode === "invalid-bootstrap" ? "invalid-synthetic-token" : token)};</script>`); }
      if (url.pathname === "/api/status") return Response.json({ auth_required: mode === "status-gated" });
      if ((request.headers.get("upgrade") === "websocket" ? url.searchParams.get("token") : request.headers.get("X-Hermes-Session-Token")) !== token) return Response.json({ detail: "authentication required" }, { status: 401 });
      if (url.pathname.endsWith("/profiles") && mode !== "empty") return Response.json({ profiles: [] }, { status: mode === "protected-denied" ? 401 : 200 });
      if (url.pathname.endsWith("/events")) { if (owner.upgrade(request)) return; return new Response(null, { status: 400 }); }
      if (request.method === "PATCH") {
        writes++;
        const patch = requireObject(parseDashboardJson(await request.text()));
        if (typeof patch["title"] === "string") title = patch["title"];
        if (mode === "late-write") { seen.resolve(); await release.promise; }
        if (mode === "semantic") { cleared = true; return Response.json({ detail: "Synthetic failure after semantic commits" }, { status: 500 }); }
        if (mode === "partial") return Response.json({ detail: "Synthetic failure after title commit" }, { status: 500 });
        if (mode === "write-expired") { token = randomBytes(32).toString("hex"); return new Response(null, { status: 401 }); }
      }
      if (mode === "cap") return new Response(new Uint8Array(20_000_000));
      if (mode === "chunk-cap") {
        let chunks = 0;
        return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
          queueMicrotask(() => { if (++chunks > 9) controller.close(); else controller.enqueue(new Uint8Array(524_288)); });
        } }));
      }
      if (mode === "malformed") return new Response("{");
      if (mode === "empty") return Response.json({});
      if (mode === "conflict") return Response.json({ detail: `Running task reassignment refused <script> token=${token}` }, { status: 409 });
      if (mode === "hang") { seen.resolve(); await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), { once: true })); }
      if (mode === "late") { seen.resolve(); await release.promise; }
      if (url.pathname.endsWith("/bulk")) return Response.json({ results: [{ id: "repeat-001", ok: false, error: "Synthetic assignment refused" }] });
      if (url.pathname.endsWith("/workflow")) return Response.json({ columns: contracts.workflow.columns, manual: contracts.workflow.manual });
      if (url.pathname === "/api/skills") return Response.json(skills);
      if (url.pathname === "/api/skills/content") return Response.json({ name: "synthetic", content: "Synthetic content", path: "/synthetic/SKILL.md" });
      return Response.json({ task: { id: "repeat-001", title, status: mode === "archived" ? "archived" : "todo", assignee: "xia", model_override: cleared ? null : "synthetic", provider_override: cleared ? null : "synthetic", reasoning_effort: cleared ? null : "high", latest_summary: cleared ? "Synthetic summary" : null }, runs: cleared ? [{ id: 5, metadata: { synthetic: true } }] : [] });
    },
    websocket: { open(socket) { socket.send(mode === "socket-malformed" ? "{" : JSON.stringify({ cursor: 1, events: [{ id: 1, task_id: "repeat-001", run_id: null, kind: "created", payload: null, created_at: 1 }] })); }, message() {} },
  });
  return { ...fixtureClient(`http://127.0.0.1:${server.port}`), requests, seen, release,
    setSkills(value: unknown) { skills = value; },
    setMode(value: string) { mode = value; }, expire() { token = randomBytes(32).toString("hex"); },
    counts: () => ({ writes, bootstraps }),
    async stop() { await server.stop(true); },
  };
}
