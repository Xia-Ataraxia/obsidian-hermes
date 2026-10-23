import type { ProfileKey, ScopedIdentity } from "../types/control-center";
import type { ActivityActor, ActivityEdge, ActivityWindow, TaskActivity } from "../types/task-activity";
import { serializeScopedKey } from "./control-center-validation";

export const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
export const compareIdentity = (left: ScopedIdentity, right: ScopedIdentity): number => compareText(serializeScopedKey(left), serializeScopedKey(right));
export const compareEvent = (left: TaskActivity, right: TaskActivity): number => left.occurredAt - right.occurredAt || compareIdentity(left.event, right.event);
export const sameWindow = (left: ActivityWindow, right: ActivityWindow): boolean => left.preset === right.preset && left.start === right.start && left.end === right.end;
export const validWindow = (window: ActivityWindow): boolean => Number.isFinite(window.end) && window.end >= 0
  && (window.start === null ? window.preset === "all" : Number.isFinite(window.start) && window.start >= 0 && window.start < window.end);

function unreachable(value: never): never { throw new TypeError(`Unsupported activity actor: ${String(value)}`); }

export function resolveActor(actor: ActivityActor, profiles: ReadonlyMap<string, ProfileKey>): ActivityActor {
  switch (actor.kind) {
    case "unknown": {
      const profile = actor.reason === "unrecognized-actor" && actor.recordedLabel !== undefined ? profiles.get(actor.recordedLabel) : undefined;
      return profile === undefined ? actor : { kind: "current-profile", profile };
    }
    case "current-profile": {
      const profile = profiles.get(actor.profile.profile);
      return profile !== undefined && compareIdentity(profile, actor.profile) === 0 ? { kind: "current-profile", profile }
        : { kind: "unknown", reason: "unrecognized-actor", recordedLabel: actor.profile.profile };
    }
    case "retired-profile":
    case "system":
    case "generic": return actor;
    default: return unreachable(actor);
  }
}

function actorSignature(actor: ActivityActor): readonly unknown[] {
  switch (actor.kind) {
    case "current-profile":
    case "retired-profile": return [actor.kind, serializeScopedKey(actor.profile)];
    case "unknown": return [actor.kind, actor.reason, actor.recordedLabel];
    case "system":
    case "generic": return [actor.kind, actor.label];
    default: return unreachable(actor);
  }
}
export function eventSignature(event: TaskActivity): string {
  return JSON.stringify([serializeScopedKey(event.event), serializeScopedKey(event.task), event.type, event.occurredAt, actorSignature(event.from), actorSignature(event.to)]);
}

export function activityEdge(profiles: readonly [ProfileKey, ProfileKey], events: readonly TaskActivity[]): ActivityEdge {
  const tasks = new Map(events.map((event) => [serializeScopedKey(event.task), event.task]));
  const typeCount = (type: TaskActivity["type"]) => new Set(events.filter((event) => event.type === type).map((event) => serializeScopedKey(event.task))).size;
  return { profiles, tasks: [...tasks.values()].sort(compareIdentity), events: [...events].sort(compareEvent), distinctTaskCount: tasks.size,
    taskCountByType: { creation: typeCount("creation"), transfer: typeCount("transfer"), review: typeCount("review"), revision: typeCount("revision") } };
}
