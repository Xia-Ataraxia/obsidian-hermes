import { CONTROL_CENTER_TIMING } from "../types/control-center";
import { DASHBOARD_LIMITS, DashboardClientError } from "../types/dashboard-client";
import type { DashboardClient } from "./dashboard-client";
import type { DashboardEvent, DashboardEventBatch, DashboardSubscription } from "../types/dashboard-client";
import type { KanbanWatch } from "./kanban-host-services";

export interface ControlCenterClock {
  now(): number;
  later(callback: () => void, milliseconds: number): () => void;
}
export const controlCenterClock: ControlCenterClock = {
  now: () => Date.now(),
  later(callback, milliseconds) {
    const handle = setTimeout(callback, milliseconds);
    return () => clearTimeout(handle);
  },
};

type Watcher = { readonly request: KanbanWatch; readonly relevant: (batch: DashboardEventBatch) => boolean };
type Channel = {
  readonly board: string;
  readonly watchers: Set<Watcher>;
  cursor: number;
  attempt: number;
  generation: number;
  controller: AbortController;
  socket: DashboardSubscription | null;
  reconnect: (() => void) | null;
  poll: (() => void) | null;
  flush: (() => void) | null;
  readonly events: Map<number, DashboardEvent>;
  bytes: number;
  buffered: boolean;
  invalidateAll: boolean;
};
const BACKOFF = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

/** A board has one socket and polling timer, regardless of the number of visible leaves. */
export class ControlCenterRefresh {
  private readonly channels = new Map<string, Channel>();
  private disposed = false;
  constructor(private readonly client: Pick<DashboardClient, "subscribe">, private readonly clock: ControlCenterClock) {}

  watch(request: KanbanWatch, relevant: (batch: DashboardEventBatch) => boolean = () => true): () => void {
    if (this.disposed) return () => undefined;
    let channel = this.channels.get(request.board);
    const first = channel === undefined;
    if (channel === undefined) {
      channel = { board: request.board, watchers: new Set(), cursor: request.since, attempt: 0, generation: 0, controller: new AbortController(), socket: null, reconnect: null, poll: null, flush: null, events: new Map(), bytes: 0, buffered: false, invalidateAll: false };
      this.channels.set(request.board, channel);
    }
    const watcher: Watcher = { request, relevant };
    channel.watchers.add(watcher);
    const owned = channel;
    if (first) { this.poll(owned); void this.connect(owned); }
    return () => {
      if (!owned.watchers.delete(watcher)) return;
      if (owned.watchers.size === 0) this.stop(owned);
    };
  }

  private active(channel: Channel): boolean { return !this.disposed && this.channels.get(channel.board) === channel && channel.watchers.size > 0; }
  private poll(channel: Channel): void {
    channel.poll = this.clock.later(() => {
      if (!this.active(channel)) return;
      for (const watcher of [...channel.watchers]) if (channel.watchers.has(watcher)) watcher.request.onRefresh();
      if (this.active(channel)) this.poll(channel);
    }, CONTROL_CENTER_TIMING.pollMs);
  }
  invalidate(board?: string): void {
    for (const channel of this.channels.values()) {
      if (board !== undefined && channel.board !== board) continue;
      channel.invalidateAll = true;
      this.coalesce(channel);
    }
  }
  private coalesce(channel: Channel): void {
    if (channel.flush !== null) return;
    channel.flush = this.clock.later(() => {
      channel.flush = null;
      if (!this.active(channel)) return;
      const batch = { events: [...channel.events.values()], cursor: channel.cursor };
      const buffered = channel.buffered, invalidateAll = channel.invalidateAll;
      this.clearBuffer(channel);
      for (const watcher of [...channel.watchers]) {
        if (!this.active(channel) || !channel.watchers.has(watcher)) continue;
        if (buffered) watcher.request.onEvents(batch);
        if (this.active(channel) && channel.watchers.has(watcher) && (invalidateAll || buffered && watcher.relevant(batch))) watcher.request.onRefresh();
      }
    }, CONTROL_CENTER_TIMING.coalesceMs);
  }
  private clearBuffer(channel: Channel): void {
    channel.events.clear();
    channel.bytes = 0;
    channel.buffered = false;
    channel.invalidateAll = false;
  }
  private async connect(channel: Channel): Promise<void> {
    const generation = ++channel.generation;
    const current = () => this.active(channel) && generation === channel.generation;
    channel.controller = new AbortController();
    try {
      const socket = await this.client.subscribe({ board: channel.board, since: channel.cursor, onEvents: batch => {
        if (!current()) return;
        channel.cursor = batch.cursor;
        channel.attempt = 0;
        for (const event of batch.events) {
          if (channel.events.has(event.id)) continue;
          const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
          if (channel.events.size >= 1024 || channel.bytes + bytes > DASHBOARD_LIMITS.socketBytes) {
            this.clearBuffer(channel);
            channel.invalidateAll = true;
            this.coalesce(channel);
            ++channel.generation;
            channel.controller.abort();
            channel.socket?.close();
            this.failed(channel, new DashboardClientError("response-cap"));
            return;
          }
          channel.events.set(event.id, event);
          channel.bytes += bytes;
        }
        channel.buffered = true;
        this.coalesce(channel);
      } }, { signal: channel.controller.signal, isCurrent: current });
      if (!current()) { socket.close(); return; }
      channel.socket = socket;
      if (generation > 1) for (const watcher of [...channel.watchers]) if (channel.watchers.has(watcher)) watcher.request.onRefresh();
      const failure = await socket.closed;
      if (current()) this.failed(channel, failure ?? new DashboardClientError("transport"));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (current()) this.failed(channel, error instanceof DashboardClientError ? error : new DashboardClientError("transport"));
    }
  }
  private failed(channel: Channel, error: DashboardClientError): void {
    const generation = channel.generation;
    channel.socket = null;
    for (const watcher of [...channel.watchers]) if (channel.generation === generation && channel.watchers.has(watcher)) watcher.request.onFailure(error);
    if (!this.active(channel) || channel.generation !== generation) return;
    const delay = BACKOFF[Math.min(channel.attempt++, BACKOFF.length - 1)] ?? 15_000;
    channel.reconnect = this.clock.later(() => {
      channel.reconnect = null;
      if (this.active(channel) && channel.generation === generation) void this.connect(channel);
    }, delay);
  }
  retry(board?: string): void {
    for (const channel of this.channels.values()) {
      if (board !== undefined && channel.board !== board) continue;
      ++channel.generation;
      channel.controller.abort();
      channel.socket?.close();
      channel.socket = null;
      channel.reconnect?.();
      channel.reconnect = null;
      channel.attempt = 0;
      void this.connect(channel);
      for (const watcher of [...channel.watchers]) if (channel.watchers.has(watcher)) watcher.request.onRefresh();
    }
  }
  private stop(channel: Channel): void {
    if (this.channels.get(channel.board) === channel) this.channels.delete(channel.board);
    ++channel.generation;
    channel.controller.abort();
    channel.socket?.close();
    channel.socket = null;
    channel.reconnect?.();
    channel.poll?.();
    channel.flush?.();
    this.clearBuffer(channel);
    channel.watchers.clear();
  }
  dispose(): void {
    this.disposed = true;
    for (const channel of this.channels.values()) this.stop(channel);
  }
}
