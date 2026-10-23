import type { SshReadOnlyAdapter } from "../ui/ssh-read-only-adapter";
import { json, runScript, safeToken, type Sections } from "./remote";

/* ───────────────────────── Activity ───────────────────────── */

/** Times are epoch seconds on the host clock; compare them with `Activity.at`, never with the local clock. */
export interface Session {
  readonly id: string; readonly source: string | null; readonly title: string | null; readonly model: string | null;
  readonly started: number; readonly last: number; readonly doing: string | null;
  /** Holds an unexpired turn lease, so the agent is working right now. */
  readonly turn: boolean; readonly parent: string | null; readonly child: boolean;
}
export interface Subagent {
  readonly id: string; readonly label: string | null; readonly goal: string | null;
  /** `stale`: still open but quiet for 5 minutes (a crash reads as running until then). */
  readonly status: "ended" | "running" | "stale"; readonly end: string | null; readonly model: string | null;
  readonly started: number; readonly secs: number; readonly calls: number | null;
  readonly input: number | null; readonly output: number | null; readonly cached: number;
  readonly cost: number | null; readonly costStatus: string | null;
  readonly doing: string | null; readonly result: string | null;
}
export interface Delegation {
  readonly id: string | null; readonly title: string | null; readonly source: string | null;
  readonly children: readonly Subagent[];
}
export interface AsyncJob {
  readonly state: string; readonly delivery: string | null;
  readonly dispatched: number; readonly completed: number | null; readonly tasks: number | null; readonly goal: string | null;
}
export interface Recent {
  readonly source: string | null; readonly title: string | null; readonly model: string | null;
  readonly last: number; readonly msgs: number; readonly cost: number | null; readonly costStatus: string | null; readonly kids: number;
}
export interface LiveLog { readonly goal: string | null; readonly tail: string | null }
export interface Activity {
  readonly at: number;
  readonly now: readonly Session[]; readonly delegations: readonly Delegation[]; readonly async: readonly AsyncJob[];
  readonly recent: readonly Recent[]; readonly live: readonly LiveLog[];
}
export interface Task {
  readonly goal: string | null; readonly status: string;
  /** Absent while the call is still running or its result was lost. */
  readonly exit?: string | null; readonly error?: string | null; readonly summary?: string | null;
}
/** A refused spawn has no tasks, only its `error`. */
export interface Call { readonly at: number | null; readonly error: string | null; readonly tasks: readonly Task[] }

/*
 * One round trip. state.db is large, so every sub-select keeps its LIMIT: 40 subagents over 7 days, 10 background
 * calls, 15 recent sessions, 8 live logs. Hermes redacts the live logs; a log written in the last 300 s is a running
 * subagent. ponytail: a host on an older schema (no async_delegations or session_turn_leases) fails the whole query
 * and reads as an error; add per-table fallbacks if such a host shows up.
 */
const delegateFrom = (column: string): string =>
  `case when json_valid(${column}) then json_extract(${column}, '$._delegate_from') end`;

const ACTIVITY_SQL = `with lease(id) as (
  select conversation_id from session_turn_leases where expires_at > strftime('%s','now') limit 50),
live(id) as (
  select id from lease
  union select id from sessions
  where coalesce(last_activity_at, started_at) > strftime('%s','now') - 300 and ended_at is null),
kid as (
  select id, parent_session_id parent, title, model, started_at, ended_at, end_reason, last_activity_description,
    api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd, cost_status
  from sessions
  where started_at > strftime('%s','now') - 7*86400 and ${delegateFrom("model_config")} is not null
  order by started_at desc limit 40)
select json_object(
  'at', strftime('%s','now') + 0,
  'now', (select json_group_array(json_object('id', s.id, 'source', s.source, 'title', s.title, 'model', s.model,
      'started', s.started_at, 'last', coalesce(s.last_activity_at, s.started_at),
      'doing', substr(nullif(s.last_activity_description, ''), 1, 200), 'turn', s.id in (select id from lease),
      'parent', s.parent_session_id, 'child', ${delegateFrom("s.model_config")} is not null))
    from sessions s where s.id in (select id from live) and s.ended_at is null),
  'delegations', (select json_group_array(json_object('id', g.parent, 'title', p.title, 'source', p.source,
      'children', json((select json_group_array(json_object('id', k.id,
          'label', case when k.title like 'Subagent: %' then substr(k.title, 11) end,
          'goal', (select substr(content, 1, 200) from messages where session_id = k.id and role = 'user' order by id limit 1),
          'status', case when k.ended_at is not null then 'ended' when k.id in (select id from live) then 'running' else 'stale' end,
          'end', k.end_reason, 'model', k.model, 'started', k.started_at,
          'secs', round(coalesce(k.ended_at, strftime('%s','now')) - k.started_at),
          -- input + cached = the tokens.input that Hermes reports in the delegate_task result
          'calls', k.api_call_count, 'input', k.input_tokens, 'output', k.output_tokens,
          'cached', coalesce(k.cache_read_tokens, 0) + coalesce(k.cache_write_tokens, 0),
          'cost', k.estimated_cost_usd, 'costStatus', k.cost_status,
          'doing', case when k.ended_at is null then substr(nullif(k.last_activity_description, ''), 1, 200) end,
          'result', (select substr(content, 1, 200) from messages where session_id = k.id and role = 'assistant'
                     and content <> '' order by id desc limit 1)))
        from (select * from kid where parent is g.parent order by started_at) k))))
    from (select parent, max(started_at) latest from kid group by parent order by latest desc) g
    left join sessions p on p.id = g.parent),
  'async', (select json_group_array(json_object('state', state, 'delivery', delivery_state,
      'dispatched', dispatched_at, 'completed', completed_at,
      'tasks', json_array_length(task_json, '$.goals'), 'goal', substr(json_extract(task_json, '$.goal'), 1, 200)))
    from (select state, delivery_state, dispatched_at, completed_at,
            case when json_valid(task_json) then task_json end task_json
          from async_delegations order by dispatched_at desc limit 10)),
  'recent', (select json_group_array(json_object('source', r.source, 'title', r.title, 'model', r.model,
      'last', coalesce(r.last_activity_at, r.started_at),
      'msgs', r.message_count, 'cost', r.estimated_cost_usd, 'costStatus', r.cost_status,
      'kids', (select count(*) from sessions c where c.parent_session_id = r.id
               and ${delegateFrom("c.model_config")} is not null)))
    from (select id, source, title, model, started_at, last_activity_at, message_count,
            estimated_cost_usd, cost_status
          from sessions
          where coalesce(hidden, 0) = 0 and coalesce(archived, 0) = 0 and source <> 'tool'
            and ${delegateFrom("model_config")} is null
          order by coalesce(last_activity_at, started_at) desc, started_at desc limit 15) r));`;

const LIVE_SQL = `select json_group_array(json_object(
  'goal', case when instr(t, char(10) || 'goal: ') > 0 then (select substr(g, 1, min(200, instr(g || char(10), char(10)) - 1))
          from (select substr(t, instr(t, char(10) || 'goal: ') + 7, 1000) g)) end,
  'tail', (select substr(x, instr(x, char(10)) + 1) from (select substr(t, -700) x))))
from (select cast(data as text) t from fsdir('cache/delegation/live')
      where name like '%/task-%.log' and mtime > strftime('%s','now') - 300 order by mtime desc limit 8);`;

/*
 * The newest 5 delegate_task calls of one parent session (:sid), as one JSON array. Sync calls hold their results in
 * the tool row; background calls hold a dispatch ack there and their results in async_delegations. Transcripts repeat
 * a tool_call_id and keep non-JSON compression stubs, so rows are deduped per call and only valid JSON reaches json_*.
 * list/steer/stop calls carry an "action" key and are skipped. ponytail: a refused spawn keeps its {"error"} with no
 * tasks (its goals are only in the call args), and a failed steer/stop reads the same way.
 */
const DETAIL_SQL = `with t as (
  select tool_call_id, max(id) id, timestamp, content from messages
  where session_id = :sid and role = 'tool' and tool_name = 'delegate_task' and json_valid(content)
    and json_extract(content, '$.action') is null
  group by tool_call_id order by id desc limit 5),
c as (
  select json_extract(tc.value, '$.id') call, max(json_extract(tc.value, '$.function.arguments')) args
  from (select tool_calls from messages where session_id = :sid and role = 'assistant'
        and tool_calls like '%delegate_task%' and json_valid(tool_calls) order by id desc limit 50) m,
    json_each(m.tool_calls) tc
  where json_extract(tc.value, '$.function.name') = 'delegate_task'
  group by call),
x as (
  select t.id, t.timestamp, t.content, c.args, a.state,
    coalesce(case when json_valid(a.result_json) then a.result_json end, t.content) res
  from t left join c on c.call = t.tool_call_id
  left join async_delegations a on a.delegation_id = json_extract(t.content, '$.delegation_id'))
select json_group_array(json_object(
  'at', x.timestamp, 'error', substr(json_extract(x.content, '$.error'), 1, 200),
  'tasks', json(case when json_type(x.res, '$.results') = 'array' then (
      select json_group_array(json_object(
        'goal', substr(coalesce(
          case when json_valid(x.args) then json_extract(x.args, '$.tasks[' || json_extract(r.value, '$.task_index') || '].goal') end,
          json_extract(x.content, '$.goals[' || json_extract(r.value, '$.task_index') || ']'),
          case when json_valid(x.args) then json_extract(x.args, '$.goal') end), 1, 200),
        'status', json_extract(r.value, '$.status'), 'exit', json_extract(r.value, '$.exit_reason'),
        'error', substr(json_extract(r.value, '$.error'), 1, 200),
        'summary', substr(json_extract(r.value, '$.summary'), 1, 200)))
      from json_each(x.res, '$.results') r)
    else (
      -- no results yet (running) or lost (state unknown): list the ack's goals with the delegation state
      select json_group_array(json_object('goal', substr(g.value, 1, 200), 'status', coalesce(x.state, 'unknown')))
      from json_each(x.content, '$.goals') g) end)))
from (select * from x order by id desc) x;`;

// merge: profileDir (same as data.ts; drop this copy once that one is exported)
function dir(id: string): string {
  return id === "default" ? `"$H"` : `"$H/profiles/${safeToken(id)}"`;
}

/** No state.db means no output and exit 0; a failed query prints `null` so that it reads as an error. */
export function activityScript(profile: string): string {
  return `cd ${dir(profile)} 2>/dev/null && [ -f state.db ] || exit 0
S activity
ro state.db <<'SQL' || echo null
${ACTIVITY_SQL}
SQL
S live
if [ -d cache/delegation/live ]; then ro state.db <<'SQL' || printf '[]'
${LIVE_SQL}
SQL
fi`;
}

/** Hermes ids carry colons and run past safeToken's 64 characters (local-<64 hex>). */
const SID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** The id is quoted into the SQL, so it must pass SID first. */
export function detailScript(profile: string, sid: string): string {
  if (!SID.test(sid)) throw new Error(`Unsafe session id: ${sid}`);
  return `cd ${dir(profile)} 2>/dev/null && [ -f state.db ] || exit 0
S detail
ro state.db <<'SQL' || echo null
${DETAIL_SQL.replaceAll(":sid", `'${sid}'`)}
SQL`;
}

const EMPTY: Activity = { at: 0, now: [], delegations: [], async: [], recent: [], live: [] };
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/** `null`: the query failed or answered with something else. A profile without state.db has no activity. */
export function parseActivity(sections: Sections): Activity | null {
  const text = sections.get("activity");
  if (text === undefined) return EMPTY;
  const raw = json<Record<string, unknown> | null>(text, null);
  if (typeof raw?.at !== "number") return null;
  return {
    at: raw.at,
    // SQLite has no booleans: these two arrive as 0 and 1.
    now: list<Session>(raw.now).map(s => ({ ...s, turn: Boolean(s.turn), child: Boolean(s.child) })),
    delegations: list<Delegation>(raw.delegations),
    async: list<AsyncJob>(raw.async),
    recent: list<Recent>(raw.recent),
    live: list<LiveLog>(json<unknown>(sections.get("live"), [])),
  };
}

/** `null`: the query failed or answered with something else. A profile without state.db has no calls. */
export function parseDetail(sections: Sections): Call[] | null {
  const text = sections.get("detail");
  if (text === undefined) return [];
  const raw = json<unknown>(text, null);
  return Array.isArray(raw)
    ? list<Call>(raw).map(c => ({ ...c, tasks: list<Task>(c.tasks).map(t => ({ ...t, status: t.status || "unknown" })) }))
    : null;
}

const norm = (s: string | null) => (s ?? "").trim().replace(/\s+/g, " ");
/** A child's first message starts with its task goal, and a live log header keeps the goal's first line. */
export const same = (goal: string | null, other: string | null) => {
  const head = norm(goal).slice(0, 60);
  return head !== "" && norm(other).startsWith(head);
};

/** Siblings can share an opening, so a goal names a task or a live log only when exactly one fits. */
export const only = <T>(items: readonly T[], fits: (item: T) => boolean): T | undefined => {
  const hits = items.filter(fits);
  return hits.length === 1 ? hits[0] : undefined;
};

/** The task a child's goal belongs to: the whole task goal opens the child's. ponytail: a goal repeated across calls gives no outcome; match on time if that shows up. */
export const taskOf = (calls: readonly Call[], goal: string | null): Task | undefined =>
  only(calls.flatMap(c => c.tasks), t => same(t.goal, goal) && norm(goal).startsWith(norm(t.goal)));

export class ActivityClient {
  constructor(private readonly adapter: SshReadOnlyAdapter) {}

  async read(alias: string, profile: string): Promise<Activity | string> {
    const result = await runScript(this.adapter, alias, activityScript(profile));
    return result.ok ? parseActivity(result.sections) ?? "Couldn't read activity" : result.message;
  }

  /** The newest delegate_task calls of one parent session: 1 SSH run, read when its group first opens. */
  async detail(alias: string, profile: string, sid: string): Promise<Call[] | string> {
    const result = await runScript(this.adapter, alias, detailScript(profile, sid));
    return result.ok ? parseDetail(result.sections) ?? "Couldn't read outcomes" : result.message;
  }
}
