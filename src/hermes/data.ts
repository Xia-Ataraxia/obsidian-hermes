import type { SshReadOnlyAdapter } from "../ui/ssh-read-only-adapter";
import { b64Arg, json, runScript, safeToken, type RemoteResult, type Sections } from "./remote";

/* ───────────────────────── Profiles ───────────────────────── */

export interface Skill { readonly name: string; readonly category: string; readonly description: string }
export interface CronJob {
  readonly id: string; readonly name: string; readonly schedule: string; readonly enabled: boolean;
  readonly state: string | null; readonly next: string | null; readonly last: string | null;
  readonly status: string | null; readonly error: string | null; readonly deliver: string | null;
  readonly skills: readonly string[]; readonly prompt: string;
}
export interface Gateway { readonly state: string | null; readonly alive: boolean; readonly platforms: Readonly<Record<string, string>>; readonly served: readonly string[] }
export interface Usage {
  readonly sessions7d: number; readonly tokens7d: number; readonly cost7d: number; readonly messages7d: number;
  readonly last: number | null; readonly daily: readonly number[]; readonly sources: Readonly<Record<string, number>>;
  readonly recent: readonly (readonly [string, string, number])[];
}
export interface Load { running: number; ready: number; blocked: number; todo: number; review: number; done7d: number }
export interface Profile {
  readonly id: string; readonly description: string; readonly model: string; readonly provider: string;
  readonly skills: readonly Skill[]; readonly jobs: readonly CronJob[]; readonly gateway: Gateway | null;
  readonly usage: Usage | null; readonly load: Load;
}
export interface Edge { readonly from: string; readonly to: string; readonly weight: number }
export interface ProfilesSnapshot { readonly now: number; readonly profiles: readonly Profile[]; readonly edges: readonly Edge[] }

const PROFILES_SCRIPT = String.raw`
S now; date +%s
for d in "$H" "$H"/profiles/*; do
  [ -d "$d" ] || continue
  if [ "$d" = "$H" ]; then id=default; else id=$(basename "$d"); [ "$id" = default ] && continue; fi
  case "$id" in *[!A-Za-z0-9_.-]*|.*) continue;; esac
  cd "$d" || continue
  S "profile $id"; cat profile.yaml 2>/dev/null
  S "model $id"; awk '/^model:/{f=1;next} f&&/^[^ ]/{exit} f' config.yaml 2>/dev/null
  S "files $id"
  sqlite3 :memory: <<'SQL'
with sk(t) as (select cast(readfile('.skills_prompt_snapshot.json') as text)),
     jb(t) as (select cast(readfile('cron/jobs.json') as text)),
     gw(t) as (select cast(readfile('gateway_state.json') as text))
select json_object(
  'skills', (select json_group_array(json_array(json_extract(value,'$.skill_name'), json_extract(value,'$.category'), json_extract(value,'$.description'))) from sk, json_each(sk.t,'$.skills')),
  'jobs', (select json_group_array(json_object('id',json_extract(value,'$.id'),'name',json_extract(value,'$.name'),
     'schedule',coalesce(json_extract(value,'$.schedule_display'),json_extract(value,'$.schedule.display')),
     'enabled',json_extract(value,'$.enabled'),'state',json_extract(value,'$.state'),
     'next',json_extract(value,'$.next_run_at'),'last',json_extract(value,'$.last_run_at'),
     'status',json_extract(value,'$.last_status'),'error',substr(json_extract(value,'$.last_error'),1,400),
     'deliver',json_extract(value,'$.deliver'),'skills',json(coalesce(json_extract(value,'$.skills'),'[]')),
     'prompt',substr(json_extract(value,'$.prompt'),1,2000))) from jb, json_each(jb.t,'$.jobs')),
  'gateway', (select json_object('pid',json_extract(t,'$.pid'),'state',json_extract(t,'$.gateway_state'),
     'served',json(coalesce(json_extract(t,'$.served_profiles'),'[]')),
     'platforms',(select json_group_object(key, json_extract(value,'$.state')) from json_each(gw.t,'$.platforms')))
     from gw where t is not null));
SQL
  pid=$(sqlite3 :memory: "select json_extract(cast(readfile('gateway_state.json') as text),'\$.pid')" 2>/dev/null)
  S "alive $id"; [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo 1
  if [ -f state.db ]; then
    S "usage $id"
    sqlite3 -readonly state.db <<'SQL'
select json_object('sessions7d',count(*),
  'tokens7d',coalesce(sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)),0),
  'cost7d',round(coalesce(sum(coalesce(actual_cost_usd,estimated_cost_usd,0)),0),2),
  'messages7d',coalesce(sum(message_count),0),
  'last',(select max(coalesce(last_activity_at,started_at)) from sessions),
  'daily',(select json_group_array(c) from (with recursive d(i) as (select 13 union all select i-1 from d where i>0)
     select (select count(*) from sessions where started_at >= strftime('%s','now','start of day',(-i)||' days')
       and started_at < strftime('%s','now','start of day',(1-i)||' days')) c from d)),
  'sources',(select json_group_object(source,n) from (select coalesce(source,'other') source,count(*) n from sessions
     where started_at > strftime('%s','now')-7*86400 group by 1)),
  'recent',(select json_group_array(json_array(title,coalesce(source,''),coalesce(last_activity_at,started_at))) from
     (select title,source,last_activity_at,started_at from sessions where title is not null and title<>''
      order by coalesce(last_activity_at,started_at) desc limit 5)))
from sessions where started_at > strftime('%s','now')-7*86400;
SQL
  fi
done
for db in "$H/kanban.db" "$H"/kanban/boards/*/kanban.db; do
  [ -f "$db" ] || continue
  slug=default; [ "$db" = "$H/kanban.db" ] || slug=$(basename "$(dirname "$db")")
  case "$slug" in _*) continue;; esac
  S "graph $slug"
  sqlite3 -readonly "$db" <<'SQL'
with src as (select t.id, t.assignee dst, case when t.created_by='worker' then
    (select p.assignee from task_links l join tasks p on p.id=l.parent_id where l.child_id=t.id limit 1)
    else t.created_by end src from tasks t where t.created_at > strftime('%s','now')-30*86400)
select json_object(
  'edges',(select json_group_array(json_array(src,dst,n)) from (select src,dst,count(distinct id) n from src
     where src is not null and dst is not null and src<>dst group by 1,2)),
  'load',(select json_group_array(json_array(assignee,status,n)) from (select assignee,status,count(*) n from tasks
     where assignee is not null and status not in ('archived','done') group by 1,2)),
  'done',(select json_group_array(json_array(assignee,n)) from (select assignee,count(*) n from tasks
     where assignee is not null and status='done' and completed_at > strftime('%s','now')-7*86400 group by 1)));
SQL
done
`;

/** Plain-scalar YAML field, including folded continuation lines. Enough for profile.yaml. */
export function yamlField(text: string, key: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex(line => line.startsWith(`${key}:`));
  if (start < 0) return "";
  const parts = [lines[start]!.slice(key.length + 1).trim()];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break;
    parts.push(line.trim());
  }
  const value = parts.filter(Boolean).join(" ").replace(/^[>|][-+]?\s*/, "");
  return /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;
}

interface FilesRow {
  skills?: [string, string, string][];
  jobs?: { id: string; name: string; schedule: string | null; enabled: number | boolean | null; state: string | null; next: string | null; last: string | null; status: string | null; error: string | null; deliver: string | null; skills: string[] | null; prompt: string | null }[];
  gateway?: { pid: number | null; state: string | null; served: string[]; platforms: Record<string, string> | null } | null;
}
type Triple = [string | null, string | null, number];

export function parseProfiles(sections: Sections): ProfilesSnapshot {
  const ids = [...sections.keys()].filter(key => key.startsWith("profile ")).map(key => key.slice(8));
  const edges = new Map<string, number>();
  const load = new Map<string, Load>();
  const loadOf = (id: string): Load => {
    let entry = load.get(id);
    if (!entry) load.set(id, entry = { running: 0, ready: 0, blocked: 0, todo: 0, review: 0, done7d: 0 });
    return entry;
  };
  for (const [key, text] of sections) {
    if (!key.startsWith("graph ")) continue;
    const graph = json<{ edges?: Triple[]; load?: Triple[]; done?: [string, number][] }>(text, {});
    for (const [from, to, n] of graph.edges ?? []) if (from && to) edges.set(`${from}\u0000${to}`, (edges.get(`${from}\u0000${to}`) ?? 0) + n);
    for (const [who, status, n] of graph.load ?? []) {
      if (!who || !status) continue;
      const entry = loadOf(who);
      if (status === "running" || status === "ready" || status === "blocked" || status === "todo" || status === "review") entry[status] += n;
      else if (status === "triage" || status === "scheduled") entry.todo += n;
    }
    for (const [who, n] of graph.done ?? []) loadOf(who).done7d += n;
  }
  const gateways = new Map<string, Gateway>();
  const files = new Map<string, FilesRow>();
  for (const id of ids) {
    const row = json<FilesRow>(sections.get(`files ${id}`), {});
    files.set(id, row);
    if (row.gateway) gateways.set(id, {
      state: row.gateway.state, alive: sections.get(`alive ${id}`) === "1",
      platforms: row.gateway.platforms ?? {}, served: row.gateway.served ?? [],
    });
  }
  const profiles = ids.map((id): Profile => {
    const row = files.get(id) ?? {};
    const model = sections.get(`model ${id}`) ?? "";
    // A profile without its own live gateway is still reachable when a live gateway serves it.
    const own = gateways.get(id);
    const host = own?.alive ? own : [...gateways.values()].find(g => g.alive && g.served.includes(id)) ?? own ?? null;
    return {
      id,
      description: yamlField(sections.get(`profile ${id}`) ?? "", "description"),
      model: yamlField(model.replace(/^ {2}/gm, ""), "default"),
      provider: yamlField(model.replace(/^ {2}/gm, ""), "provider"),
      skills: (row.skills ?? []).map(([name, category, description]) => ({ name, category: category ?? "other", description: description ?? "" })),
      jobs: (row.jobs ?? []).map(job => ({
        id: job.id, name: job.name || job.id, schedule: job.schedule ?? "", enabled: job.enabled === true || job.enabled === 1,
        state: job.state, next: job.next, last: job.last, status: job.status, error: job.error, deliver: job.deliver,
        skills: job.skills ?? [], prompt: job.prompt ?? "",
      })),
      gateway: host,
      usage: json<Usage | null>(sections.get(`usage ${id}`), null),
      load: load.get(id) ?? loadOf(id),
    };
  });
  const known = new Set(ids);
  return {
    now: Number(sections.get("now") ?? Date.now() / 1000),
    profiles,
    edges: [...edges].map(([key, weight]) => {
      const [from = "", to = ""] = key.split("\u0000");
      return { from, to, weight };
    }).filter(edge => known.has(edge.from) && known.has(edge.to)),
  };
}

export type ProfileDoc = "SOUL.md" | "memories/USER.md" | "memories/MEMORY.md";

function profileDir(id: string): string {
  return id === "default" ? `"$H"` : `"$H/profiles/${safeToken(id)}"`;
}

/* ───────────────────────── Kanban ───────────────────────── */

export const STATUSES = ["triage", "todo", "ready", "running", "blocked", "review", "done"] as const;
export type Status = typeof STATUSES[number] | "scheduled" | "archived";

export interface Task {
  readonly id: string; readonly board: string; readonly title: string; readonly assignee: string | null;
  readonly status: Status; readonly priority: number; readonly createdBy: string | null;
  readonly createdAt: number; readonly startedAt: number | null; readonly completedAt: number | null;
  readonly block: string | null; readonly comments: number; readonly children: number; readonly snippet: string;
}
export interface Board { readonly slug: string; readonly name: string; readonly icon: string; readonly description: string; readonly tasks: readonly Task[] }
export interface TaskDetail {
  readonly body: string; readonly result: string | null;
  readonly comments: readonly { author: string; body: string; at: number }[];
  readonly runs: readonly { profile: string | null; status: string; outcome: string | null; summary: string | null; error: string | null; started: number; ended: number | null }[];
  readonly events: readonly { kind: string; at: number }[];
  readonly parents: readonly string[]; readonly childIds: readonly string[];
}

const BOARDS_SCRIPT = String.raw`
for db in "$H/kanban.db" "$H"/kanban/boards/*/kanban.db; do
  [ -f "$db" ] || continue
  dir=$(dirname "$db"); slug=default; [ "$db" = "$H/kanban.db" ] || slug=$(basename "$dir")
  case "$slug" in _*|*[!A-Za-z0-9_.-]*) continue;; esac
  [ "$slug" = default ] || { S "meta $slug"; cat "$dir/board.json" 2>/dev/null; }
  S "tasks $slug"
  sqlite3 -readonly "$db" <<'SQL'
select json_group_array(json_object('id',id,'title',title,'assignee',assignee,'status',status,'priority',coalesce(priority,0),
  'createdBy',created_by,'createdAt',created_at,'startedAt',started_at,'completedAt',completed_at,'block',block_kind,
  'comments',(select count(*) from task_comments c where c.task_id=t.id),
  'children',(select count(*) from task_links l where l.parent_id=t.id),
  'snippet',substr(replace(coalesce(body,''),char(10),' '),1,200)))
from tasks t where status<>'archived' and (status<>'done' or completed_at > strftime('%s','now')-14*86400);
SQL
done
`;

export function parseBoards(sections: Sections): Board[] {
  const boards: Board[] = [];
  for (const [key, text] of sections) {
    if (!key.startsWith("tasks ")) continue;
    const slug = key.slice(6);
    const meta = json<{ name?: string; icon?: string; description?: string; archived?: boolean }>(sections.get(`meta ${slug}`), {});
    if (meta.archived) continue;
    const tasks = json<Omit<Task, "board">[]>(text, []).map(task => ({ ...task, board: slug }));
    boards.push({ slug, name: meta.name || (slug === "default" ? "Default" : slug), icon: meta.icon ?? "", description: meta.description ?? "", tasks });
  }
  return boards;
}

function boardDb(slug: string): string {
  return slug === "default" ? `"$H/kanban.db"` : `"$H/kanban/boards/${safeToken(slug)}/kanban.db"`;
}

/* ───────────────────────── Client ───────────────────────── */

export type Move = "complete" | "block" | "unblock" | "promote" | "archive";
export type Column = typeof STATUSES[number];

/** Which CLI verb a drop onto `target` means for a task in `from`; null = not a legal drop. */
export function dropMove(from: Status, target: Column): Move | null {
  if (from === target) return null;
  if (target === "done") return "complete";
  if (target === "blocked") return from === "done" ? null : "block";
  if (target === "ready") return from === "blocked" ? "unblock" : from === "todo" || from === "triage" ? "promote" : null;
  return null;
}
export type Outcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** Every read is a deterministic file or sqlite read; every write goes through the `hermes` CLI. */
export class HermesClient {
  constructor(private readonly adapter: SshReadOnlyAdapter) {}

  async profiles(alias: string): Promise<ProfilesSnapshot | string> {
    const result = await runScript(this.adapter, alias, PROFILES_SCRIPT);
    return result.ok ? parseProfiles(result.sections) : result.message;
  }

  async document(alias: string, profile: string, doc: ProfileDoc): Promise<string | null> {
    const result = await runScript(this.adapter, alias, `S doc; cat ${profileDir(profile)}/${doc} 2>/dev/null || exit 0`);
    return result.ok ? result.sections.get("doc") ?? "" : null;
  }

  /** Atomic replace; refused when the file changed since `expected` was read. */
  async saveDocument(alias: string, profile: string, doc: ProfileDoc, expected: string, next: string): Promise<Outcome> {
    const file = `${profileDir(profile)}/${doc}`;
    const script = `f=${file}; cur=$(cat "$f" 2>/dev/null; printf x); want=${b64Arg(expected)}x
[ "$cur" = "$want" ] || { echo "Changed on the server. Reload first." >&2; exit 3; }
mkdir -p "$(dirname "$f")" && printf %s ${b64Arg(next)} > "$f.obsidian.$$" && mv "$f.obsidian.$$" "$f" && S ok`;
    return this.outcome(await runScript(this.adapter, alias, script));
  }

  async boards(alias: string): Promise<Board[] | string> {
    const result = await runScript(this.adapter, alias, BOARDS_SCRIPT);
    return result.ok ? parseBoards(result.sections) : result.message;
  }

  async task(alias: string, board: string, id: string): Promise<TaskDetail | null> {
    const script = `S detail; sqlite3 -readonly ${boardDb(board)} <<'SQL'
select json_object('body',coalesce(body,''),'result',result,
  'comments',(select json_group_array(json_object('author',author,'body',body,'at',created_at)) from (select * from task_comments where task_id=t.id order by created_at)),
  'runs',(select json_group_array(json_object('profile',profile,'status',status,'outcome',outcome,'summary',summary,'error',substr(error,1,600),'started',started_at,'ended',ended_at)) from (select * from task_runs where task_id=t.id order by started_at desc limit 10)),
  'events',(select json_group_array(json_object('kind',kind,'at',created_at)) from (select * from task_events where task_id=t.id order by created_at desc limit 20)),
  'parents',(select json_group_array(parent_id) from task_links where child_id=t.id),
  'childIds',(select json_group_array(child_id) from task_links where parent_id=t.id))
from tasks t where id='${safeToken(id)}';
SQL`;
    const result = await runScript(this.adapter, alias, script);
    return result.ok ? json<TaskDetail | null>(result.sections.get("detail"), null) : null;
  }

  move(alias: string, board: string, id: string, move: Move): Promise<Outcome> {
    const extra = move === "block" ? ` ${b64Arg("Blocked from Obsidian")}` : "";
    return this.kanban(alias, board, `${move} ${safeToken(id)}${extra}`);
  }

  assign(alias: string, board: string, id: string, profile: string | null): Promise<Outcome> {
    return this.kanban(alias, board, `assign ${safeToken(id)} ${profile ? safeToken(profile) : "none"}`);
  }

  comment(alias: string, board: string, id: string, text: string): Promise<Outcome> {
    return this.kanban(alias, board, `comment ${safeToken(id)} ${b64Arg(text)} --author obsidian`);
  }

  create(alias: string, board: string, title: string, assignee: string | null, body: string): Promise<Outcome> {
    const flags = `${assignee ? ` --assignee ${safeToken(assignee)}` : ""}${body ? ` --body ${b64Arg(body)}` : ""}`;
    return this.kanban(alias, board, `create ${b64Arg(title)}${flags} --created-by obsidian`);
  }

  private async kanban(alias: string, board: string, verb: string): Promise<Outcome> {
    const script = `hermes kanban --board ${safeToken(board)} ${verb} </dev/null >/dev/null && S ok`;
    return this.outcome(await runScript(this.adapter, alias, script, 64 * 1024));
  }

  private outcome(result: RemoteResult): Outcome {
    return result.ok && result.sections.has("ok") ? { ok: true } : { ok: false, message: result.ok ? "No confirmation from host" : result.message };
  }
}
