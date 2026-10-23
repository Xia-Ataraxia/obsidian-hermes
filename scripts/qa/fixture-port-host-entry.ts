import { mountKanbanSdkHost } from "../../src/ui/kanban-sdk-host";
import { DashboardClientError } from "../../src/types/dashboard-client";
import type { DashboardRequest, DashboardRequestContext } from "../../src/types/dashboard-client";
import { parseDashboardEvents, parseDashboardJson, requireObject } from "../../src/ui/dashboard-response";
import type { KanbanWatch, KanbanHostServices } from "../../src/ui/kanban-host-services";
import { nativeSdkRequest } from "../../src/ui/kanban-sdk-routes";

const failures: string[] = [];
const errorOutput = document.createElement("output");
errorOutput.id = "console";
errorOutput.textContent = "[]";
errorOutput.hidden = true;
document.body.append(errorOutput);
function recordFailure(value: string) { failures.push(value); errorOutput.textContent = JSON.stringify(failures); }
window.addEventListener("error", event => recordFailure(event.message));
window.addEventListener("unhandledrejection", event => recordFailure(String(event.reason)));
const consoleError = console.error.bind(console);
console.error = (...values: unknown[]) => { recordFailure(values.map(String).join(" ")); consoleError(...values); };
const timings: { kind: string; board: string; time: number }[] = [];
const timingOutput = document.createElement("output");
timingOutput.id = "timings"; timingOutput.hidden = true; document.body.append(timingOutput);
function timing(kind: string, board: string) {
  timings.push({ kind, board, time: performance.now() });
  if (timings.length > 200) timings.shift();
  timingOutput.textContent = JSON.stringify(timings);
}

async function request(operation: string, input: unknown, signal?: AbortSignal) {
  if (operation === "read" && typeof input === "object" && input && "route" in input && "board" in input) timing(String(input.route), String(input.board));
  const response = await fetch(`/port-host/${operation}`, { method: "POST", headers: { "X-Kanban-Fixture": "leaf-host", "Content-Type": "application/json" }, body: JSON.stringify(input), signal: signal ?? AbortSignal.timeout(10_000) });
  if (!response.ok) throw new DashboardClientError("native-error", response.status);
  return response;
}
const client: KanbanHostServices["client"] = {
  read: async (input: DashboardRequest, context?: DashboardRequestContext) => requireObject(parseDashboardJson(await (await request("read", input, context?.signal)).text())),
  attachment: async (board, id, context) => new Uint8Array(await (await request("attachment", { route: "GET /attachments/{attachment_id}", board, id }, context?.signal)).arrayBuffer()),
  mutate: async (input, context) => {
    const result = requireObject(parseDashboardJson(await (await request("mutate", input, context?.signal)).text()));
    if (result["kind"] !== "applied") throw new DashboardClientError("native-error", 409, "Fixture mutation requires reconciliation");
    return { kind: "applied", response: requireObject(result["response"] ?? null) };
  },
};
function watch(input: KanbanWatch) {
  const controller = new AbortController();
  let cursor = input.since;
  let backoff = 1000;
  let retry = 0;
  let refresh = 0;
  const events: import("../../src/types/dashboard-client").DashboardEventBatch["events"][number][] = [];
  const poll = window.setInterval(input.onRefresh, 15_000);
  const connect = async () => {
    try {
      const response = await request("events", { board: input.board, since: cursor }, controller.signal);
      const reader = response.body?.getReader();
      if (!reader) throw new DashboardClientError("transport");
      backoff = 1000;
      let pending = "";
      const decoder = new TextDecoder();
      while (!controller.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        if (pending.length > 1_048_576) throw new DashboardClientError("response-cap");
        const lines = pending.split("\n"); pending = lines.pop() ?? "";
        for (const line of lines) {
          const batch = parseDashboardEvents(line); cursor = batch.cursor;
          if (!batch.events.length) continue;
          events.push(...batch.events);
          timing("received", input.board);
          if (events.length > 4096) throw new DashboardClientError("response-cap");
          if (!refresh) refresh = window.setTimeout(() => {
            refresh = 0;
            timing("flush", input.board);
            input.onEvents({ events: events.splice(0), cursor });
            input.onRefresh();
          }, 250);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) input.onFailure(error instanceof DashboardClientError ? error : new DashboardClientError("transport"));
    }
    if (!controller.signal.aborted) { retry = window.setTimeout(() => { void connect(); }, backoff); backoff = Math.min(backoff * 2, 15_000); }
  };
  void connect();
  return () => { controller.abort(); window.clearTimeout(retry); window.clearTimeout(refresh); window.clearInterval(poll); };
}
const a = document.getElementById("host-a"), b = document.getElementById("host-b"), result = document.getElementById("result");
if (!a || !b || !result) throw new Error("Host fixture targets absent");
const services = { client, watch, onMutation: () => undefined };
let first = mountKanbanSdkHost(a, services);
const second = mountKanbanSdkHost(b, { ...services, initialBoard: "xia-dev" });
const unmount = () => { first.dispose(); result.textContent = JSON.stringify({ first: first.diagnostics(), second: second.diagnostics(), sdkGlobal: "__HERMES_PLUGIN_SDK__" in window }); };
document.getElementById("unmount")?.addEventListener("click", unmount);
const arm = document.createElement("button");
arm.textContent = "Unmount first during next drag";
document.querySelector("header")?.append(arm);
arm.addEventListener("click", () => {
  a.addEventListener("dragstart", () => { queueMicrotask(unmount); }, { once: true });
  result.textContent = "drag-unmount armed";
});
document.getElementById("remount")?.addEventListener("click", () => { first.dispose(); first = mountKanbanSdkHost(a, services); result.textContent = "remounted"; });
document.getElementById("denied")?.addEventListener("click", () => { try { nativeSdkRequest("/api/plugins/kanban/dispatch", { method: "POST" }); result.textContent = "UNSAFE"; } catch (error) { if (!(error instanceof DashboardClientError)) throw error; result.textContent = error.code; } });
window.addEventListener("pagehide", () => { first.dispose(); second.dispose(); }, { once: true });
