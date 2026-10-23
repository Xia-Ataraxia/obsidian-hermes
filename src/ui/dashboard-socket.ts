import { DASHBOARD_LIMITS, DashboardClientError } from "../types/dashboard-client";
import type { DashboardEventBatch, DashboardRequestContext, DashboardSubscription } from "../types/dashboard-client";
import { assertCurrent } from "./dashboard-http";
import { parseDashboardEvents } from "./dashboard-response";
import { scopeToken } from "./dashboard-routes";
import type { DashboardSession } from "./dashboard-auth";

export type DashboardSocketRequest = { readonly board: string; readonly since?: number; readonly onEvents: (batch: DashboardEventBatch) => void };
export async function subscribeDashboard(session: DashboardSession, input: DashboardSocketRequest, context: DashboardRequestContext): Promise<DashboardSubscription> {
  const board = scopeToken("board", input.board);
  if (input.since !== undefined && (!Number.isSafeInteger(input.since) || input.since < 0)) throw new DashboardClientError("invalid-request");
  const token = await session.authenticate(context);
  assertCurrent(session.connection, context);
  const url = new URL("/api/plugins/kanban/events", session.origin);
  url.protocol = "ws:";
  url.searchParams.set("profile", "default");
  url.searchParams.set("board", board);
  url.searchParams.set("token", token);
  if (input.since !== undefined) url.searchParams.set("since", String(input.since));
  let socket: WebSocket | null = new WebSocket(url);
  url.search = "";
  socket.binaryType = "arraybuffer";
  let ended = false;
  let cursor = input.since ?? 0;
  let resolveClosed: (reason: DashboardClientError | null) => void = () => undefined;
  const closed = new Promise<DashboardClientError | null>(resolve => { resolveClosed = resolve; });
  let rejectReady: (reason: DashboardClientError) => void = () => undefined;
  const signal = AbortSignal.any([session.connection.signal, ...(context.signal ? [context.signal] : [])]);
  const finish = (failure: DashboardClientError | null) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    socket?.removeEventListener("message", message);
    socket?.close();
    socket = null;
    rejectReady(failure ?? new DashboardClientError("cancelled"));
    resolveClosed(failure);
  };
  const cancel = () => finish(new DashboardClientError("cancelled"));
  const message = (event: MessageEvent<unknown>) => {
    try {
      assertCurrent(session.connection, context);
      if (typeof event.data !== "string") throw new DashboardClientError("malformed-response");
      if (Buffer.byteLength(event.data) > DASHBOARD_LIMITS.socketBytes) throw new DashboardClientError("response-cap");
      const batch = parseDashboardEvents(event.data);
      if (batch.cursor < cursor || batch.events.some(entry => entry.id <= cursor)) throw new DashboardClientError("malformed-response");
      cursor = batch.cursor;
      input.onEvents(batch);
    } catch (error) {
      if (error instanceof DashboardClientError) { finish(error); return; }
      finish(new DashboardClientError("transport"));
      throw error;
    }
  };
  const timer = setTimeout(() => finish(new DashboardClientError("timeout")), DASHBOARD_LIMITS.timeoutMs);
  signal.addEventListener("abort", cancel, { once: true });
  socket.addEventListener("message", message);
  socket.addEventListener("error", () => finish(new DashboardClientError("transport")), { once: true });
  socket.addEventListener("close", event => finish(event.code === 1000 ? null : new DashboardClientError(event.code === 1008 ? "authentication-required" : "transport")), { once: true });
  const ready = new Promise<void>((resolve, reject) => {
    rejectReady = reject;
    socket?.addEventListener("open", () => {
      try { assertCurrent(session.connection, context); clearTimeout(timer); resolve(); }
      catch (error) { if (error instanceof DashboardClientError) finish(error); else reject(error); }
    }, { once: true });
  });
  if (signal.aborted) cancel();
  await ready;
  return { closed, close: () => finish(null) };
}
