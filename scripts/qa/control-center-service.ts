import { randomBytes } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import { isRecord, ownedPath } from "./fixture-guard";
import { CONTROL_CENTER_SCENARIOS, fixtureDelay, scenarioAt } from "./control-center-runtime";

interface NativeFixture { readonly origin: string; readonly token: string }
interface SocketData { readonly upstream: WebSocket }
export function serveControlCenter(options: { readonly root: string; readonly port: number; readonly native: NativeFixture; readonly reference: (path: string) => Response | undefined; readonly shutdown: () => Promise<void> }) {
  const root = ownedPath(options.root);
  const token = randomBytes(32).toString("hex");
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  const server = Bun.serve<SocketData>({ hostname: "127.0.0.1", port: options.port, idleTimeout: 30,
    async fetch(request, owner) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/") return new Response(`<script>window.__HERMES_SESSION_TOKEN__=${JSON.stringify(token)};</script>`, { headers: { "content-type": "text/html", "cache-control": "no-store" } });
      if (request.method === "GET" && url.pathname.startsWith("/reference")) return options.reference(url.pathname) ?? json({ error: "asset missing" }, 404);
      const websocket = request.headers.get("upgrade") === "websocket";
      if ((websocket ? url.searchParams.get("token") : request.headers.get("X-Hermes-Session-Token")) !== token) return json({ error: "authentication required" }, 401);
      if (url.pathname === "/__fixture/ready") return json({ ready: true, owner: "task20_fixture", root, mode: "native", scenario: scenarioAt(root) });
      if (request.method === "POST" && url.pathname === "/__fixture/stop") {
        setTimeout(() => { void options.shutdown(); }, 25);
        return json({ stopping: true });
      }
      if (request.method === "POST" && url.pathname === "/__fixture/control") {
        const input: unknown = await request.json();
        if (!isRecord(input)) return json({ error: "scenario required" }, 400);
        const scenario = CONTROL_CENTER_SCENARIOS.find(item => item === input.scenario);
        if (!scenario) return json({ error: "unknown scenario" }, 400);
        writeFileSync(resolve(root, "scenario.json"), JSON.stringify({ scenario }));
        if (scenario === "external-soul") writeFileSync(resolve(root, "home/profiles/xia/SOUL.md"), `Synthetic external SOUL revision ${Date.now()}.\n`);
        if (scenario === "transport-loss") for (const socket of sockets) socket.close(1012, "fixture transport loss");
        if (scenario === "expire-auth") for (const socket of sockets) socket.close(4401, "fixture authentication expired");
        return json({ scenario });
      }
      const scenario = scenarioAt(root);
      if (scenario === "expire-auth") return json({ error: "synthetic authentication expired" }, 401);
      if (url.pathname === "/api/status") return json({ auth_required: false });
      if (scenario === "transport-loss") return json({ error: "synthetic transport loss" }, 503);
      if (scenario === "delay") await fixtureDelay(request.signal);
      if (request.method === "GET" && url.pathname === "/api/skills") {
        const profile = url.searchParams.get("profile");
        if (!["default", "xia", "empty", "another"].includes(profile ?? "")) return json({ error: "profile required" }, 403);
        if (scenario === "unavailable-skills") return json({ error: "synthetic skill unavailable" }, 503);
        if (scenario === "delayed-profile" && profile === "xia") await fixtureDelay(request.signal);
        if (scenario === "malformed") return new Response("{");
        return json(profile === "empty" ? [] : [
          { name: "qa-research", description: "Synthetic profile skill", category: "qa", enabled: true, usage: 0, provenance: "agent" },
          { name: "qa-disabled", description: "Synthetic disabled selection", category: "qa", enabled: false, usage: 0, provenance: "agent" },
        ]);
      }
      if (!url.pathname.startsWith("/api/plugins/kanban/") || url.searchParams.getAll("profile").join() !== "default") return json({ error: "scope required" }, 403);
      if (request.method === "GET" && !websocket) {
        if (scenario === "unavailable-orchestration" && url.pathname === "/api/plugins/kanban/orchestration") return json({ error: "synthetic orchestration unavailable" }, 503);
        if (scenario === "unavailable-profiles" && url.pathname === "/api/plugins/kanban/profiles") return json({ error: "synthetic profiles unavailable" }, 503);
      }
      if (scenario === "malformed" && request.method === "GET") return new Response("{");
      const target = new URL(url.pathname + url.search, options.native.origin);
      if (websocket) {
        target.protocol = "ws:";
        target.searchParams.set("token", options.native.token);
        const upstream = new WebSocket(target);
        if (owner.upgrade(request, { data: { upstream } })) return;
        upstream.close();
        return json({ error: "upgrade failed" }, 400);
      }
      const headers = new Headers(request.headers);
      headers.delete("host"); headers.delete("content-length");
      headers.set("X-Hermes-Session-Token", options.native.token);
      let body = request.method === "GET" ? undefined : await request.text();
      const isMutation = ["POST", "PATCH", "DELETE"].includes(request.method);
      if (scenario === "partial-patch" && request.method === "PATCH") {
        const patch: unknown = JSON.parse(body ?? "{}");
        if (!isRecord(patch) || typeof patch.title !== "string") return json({ error: "partial-patch scenario requires title" }, 400);
        body = JSON.stringify({ title: patch.title });
      }
      const result = await fetch(target, { method: request.method, headers, ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(15_000) });
      if (scenario === "render-error" && request.method === "GET" && url.pathname === "/api/plugins/kanban/board" && result.ok) {
        let board: unknown;
        try { board = await result.clone().json(); }
        catch (error) { if (error instanceof SyntaxError) return result; throw error; }
        if (isRecord(board) && Array.isArray(board.columns)) {
          for (const column of board.columns) {
            if (!isRecord(column) || !Array.isArray(column.tasks)) continue;
            const task = column.tasks.find(isRecord);
            if (!task) continue;
            // Deliberately malformed QA response: native tenant values are TEXT, never objects.
            task.tenant = { qa_render_fault: "tenant-object" };
            const faultHeaders = new Headers(result.headers);
            faultHeaders.delete("content-length"); faultHeaders.delete("content-encoding");
            faultHeaders.set("x-hermes-qa-fault", "render-error; not-native-valid-producer");
            return new Response(JSON.stringify(board), { status: result.status, statusText: result.statusText, headers: faultHeaders });
          }
        }
      }
      if (isMutation) appendFileSync(resolve(root, "mutations.ndjson"), JSON.stringify({ method: request.method, route: url.pathname, board: url.searchParams.get("board"), nativeStatus: result.status, scenario, time: Date.now() }) + "\n");
      if (scenario === "partial-patch" && request.method === "PATCH" && result.ok) { await result.arrayBuffer(); return json({ error: "synthetic failure after native title commit" }, 500); }
      if (scenario === "lost-response" && isMutation && result.ok) { await result.arrayBuffer(); await fixtureDelay(request.signal, 12_000); return json({ error: "native mutation committed; response lost" }, 504); }
      return result;
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
        socket.data.upstream.addEventListener("message", event => socket.send(String(event.data)));
        socket.data.upstream.addEventListener("close", () => socket.close(1012, "native closed"));
        socket.data.upstream.addEventListener("error", () => socket.close(1011, "native error"));
      },
      message(socket, data) { if (socket.data.upstream.readyState === WebSocket.OPEN) socket.data.upstream.send(data); },
      close(socket) { sockets.delete(socket); socket.data.upstream.close(); },
    },
    error(error) { if (!(error instanceof Error)) throw error; return json({ error: "fixture request failed" }, 503); },
  });
  return { server, async stop() { for (const socket of sockets) socket.close(); await server.stop(true); } };
}
