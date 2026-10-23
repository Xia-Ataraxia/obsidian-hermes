import { randomBytes } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { FixtureRefusal, isRecord, verifyFixtureHost } from "../../scripts/qa/fixture-guard";
import { fixtureBoards, fixtureEvents, fixtureProfiles, fixtureTasks } from "./dashboard-fixture-data";
import contracts from "./hermes-contracts.json";

export type FixtureScenario = "reset" | "delay" | "error" | "expire-auth" | "disconnect" | "partial-patch" | "unknown-attribution" | "review-cycle";
export function parseScenario(value: unknown): FixtureScenario {
  switch (value) {
    case "reset": case "delay": case "error": case "expire-auth": case "disconnect": case "partial-patch": case "unknown-attribution": case "review-cycle": return value;
    default: throw new FixtureRefusal("unknown fixture scenario");
  }
}
export type FixtureServerOptions = {
  readonly port: number;
  readonly instance: string;
  readonly native?: { readonly origin: string; readonly token: string };
  readonly reference?: (path: string) => Response | undefined;
  readonly portHost?: (request: Request) => Promise<Response | undefined>;
  readonly shutdown: () => Promise<void>;
};
type SocketData = { readonly board: string; readonly upstream: WebSocket | null };
const PREFIX = "/api/plugins/kanban";
export function startDashboardFixture(options: FixtureServerOptions) {
  verifyFixtureHost();
  let token = randomBytes(32).toString("hex");
  let scenario: FixtureScenario = "reset";
  let tasks = fixtureTasks();
  const events = (board: string) => scenario === "review-cycle" ? fixtureEvents(board).filter(event => event.kind.startsWith("review_")) : fixtureEvents(board);
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  const broadcast = (board: string) => {
    for (const socket of sockets) if (socket.data.board === board) socket.send(JSON.stringify({ type: "board_updated", board }));
  };
  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1", port: options.port,
    async fetch(request, owner) {
      const url = new URL(request.url);
      if (url.pathname === "/port-host" || url.pathname.startsWith("/port-host/")) return await options.portHost?.(request) ?? json({ error: "host assets not prepared" }, 404);
      if (request.method === "GET" && url.pathname === "/") return new Response(`<script>window.__HERMES_SESSION_TOKEN__=${JSON.stringify(token)};</script>`, { headers: { "content-type": "text/html", "cache-control": "no-store" } });
      if (request.method === "GET" && url.pathname.startsWith("/reference")) return options.reference?.(url.pathname) ?? json({ error: "reference assets not prepared" }, 503);
      const websocket = request.headers.get("upgrade") === "websocket";
      const supplied = websocket ? url.searchParams.get("token") : request.headers.get("X-Hermes-Session-Token");
      if (supplied !== token) return json({ error: "authentication required" }, 401);
      if (url.pathname === "/__fixture/ready" && request.method === "GET") return json({ ready: true, instance: options.instance, mode: options.native ? "native" : "deterministic" });
      if (url.pathname === "/api/status" && request.method === "GET") return json({ auth_required: false });
      if (url.pathname === "/__fixture/control" && request.method === "POST") {
        const input: unknown = await request.json();
        if (!isRecord(input)) return json({ error: "object required" }, 400);
        try { scenario = parseScenario(input.scenario); } catch (error) { if (error instanceof FixtureRefusal) return json({ error: error.reason }, 400); throw error; }
        switch (scenario) {
          case "reset": tasks = fixtureTasks(); break;
          case "expire-auth": token = randomBytes(32).toString("hex"); break;
          case "disconnect": for (const socket of sockets) socket.close(1012, "fixture disconnect"); break;
          case "review-cycle": case "unknown-attribution": for (const board of fixtureBoards) broadcast(board); break;
          case "delay": case "error": case "partial-patch": break;
          default: return assertNever(scenario);
        }
        return json({ scenario });
      }
      if (url.pathname === "/__fixture/stop" && request.method === "POST") {
        if (request.headers.get("X-Fixture-Instance") !== options.instance) return json({ error: "instance mismatch" }, 409);
        setTimeout(() => { void options.shutdown(); }, 25);
        return json({ stopping: true });
      }
      if (!url.pathname.startsWith(`${PREFIX}/`) || url.searchParams.getAll("profile").join() !== "default") return json({ error: "scope required" }, 403);
      const route = url.pathname.slice(PREFIX.length);
      const board = url.searchParams.get("board");
      const discovery = ["/boards", "/profiles", "/workflow"].includes(route) && request.method === "GET";
      if (!discovery && (url.searchParams.getAll("board").length !== 1 || (board !== "default" && board !== "xia-dev"))) return json({ error: "board required" }, 403);
      const readable = request.method === "GET" && (/^\/(board|stats|assignees|diagnostics|events)$/.test(route) || /^\/tasks\/[A-Za-z0-9_-]+(?:\/attachments|\/log)?$/.test(route) || /^\/runs\/\d+$/.test(route));
      const writable = request.method === "PATCH" && /^\/tasks\/[A-Za-z0-9_-]+$/.test(route) || request.method === "POST" && /^\/(tasks|tasks\/[A-Za-z0-9_-]+\/comments|links)$/.test(route) || request.method === "DELETE" && route === "/links";
      if (!discovery && !readable && !writable) return json({ error: "fixture action refused" }, 403);
      if (scenario === "delay") await Bun.sleep(750);
      if (scenario === "error") return json({ error: "synthetic unavailable" }, 503);
      if (websocket && route === "/events" && board) {
        const cursors = url.searchParams.getAll("since");
        const since = cursors[0] ?? "0";
        if (cursors.length > 1 || !/^(0|[1-9][0-9]*)$/.test(since) || !Number.isSafeInteger(Number(since))) return json({ error: "invalid event cursor" }, 400);
        const upstreamUrl = options.native ? new URL(url.pathname, options.native.origin.replace("http:", "ws:")) : null;
        if (upstreamUrl && options.native) upstreamUrl.search = new URLSearchParams({ profile: "default", board, token: options.native.token, since }).toString();
        const upstream = upstreamUrl ? new WebSocket(upstreamUrl) : null;
        if (owner.upgrade(request, { data: { board, upstream } })) return;
        upstream?.close();
        return json({ error: "upgrade failed" }, 400);
      }
      if (options.native) {
        const headers = new Headers(request.headers);
        headers.set("X-Hermes-Session-Token", options.native.token);
        headers.delete("host");
        return fetch(`${options.native.origin}${url.pathname}${url.search}`, { method: request.method, headers, ...(request.method === "GET" ? {} : { body: await request.arrayBuffer() }), signal: AbortSignal.timeout(10_000) });
      }
      if (route === "/profiles") return json({ profiles: fixtureProfiles.map(name => ({ name, is_default: name === "default", model: "", provider: "", description: "", description_auto: false, skill_count: 0 })) });
      if (route === "/boards") return json({ boards: fixtureBoards.map(slug => ({ slug, name: slug })) });
      if (route === "/workflow") return json({ columns: contracts.workflow.columns, manual: contracts.workflow.manual });
      if (route === "/board") return json({ tasks: tasks.filter(task => task.board === board), events: events(board ?? "default") });
      const task = tasks.find(item => item.board === board && route === `/tasks/${item.id}`);
      if (task && request.method === "GET") return json({ task, events: events(task.board) });
      if (task && request.method === "PATCH") {
        const patch: unknown = await request.json();
        if (!isRecord(patch) || Object.keys(patch).some(key => !["title", "assignee"].includes(key))) return json({ error: "invalid patch" }, 400);
        if (typeof patch.title === "string") task.title = patch.title;
        if (scenario === "partial-patch") return json({ error: "synthetic failure after title commit" }, 500);
        if (typeof patch.assignee === "string") task.assignee = patch.assignee;
        broadcast(task.board);
        return json({ task });
      }
      return json({ error: "deterministic route unavailable; use native mode" }, 404);
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
        const upstream = socket.data.upstream;
        if (upstream) {
          upstream.addEventListener("message", event => socket.send(String(event.data)));
          upstream.addEventListener("close", () => socket.close(1012, "native closed"));
          upstream.addEventListener("error", () => socket.close(1011, "native error"));
        } else socket.send(JSON.stringify({ type: "connected", board: socket.data.board }));
      },
      message(socket, data) { if (socket.data.upstream?.readyState === WebSocket.OPEN) socket.data.upstream.send(data); },
      close(socket) { sockets.delete(socket); socket.data.upstream?.close(); },
    },
  });
  return { server, stop: async () => { for (const socket of sockets) socket.close(); await server.stop(true); } };
}
function assertNever(value: never): never { throw new FixtureRefusal(`unhandled scenario: ${String(value)}`); }
