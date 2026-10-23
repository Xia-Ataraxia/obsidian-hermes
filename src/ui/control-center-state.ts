import { serializeScopedKey } from "../domain/control-center-validation";
import type { ConnectionId, Freshness, ProfileRoster, ScopedIdentity } from "../types/control-center";
import { DashboardClientError } from "../types/dashboard-client";
import type { DashboardMutationResult, DashboardRequestContext } from "../types/dashboard-client";
import type { ProfileMetadataReader } from "../types/profile-catalog";
import type { DashboardClient } from "./dashboard-client";
import type { KanbanHostServices } from "./kanban-host-services";
import { ProfileCatalogReader } from "./profile-catalog-reader";
import { ControlCenterRefresh, controlCenterClock } from "./control-center-refresh";
import type { ControlCenterClock } from "./control-center-refresh";
import { ControlCenterLeaf } from "./control-center-leaf";
export { ControlCenterLeaf } from "./control-center-leaf";

export type ControlCenterSelection<T> = {
  readonly entity: ScopedIdentity;
  /** Distinguishes tabs and exact query/window scope; never relabel retained snapshots. */
  readonly channel: string;
  readonly load: (context: DashboardRequestContext) => Promise<T>;
  readonly revision: (value: T) => string;
  readonly merge?: (previous: T | null, incoming: T) => T;
  readonly freshness?: (value: T) => Freshness;
};
export type ControlCenterSnapshot<T> = {
  readonly value: T | null;
  readonly draft: T | null;
  readonly baseRevision: string | null;
  readonly conflict: boolean;
  readonly freshness: Freshness;
  readonly loading: boolean;
  readonly failure: Error | null;
  readonly mutation: "idle" | "saving" | "applied" | "uncertain";
  readonly mutationResult: DashboardMutationResult | null;
};
export type CloseDecision = { readonly kind: "allow" } | { readonly kind: "confirm-discard"; readonly dirtyCount: number; readonly saving: boolean };

/** Failed/incomplete roster reads cannot erase previously observed members. */
export function retainProfileRoster(previous: ProfileRoster | null, incoming: ProfileRoster): ProfileRoster {
  if (previous === null || previous.connection !== incoming.connection || incoming.coverage.kind === "complete" && incoming.freshness.kind === "fresh") return incoming;
  const members = new Map(previous.profiles.map(profile => [serializeScopedKey(profile), profile]));
  for (const profile of incoming.profiles) members.set(serializeScopedKey(profile), profile);
  return { ...incoming, profiles: [...members.values()], freshness: { kind: "stale", lastSuccessAt: previous.freshness.lastSuccessAt, reason: "transport-failure" } };
}

/** Connection-scoped owner. Client/tunnel leases remain owned by the composition root. */
export class ControlCenterState {
  private readonly leaves = new Set<{ dispose(): void }>();
  private readonly refreshOwner: ControlCenterRefresh;
  private readonly lifetime = new AbortController();
  private disposed = false;
  constructor(readonly connection: ConnectionId, readonly client: DashboardClient, private readonly metadata?: ProfileMetadataReader, readonly clock: ControlCenterClock = controlCenterClock) {
    this.refreshOwner = new ControlCenterRefresh(client, clock);
  }
  createLeaf<T>(): ControlCenterLeaf<T> {
    if (this.disposed) throw new DashboardClientError("cancelled");
    const leaf = new ControlCenterLeaf<T>(this, this.refreshOwner, this.metadata ? new ProfileCatalogReader(this.connection, this.client, this.metadata) : null, () => this.leaves.delete(leaf));
    this.leaves.add(leaf);
    return leaf;
  }
  retry(board?: string): void { if (!this.disposed) this.refreshOwner.retry(board); }
  /** Structural seam for task 13; the mounted host owns the returned watch release. */
  kanbanServices(initialBoard?: string): KanbanHostServices {
    const context = (input: DashboardRequestContext = {}): DashboardRequestContext => ({ signal: AbortSignal.any([this.lifetime.signal, ...(input.signal ? [input.signal] : [])]), isCurrent: () => !this.disposed && (input.isCurrent?.() ?? true) });
    return { client: {
      read: (request, input) => this.client.read(request, context(input)),
      mutate: (request, input) => this.client.mutate(request, context(input)),
      attachment: (board, id, input) => this.client.attachment(board, id, context(input)),
    }, watch: request => this.refreshOwner.watch(request), onMutation: () => this.refreshOwner.invalidate(), ...(initialBoard === undefined ? {} : { initialBoard }) };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    for (const leaf of this.leaves) leaf.dispose();
    this.leaves.clear();
    this.refreshOwner.dispose();
  }
}
