import { request } from "node:http";
import type { DashboardConnection } from "../types/dashboard-connection";
import { DashboardClientError } from "../types/dashboard-client";
import type { DashboardRequestContext } from "../types/dashboard-client";

export type DashboardWireRequest = {
  readonly url: URL;
  readonly method: string;
  readonly token?: string;
  readonly body?: string;
  readonly cap: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
};
export type DashboardWireResponse = { readonly status: number; readonly bytes: Uint8Array };
export function dashboardOrigin(connection: DashboardConnection): URL {
  const url = new URL(connection.baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !Number.isSafeInteger(connection.generation) || connection.generation < 0) throw new DashboardClientError("invalid-request");
  return url;
}
export function assertCurrent(connection: DashboardConnection, context: DashboardRequestContext): void {
  if (connection.signal.aborted || context.signal?.aborted) throw new DashboardClientError("cancelled");
  if (context.isCurrent && !context.isCurrent()) throw new DashboardClientError("stale-generation");
}
export function dashboardHttp(input: DashboardWireRequest): Promise<DashboardWireResponse> {
  return new Promise((resolve, reject) => {
    if (input.signal.aborted) { reject(new DashboardClientError("cancelled")); return; }
    const chunks: Uint8Array[] = [];
    let length = 0;
    let settled = false;
    const finish = (error?: DashboardClientError, response?: DashboardWireResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener("abort", cancel);
      if (error) reject(error);
      else if (response) resolve(response);
    };
    const outgoing = request(input.url, { method: input.method, agent: false, headers: {
      "Accept": "application/json", "Accept-Encoding": "identity",
      ...(input.token ? { "X-Hermes-Session-Token": input.token } : {}),
      ...(input.body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(input.body) } : {}),
    } }, incoming => {
      const declared = incoming.headers["content-length"];
      if (declared && Number(declared) > input.cap || incoming.headers["content-encoding"] && incoming.headers["content-encoding"] !== "identity") {
        finish(new DashboardClientError("response-cap")); incoming.destroy(); outgoing.destroy(); return;
      }
      incoming.on("data", (chunk: Buffer) => {
        length += chunk.byteLength;
        if (length > input.cap) { finish(new DashboardClientError("response-cap")); incoming.destroy(); outgoing.destroy(); return; }
        chunks.push(chunk);
      });
      incoming.once("end", () => finish(undefined, { status: incoming.statusCode ?? 0, bytes: Buffer.concat(chunks, length) }));
      incoming.once("error", () => finish(new DashboardClientError("transport")));
      incoming.once("aborted", () => finish(new DashboardClientError("transport")));
    });
    const cancel = () => { finish(new DashboardClientError("cancelled")); outgoing.destroy(); };
    const timer = setTimeout(() => { finish(new DashboardClientError("timeout")); outgoing.destroy(); }, input.timeoutMs);
    input.signal.addEventListener("abort", cancel, { once: true });
    outgoing.once("error", () => finish(new DashboardClientError("transport")));
    outgoing.end(input.body);
  });
}
export function decodeDashboardText(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) { if (error instanceof TypeError) throw new DashboardClientError("malformed-response"); throw error; }
}
