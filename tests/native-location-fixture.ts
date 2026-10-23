import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ControlCenterClient } from "../src/ui/control-center-client";
import { verifyFixtureHost } from "../scripts/qa/fixture-guard";

export const nativeLocations = { profiles: [{ name: "default", path: "/synthetic/home space", is_default: true }, { name: "xia", path: "/synthetic/home space/profiles/xia", is_default: false }] };
export function locationFixture() {
  verifyFixtureHost();
  let acceptSeen: () => void = () => undefined;
  let acceptRelease: () => void = () => undefined;
  const seen = new Promise<void>(accept => { acceptSeen = accept; });
  const release = new Promise<void>(accept => { acceptRelease = accept; });
  let held = false;
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
    if (held) { acceptSeen(); await release; }
    return Response.json(nativeLocations);
  } });
  const controller = new AbortController();
  const connection = { alias: "location-qa", generation: 1, baseUrl: `http://127.0.0.1:${server.port}`, signal: controller.signal };
  const client = new ControlCenterClient(connection);
  return { client, connection, requests, seen, release: acceptRelease, hold() { held = true; },
    async close() { acceptRelease(); client.dispose(); controller.abort(); await server.stop(true); } };
}
