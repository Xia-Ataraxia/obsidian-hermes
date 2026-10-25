import { profileDir } from "./data";
import { activityScript, parseActivity, type Activity } from "./activity";
import { json, type Sections } from "./remote";

/*
 * The chat's bottom strip: what the profile is running right now. Hermes keeps the live dock (subagents, background
 * processes) in its own memory, so over SSH this is rebuilt from what it persists: state.db (turns, subagents,
 * background delegations) and the gateway's processes.json checkpoint. Times are epoch seconds on the host clock.
 */
export type HudKind = "session" | "agent" | "job" | "process";
export interface HudItem {
  readonly key: string; readonly kind: HudKind; readonly label: string; readonly detail: string | null; readonly model: string | null;
  readonly state: "running" | "done" | "failed"; readonly started: number;
  /** Null while running. */
  readonly ended: number | null;
}
export interface Hud { readonly at: number; readonly items: readonly HudItem[] }
export interface Proc { readonly id: string; readonly pid: number; readonly command: string; readonly started: number }

/** A finished agent stays on the strip this long (seconds), so its outcome can be read before it leaves. */
export const LINGER = 20;

const flat = (text: string | null | undefined): string => (text ?? "").trim().replace(/\s+/g, " ");

/** `processes.json` rows whose pid answers `kill -0`; only host-scoped pids can be probed from the SSH shell. */
const PROCS = String.raw`S procs
if [ -f processes.json ]; then
  Q="from json_each(cast(readfile('processes.json') as text)) where coalesce(json_extract(value,'\$.pid_scope'),'host')='host'"
  sqlite3 :memory: "select json_group_array(json_object('id',json_extract(value,'\$.session_id'),'pid',json_extract(value,'\$.pid'),'command',substr(json_extract(value,'\$.command'),1,200),'started',json_extract(value,'\$.started_at'))) $Q" 2>/dev/null || printf '[]\n'
  S alive
  for p in $(sqlite3 :memory: "select json_extract(value,'\$.pid') $Q" 2>/dev/null); do
    case $p in ''|0*|*[!0-9]*) continue;; esac
    kill -0 "$p" 2>/dev/null && echo "$p"
  done
fi
`;

export function hudScript(profile: string): string {
  return `cd ${profileDir(profile)} 2>/dev/null || exit 0\n${PROCS}${activityScript(profile)}`;
}

export function parseProcs(sections: Sections): Proc[] {
  const alive = new Set((sections.get("alive") ?? "").split("\n").map(Number));
  const rows = json<unknown>(sections.get("procs"), []);
  if (!Array.isArray(rows)) return [];
  return (rows as Partial<Proc>[]).flatMap(p =>
    typeof p.pid === "number" && alive.has(p.pid) ? [{ id: String(p.id ?? p.pid), pid: p.pid, command: flat(p.command), started: Number(p.started) || 0 }] : []);
}

/** Running things first (oldest first, so rows keep their place), then the ones that just finished. */
export function buildHud(activity: Activity, procs: readonly Proc[]): Hud {
  const { at } = activity;
  const items: HudItem[] = [];
  const children = activity.delegations.flatMap(d => d.children);
  for (const s of activity.now) {
    if (s.child || !s.turn) continue;
    items.push({ key: `s:${s.id}`, kind: "session", label: flat(s.title) || s.source || "Session", detail: flat(s.doing) || null, model: s.model, state: "running", started: s.started, ended: null });
  }
  for (const k of children) {
    const ended = k.status === "ended" ? k.started + k.secs : null;
    if (k.status === "stale" || (ended !== null && at - ended > LINGER)) continue;
    const state = ended === null ? "running" : k.end && k.end !== "agent_close" ? "failed" : "done";
    items.push({ key: `a:${k.id}`, kind: "agent", label: flat(k.label) || flat(k.goal).slice(0, 80) || "Subagent", detail: ended === null ? flat(k.doing) || null : k.end, model: k.model, state, started: k.started, ended });
  }
  for (const j of activity.async) {
    if (j.completed !== null || at - j.dispatched > 6 * 3600) continue;
    items.push({ key: `j:${j.dispatched}`, kind: "job", label: flat(j.goal).slice(0, 80) || "Background delegation", detail: j.tasks ? `${j.tasks} task${j.tasks === 1 ? "" : "s"}` : null, model: null, state: "running", started: j.dispatched, ended: null });
  }
  for (const p of procs) {
    items.push({ key: `p:${p.id}`, kind: "process", label: p.command || `pid ${p.pid}`, detail: `pid ${p.pid}`, model: null, state: "running", started: p.started, ended: null });
  }
  const rank = (i: HudItem): number => (i.state === "running" ? 0 : 1);
  return { at, items: items.sort((a, b) => rank(a) - rank(b) || a.started - b.started) };
}

/** `null`: the query failed. A profile without state.db has nothing running. */
export function parseHud(sections: Sections): Hud | null {
  const activity = parseActivity(sections);
  return activity && buildHud(activity, parseProcs(sections));
}

/** `42s`, `3:07`, `1h 05m`. */
export function elapsed(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}
