import type { ControlCenterClock } from "../src/ui/control-center-refresh";
import { controlCenterClock } from "../src/ui/control-center-refresh";
import { parseControlCenterToken, parseScopedIdentity } from "../src/domain/control-center-validation";
import type { ScopedIdentity } from "../src/types/control-center";
import { DashboardClientError } from "../src/types/dashboard-client";
import type { ControlCenterLeaf, ControlCenterSelection } from "../src/ui/control-center-state";
import type { DashboardClient } from "../src/ui/dashboard-client";
import type { DashboardEventBatch } from "../src/types/dashboard-client";
import { gate } from "./dashboard-client-fixture";

export function controlledClock() {
  let time = 0;
  const timers = new Map<number, { readonly at: number; readonly callback: () => void }>();
  let id = 0;
  const clock: ControlCenterClock = { now: () => time, later(callback, milliseconds) {
    const key = ++id;
    timers.set(key, { at: time + milliseconds, callback });
    return () => { timers.delete(key); };
  } };
  return { clock, get size() { return timers.size; }, advance(milliseconds: number) {
    const target = time + milliseconds;
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (next === undefined) break;
      time = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    time = target;
  } };
}
export function trackedClock() {
  const timers = new Set<() => void>();
  const clock: ControlCenterClock = { now: controlCenterClock.now, later(callback, milliseconds) {
    const cancel = () => { stop(); timers.delete(cancel); };
    const stop = controlCenterClock.later(() => { timers.delete(cancel); callback(); }, milliseconds);
    timers.add(cancel);
    return cancel;
  } };
  return { clock, get size() { return timers.size; } };
}
export function connectionId() {
  const parsed = parseControlCenterToken("connection", "fixture");
  if (!parsed.ok) throw new DashboardClientError("invalid-request");
  return parsed.value;
}
export function identity(value: unknown): ScopedIdentity {
  const parsed = parseScopedIdentity(value);
  if (!parsed.ok) throw new DashboardClientError("invalid-request");
  return parsed.value;
}
export function selection<T>(load: ControlCenterSelection<T>["load"], revision: ControlCenterSelection<T>["revision"], name = "default"): ControlCenterSelection<T> {
  return { entity: identity({ kind: "profile", connection: "fixture", profile: name }), channel: "SOUL", load, revision };
}
export function when<T>(leaf: ControlCenterLeaf<T>, matches: () => boolean): Promise<void> {
  if (matches()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { unsubscribe(); reject(new DashboardClientError("timeout")); }, 3_000);
    const unsubscribe = leaf.subscribe(() => { if (matches()) { clearTimeout(timeout); unsubscribe(); resolve(); } });
  });
}

export function controlledSubscriptions() {
  type Attempt = {
    readonly established: Promise<void>;
    readonly signal: AbortSignal | undefined;
    readonly events: (batch: DashboardEventBatch) => void;
    readonly end: (failure: DashboardClientError | null) => void;
    readonly close: () => void;
    readonly closes: () => number;
  };
  const attempts: Attempt[] = [];
  const client: Pick<DashboardClient, "subscribe"> = { async subscribe(request, context) {
    const established = gate<void>(), closed = gate<DashboardClientError | null>(); let closes = 0;
    const close = () => { closes++; closed.resolve(null); };
    attempts.push({ established: established.promise, signal: context?.signal, events: request.onEvents, end: closed.resolve, close, closes: () => closes });
    return { get closed() { established.resolve(); return closed.promise; }, close };
  } };
  return { client, attempts, attempt(index: number): Attempt {
    const attempt = attempts[index];
    if (attempt === undefined) throw new DashboardClientError("invalid-request");
    return attempt;
  }, cleanup() { for (const attempt of attempts) attempt.close(); } };
}
