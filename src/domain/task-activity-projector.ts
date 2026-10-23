import type { BoardKey, ProfileKey } from "../types/control-center";
import type { BoardActivitySnapshot, ProfileActivityPresence, TaskActivity } from "../types/task-activity";
import type { ActivityProjectionIssue, ActivityProjectionIssueCode, TaskActivityProjection, TaskActivityProjectionInput } from "../types/task-activity-projection";
import { serializeScopedKey } from "./control-center-validation";
import { activityEdge, compareEvent, compareIdentity, compareText, eventSignature, resolveActor, sameWindow, validWindow } from "./task-activity-projection-helpers";

export type { TaskActivityProjection, TaskActivityProjectionInput } from "../types/task-activity-projection";

/** Pure, roster-first projection. No clock, I/O, search filtering, actor inference or cross-board atomicity. */
export function projectTaskActivity(input: TaskActivityProjectionInput): TaskActivityProjection {
  // These maps/flags are local accumulators; caller snapshots and roster remain untouched.
  const issues = new Map<string, ActivityProjectionIssue>();
  let complete = true;
  let fresh = true;
  let attributionComplete = true;
  const issue = (code: ActivityProjectionIssueCode, board?: BoardKey, event?: TaskActivity["event"]) => {
    const value = { code, ...(board ? { board } : {}), ...(event ? { event } : {}) };
    issues.set(JSON.stringify([code, board && serializeScopedKey(board), event && serializeScopedKey(event)]), value);
  };
  if (input.roster.coverage.kind !== "complete") { complete = false; issue("roster-coverage"); }
  if (input.roster.freshness.kind !== "fresh") { fresh = false; issue("roster-freshness"); }
  const profiles = new Map<string, ProfileKey>();
  for (const profile of input.roster.profiles) {
    if (profile.connection !== input.roster.connection) { complete = false; issue("roster-scope-mismatch"); }
    else profiles.set(profile.profile, profile);
  }
  const selected = new Map(input.selectedBoards.map((board) => [serializeScopedKey(board), board]));
  const snapshots = new Map<string, BoardActivitySnapshot[]>();
  for (const snapshot of input.snapshots) {
    const key = serializeScopedKey(snapshot.board);
    if (!selected.has(key)) { complete = false; issue("unexpected-board", snapshot.board); continue; }
    const group = snapshots.get(key) ?? [];
    group.push(snapshot);
    snapshots.set(key, group);
  }
  const valid = validWindow(input.window);
  if (!valid) { complete = false; issue("invalid-window"); }
  const events = new Map<string, TaskActivity>();
  const conflicting = new Set<string>();
  for (const [key, board] of selected) {
    if (board.connection !== input.roster.connection) { complete = false; issue("board-scope-mismatch", board); continue; }
    const group = snapshots.get(key) ?? [];
    const snapshot = group[0];
    if (snapshot === undefined) { complete = false; issue("missing-board", board); continue; }
    if (group.length !== 1) { complete = false; issue("duplicate-board", board); continue; }
    if (snapshot.coverage.kind !== "complete") { complete = false; issue("board-coverage", board); }
    if (snapshot.freshness.kind !== "fresh") { fresh = false; issue("board-freshness", board); }
    if (snapshot.malformedRowCount > 0) { complete = false; issue("malformed-rows", board); }
    if (snapshot.missingAttributionCount > 0) { attributionComplete = false; issue("missing-attribution", board); }
    if (!sameWindow(snapshot.window, input.window)) { complete = false; issue("window-mismatch", board); continue; }
    if (!valid) continue;
    for (const event of snapshot.activities) {
      if (event.event.connection !== board.connection || event.task.connection !== board.connection
        || event.event.board !== board.board || event.task.board !== board.board) {
        complete = false; issue("event-scope-mismatch", board, event.event); continue;
      }
      if (!Number.isFinite(event.occurredAt) || event.occurredAt >= input.window.end
        || (input.window.start !== null && event.occurredAt < input.window.start)) {
        complete = false; issue("event-window-mismatch", board, event.event); continue;
      }
      const eventKey = serializeScopedKey(event.event);
      const previous = events.get(eventKey);
      if (previous !== undefined && eventSignature(previous) !== eventSignature(event)) {
        conflicting.add(eventKey); complete = false; issue("conflicting-event", board, event.event);
      } else events.set(eventKey, event);
    }
  }
  const selectedTypes = new Set(input.types);
  const pairs = new Map<string, { readonly profiles: readonly [ProfileKey, ProfileKey]; readonly events: TaskActivity[] }>();
  const selfEvents = new Map<string, TaskActivity[]>();
  const involvement = new Map<string, Set<string>>();
  const otherEvents: TaskActivity[] = [];
  for (const [key, raw] of events) {
    if (conflicting.has(key) || !selectedTypes.has(raw.type)) continue;
    const event = { ...raw, from: resolveActor(raw.from, profiles), to: resolveActor(raw.to, profiles) };
    if (event.from.kind === "unknown" || event.to.kind === "unknown") {
      attributionComplete = false;
      issue("unknown-actor", { kind: "board", connection: event.event.connection, board: event.event.board }, event.event);
    }
    for (const actor of [event.from, event.to]) {
      if (actor.kind !== "current-profile") continue;
      const key = serializeScopedKey(actor.profile);
      const tasks = involvement.get(key) ?? new Set<string>();
      tasks.add(serializeScopedKey(event.task));
      involvement.set(key, tasks);
    }
    if (event.from.kind !== "current-profile" || event.to.kind !== "current-profile") { otherEvents.push(event); continue; }
    const order = compareIdentity(event.from.profile, event.to.profile);
    if (order === 0) {
      const key = serializeScopedKey(event.from.profile);
      const details = selfEvents.get(key) ?? [];
      details.push(event); selfEvents.set(key, details); continue;
    }
    const pair: readonly [ProfileKey, ProfileKey] = order < 0 ? [event.from.profile, event.to.profile] : [event.to.profile, event.from.profile];
    const pairKey = JSON.stringify(pair.map(serializeScopedKey));
    const group = pairs.get(pairKey) ?? { profiles: pair, events: [] };
    group.events.push(event); pairs.set(pairKey, group);
  }
  const partial = !complete || !fresh || !attributionComplete;
  const edges = [...pairs.entries()].sort(([left], [right]) => compareText(left, right)).map(([, group]) => activityEdge(group.profiles, group.events));
  const peerTasks = new Map<string, Set<string>>();
  const peerDegrees = new Map<string, number>();
  for (const edge of edges) {
    for (const profile of edge.profiles) {
      const key = serializeScopedKey(profile);
      peerDegrees.set(key, (peerDegrees.get(key) ?? 0) + 1);
      const tasks = peerTasks.get(key) ?? new Set<string>();
      for (const task of edge.tasks) tasks.add(serializeScopedKey(task));
      peerTasks.set(key, tasks);
    }
  }
  const presence = (count: number): ProfileActivityPresence => count > 0 ? { kind: "observed", distinctTaskCount: count, partial }
    : !complete ? { kind: "unknown", reason: "coverage" }
      : !fresh ? { kind: "unknown", reason: "freshness" }
        : !attributionComplete ? { kind: "unknown", reason: "attribution" } : { kind: "no-observed-activity", window: input.window };
  return {
    nodes: [...profiles.values()].sort(compareIdentity).map((profile) => {
      const key = serializeScopedKey(profile);
      const involved = involvement.get(key)?.size ?? 0;
      const peers = peerTasks.get(key)?.size ?? 0;
      return { profile, presence: presence(involved), peerDegree: peerDegrees.get(key) ?? 0,
        peerPresence: peers > 0 || partial || involved === 0 ? presence(peers)
          : { kind: "self-or-other-activity", distinctTaskCount: involved, partial },
        selfEvents: (selfEvents.get(key) ?? []).sort(compareEvent) };
    }),
    edges,
    otherEvents: otherEvents.sort(compareEvent),
    coverage: { complete, fresh, attributionComplete, issues: [...issues.entries()].sort(([left], [right]) => compareText(left, right)).map(([, value]) => value) },
  };
}
