import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import type { Plugin } from "esbuild";
import { DashboardClient } from "../../src/ui/dashboard-client";
import { DashboardClientError } from "../../src/types/dashboard-client";
import { parseDashboardJson, requireObject } from "../../src/ui/dashboard-response";
import { parseRouteCapability } from "../../src/domain/control-center-validation";
import type { DashboardRequest, DashboardSubscription } from "../../src/types/dashboard-client";
import { FixtureRefusal } from "./fixture-guard";

function decodeRequest(text: string): DashboardRequest {
  if (new TextEncoder().encode(text).length > 1_048_576) throw new FixtureRefusal("host request cap");
  const input = requireObject(parseDashboardJson(text));
  const route = parseRouteCapability(input["route"]);
  if (!route.ok || route.value === "WEBSOCKET /events") throw new FixtureRefusal("closed route required");
  const query = input["query"] === undefined ? {} : requireObject(input["query"]);
  const entries = Object.entries(query).map(([key, value]): [string, string] => { if (typeof value !== "string") throw new FixtureRefusal("query value"); return [key, value]; });
  return { route: route.value, query: Object.fromEntries(entries),
    ...(typeof input["board"] === "string" ? { board: input["board"] } : {}),
    ...(typeof input["id"] === "string" ? { id: input["id"] } : {}),
    ...(input["body"] === undefined ? {} : { body: requireObject(input["body"]) }),
    completionConfirmed: input["completionConfirmed"] === true,
  };
}

export async function portHostAssets(lifetime: AbortSignal) {
  const buildModule = "../../src/vendor/hermes-kanban/build.mjs";
  const { nativeTokenPlugin }: { nativeTokenPlugin: Plugin } = await import(buildModule);
  const bundle = await build({ entryPoints: [resolve(import.meta.dir, "fixture-port-host-entry.ts")], bundle: true, write: false, platform: "browser", format: "esm", target: "es2022", logLevel: "silent", define: { "process.env.NODE_ENV": '"production"' }, plugins: [nativeTokenPlugin] });
  const script = bundle.outputFiles[0];
  if (!script) throw new FixtureRefusal("host bundle absent");
  const styles = readFileSync(resolve(import.meta.dir, "../../src/vendor/hermes-kanban/generated/kanban.css"));
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>Native Kanban leaf host fixture</title><link rel="stylesheet" href="/port-host/styles.css"></head><body style="margin:0"><header><button id="unmount">Unmount first host</button><button id="remount">Remount first host</button><button id="denied">Probe excluded operation</button><output id="result"></output></header><div id="neighbor" style="font:17px Georgia;color:rgb(12,34,56);padding:13px">Neighbor style sentinel</div><main style="display:grid;grid-template-columns:1fr 1fr;height:850px"><section id="host-a" aria-label="First leaf" style="min-width:0"></section><section id="host-b" aria-label="Second leaf" style="min-width:0"></section></main><script type="module" src="/port-host/entry.js"></script></body></html>';
  let client: DashboardClient | undefined;
  lifetime.addEventListener("abort", () => client?.dispose(), { once: true });
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (request.method === "GET") {
      if (url.pathname === "/port-host") return new Response(html, { headers: { "content-type": "text/html" } });
      if (url.pathname === "/port-host/entry.js") return new Response(Uint8Array.from(script.contents), { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/port-host/styles.css") return new Response(styles, { headers: { "content-type": "text/css" } });
    }
    if (request.method !== "POST" || request.headers.get("X-Kanban-Fixture") !== "leaf-host" || request.headers.get("origin") !== url.origin) return new Response("Host fixture origin refused", { status: 403 });
    client ??= new DashboardClient({ alias: "port-host-fixture", generation: 1, baseUrl: url.origin, signal: lifetime });
    const context = { signal: AbortSignal.any([lifetime, request.signal]) };
    try {
      if (url.pathname === "/port-host/events") {
        const input = requireObject(parseDashboardJson(await request.text()));
        if (typeof input["board"] !== "string" || typeof input["since"] !== "number") throw new FixtureRefusal("watch shape");
        const queue: string[] = [];
        let output: ReadableStreamDefaultController<Uint8Array> | undefined;
        let subscription: DashboardSubscription | undefined;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        let cursor = input["since"];
        const send = (value: unknown) => { const line = JSON.stringify(value) + "\n"; if (output) output.enqueue(new TextEncoder().encode(line)); else queue.push(line); };
        subscription = await client.subscribe({ board: input["board"], since: cursor, onEvents: batch => { cursor = batch.cursor; send(batch); } }, context);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            output = controller; for (const line of queue) controller.enqueue(new TextEncoder().encode(line)); queue.length = 0;
            send({ events: [], cursor });
            heartbeat = setInterval(() => send({ events: [], cursor }), 5000);
          },
          cancel() { clearInterval(heartbeat); output = undefined; subscription?.close(); },
        });
        void subscription.closed.then(() => { clearInterval(heartbeat); output?.close(); output = undefined; });
        return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
      }
      const input = decodeRequest(await request.text());
      if (url.pathname === "/port-host/read") return Response.json(await client.read(input, context));
      if (url.pathname === "/port-host/mutate") return Response.json(await client.mutate(input, context));
      if (url.pathname === "/port-host/attachment" && input.board && input.id) return new Response(Uint8Array.from(await client.attachment(input.board, input.id, context)));
      return new Response("Unknown host operation", { status: 404 });
    } catch (error) {
      if (error instanceof DashboardClientError || error instanceof FixtureRefusal) return Response.json({ error: error.message }, { status: 400 });
      throw error;
    }
  };
}
