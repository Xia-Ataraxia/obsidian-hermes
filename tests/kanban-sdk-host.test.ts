import { describe, expect, test } from "bun:test";
import { nativeSdkRequest, kanbanSdkTransport } from "../src/ui/kanban-sdk-routes";
import { DashboardClientError } from "../src/types/dashboard-client";
import { faultFixture } from "./dashboard-client-fixture";
import { portHostAssets } from "../scripts/qa/fixture-port-host";
import { startDashboardFixture } from "./fixtures/dashboard-fixture-server";

describe("closed native SDK host transport", () => {
  test("fixture bridge rejects foreign origins, absent custom header, and arbitrary operations", async () => {
    const lifetime = new AbortController();
    const handler = await portHostAssets(lifetime.signal);
    try {
      for (const headers of [{ origin: "https://foreign.invalid", "X-Kanban-Fixture": "leaf-host" }, { origin: "http://127.0.0.1:19129" }]) {
        expect((await handler(new Request("http://127.0.0.1:19129/port-host/read", { method: "POST", headers, body: "{}" })))?.status).toBe(403);
      }
      const denied = await handler(new Request("http://127.0.0.1:19129/port-host/mutate", { method: "POST", headers: { origin: "http://127.0.0.1:19129", "X-Kanban-Fixture": "leaf-host" }, body: JSON.stringify({ route: "POST /dispatch" }) }));
      expect(denied?.status).toBe(400);
    } finally { lifetime.abort(); }
  });

  test("fixture host callback cannot capture sibling prefixes", async () => {
    let calls = 0;
    const fixture = startDashboardFixture({ port: 0, instance: "host-scope", shutdown: async () => undefined, portHost: async () => { calls++; return new Response("owned"); } });
    try {
      expect(await (await fetch(`${fixture.server.url.origin}/port-host`)).text()).toBe("owned");
      expect(await (await fetch(`${fixture.server.url.origin}/port-host/entry.js`)).text()).toBe("owned");
      expect((await fetch(`${fixture.server.url.origin}/port-hostile`)).status).toBe(401);
      expect(calls).toBe(2);
    } finally { await fixture.stop(); }
  });
  test.each([
    "https://example.com/api/plugins/kanban/board", "/api/plugins/kanban/tasks/t-1/../board", "/api/plugins/kanban/board?profile=other",
    "/api/plugins/kanban/board?board=default&board=other", "/api/plugins/kanban/tasks/%2fetc", "/api/plugins/kanban/board#escape",
  ])("rejects untrusted scope or URL %s", path => {
    expect(() => nativeSdkRequest(path)).toThrow(DashboardClientError);
  });

  test.each(["/dispatch", "/boards", "/tasks/t-1/decompose", "/tasks/t-1/attachments"])("denies excluded POST %s before transport", path => {
    expect(() => nativeSdkRequest(`/api/plugins/kanban${path}`, { method: "POST", body: "{}" })).toThrow(DashboardClientError);
  });

  test("keeps two explicitly selected boards distinct", () => {
    const first = nativeSdkRequest("/api/plugins/kanban/tasks/qa-1?board=default");
    const second = nativeSdkRequest("/api/plugins/kanban/tasks/qa-1?board=second");
    expect([first.board, second.board]).toEqual(["default", "second"]);
    expect(first.route).toBe("GET /tasks/{task_id}");
  });

  test("reads authenticated native-shaped data through the accepted client", async () => {
    const fixture = faultFixture();
    const lifetime = new AbortController();
    const client = fixture.client;
    try {
      const sdk = kanbanSdkTransport({ client, watch: () => () => undefined, onMutation: () => undefined }, lifetime.signal);
      const result = await sdk.fetchJSON("/api/plugins/kanban/tasks/repeat-001?board=default");
      expect(result).toHaveProperty("task.title", "Synthetic original");
      expect(fixture.requests.filter(request => request.path.endsWith("/tasks/repeat-001"))).toEqual([{ method: "GET", path: "/api/plugins/kanban/tasks/repeat-001", board: "default", profile: "default" }]);
    } finally { lifetime.abort(); client.dispose(); await fixture.stop(); }
  });

  test("does not send a request after leaf cancellation", async () => {
    const lifetime = new AbortController();
    lifetime.abort();
    let called = false;
    const sdk = kanbanSdkTransport({ client: {
      read: async () => { called = true; return {}; },
      mutate: async () => { called = true; return { kind: "applied", response: {} }; },
      attachment: async () => { called = true; return new Uint8Array(); },
    }, watch: () => () => undefined, onMutation: () => undefined }, lifetime.signal);
    await expect(sdk.fetchJSON("/api/plugins/kanban/board?board=default")).rejects.toThrow();
    expect(called).toBe(false);
  });
});
