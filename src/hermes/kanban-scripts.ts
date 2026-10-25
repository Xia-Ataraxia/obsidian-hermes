/** The POSIX sh scripts the kanban client runs on the host (sqlite3 read-only through the PRELUDE `ro`). */
import { b64Arg, safeToken } from "./remote";

/** Hermes's own cap (KANBAN_ATTACHMENT_MAX_BYTES), for uploads and downloads alike. */
export const MAX_ATTACHMENT = 25 * 1024 * 1024;
export const dbPath = (slug: string): string => slug === "default" ? `"$H/kanban.db"` : `"$H/kanban/boards/${safeToken(slug)}/kanban.db"`;
/** Stops a script on a board without a db, with a plain message. sqlite3 reads need it, and so does `boards create`
 *  (settings reuse it), which revives an archived board; the CLI itself refuses to recreate a named board's db. */
export const live = (slug: string): string => `[ -f ${dbPath(slug)} ] || { echo "Board '${safeToken(slug)}' has no database" >&2; exit 1; }\n`;
/** Hermes's attachments_root() for an explicit --board; a host-side HERMES_KANBAN_ATTACHMENTS_ROOT pin is not seen, so downloads there are refused. */
export const attachRoot = (slug: string): string => slug === "default" ? `"$H/kanban/attachments"` : `"$H/kanban/boards/${safeToken(slug)}/attachments"`;
/** The board dirs that both board loops (LIST, EVENTS) skip, as one shell case pattern. */
export const SKIP_BOARDS = "_*|-*|default|*[!A-Za-z0-9_.-]*";

/** Board list with per-status counts, assignable profiles and the config's kanban block. */
export const LIST = String.raw`counts() { ro "$1" <<'SQL'
select json_group_object(status,n) from (select status,count(*) n from tasks group by status);
SQL
}
S "meta default"; cat "$H/kanban/boards/default/board.json" 2>/dev/null
[ -f "$H/kanban.db" ] && { S "counts default"; counts "$H/kanban.db"; }
for d in "$H"/kanban/boards/*/; do
  s=$(basename "$d")
  case "$s" in ${SKIP_BOARDS}) continue;; esac
  [ -f "$d/board.json" ] || [ -f "$d/kanban.db" ] || continue
  S "meta $s"; cat "$d/board.json" 2>/dev/null
  [ -f "$d/kanban.db" ] && { S "counts $s"; counts "$d/kanban.db"; }
done
S profiles; for d in "$H"/profiles/*/; do s=$(basename "$d"); [ "$s" != default ] && [ -f "$d/config.yaml" ] && echo "$s"; done
S config; awk '/^kanban:/{f=1;next} f&&/^[^ #]/{exit} f' "$H/config.yaml" 2>/dev/null | grep -E '^ +(lane_by_profile|auto_decompose|orchestrator_profile|default_assignee):' || true`;

// ponytail: token = newest event id + task count. Heartbeat and claim changes append events, so they move it; respawn_guarded
// (the dispatcher's note, about one a minute while a card is parked) is skipped. `kind` has no index, but the walk back from the
// newest id stops at the first other event. The walk is bounded to the last 5000 ids: a longer run of respawn_guarded rows reads as
// token 0 until another event lands. A write that appends no event (workspace path, branch) waits for the next event or a forced read.
export const TOKEN = "select coalesce((select id from task_events where kind<>'respawn_guarded' and id>(select max(id) from task_events)-5000 order by id desc limit 1),0)||'.'||(select count(*) from tasks);";
/** A poll tick's probe: the board's token alone. A board without a db prints none, so the full read runs (and falls back). */
export const probeScript = (slug: string): string => String.raw`db=${dbPath(slug)}; [ -f "$db" ] || exit 0
S token; ro "$db" <<'SQL'
${TOKEN}
SQL`;
/** Live mode (watch): one token line per stdin line, empty when the read failed; stdin's EOF ends the loop.
 *  A fresh `ro` per line, not one long sqlite3: an immutable connection (ro's fallback) never sees later writes.
 *  ponytail: an abrupt network loss leaves the sh idle in `read`, holding no db handle, until sshd drops the dead link (TCP
 *  keepalive, about 2 h); set ClientAliveInterval on the host if idle shells pile up. */
export const watchScript = (slug: string): string => String.raw`db=${dbPath(slug)}; [ -f "$db" ] || exit 0
while read -r t; do ro "$db" <<'SQL' || echo
${TOKEN}
SQL
done`;

export function boardScript(slug: string, last: string | null, archived: boolean): string {
  return String.raw`${LIST}
db=${dbPath(slug)}; b=${safeToken(slug)}; last=${b64Arg(last ?? "")}
[ -f "$db" ] || { db="$H/kanban.db"; b=default; last=; }
S board; echo "$b"
if [ -f "$db" ]; then
tok=$(ro "$db" <<'SQL'
${TOKEN}
SQL
) || exit 1
S token; echo "$tok"
[ "$tok" = "$last" ] || { S tasks; ro "$db" <<'SQL' || exit 1
with sm as (select task_id, summary from (select task_id, summary, row_number() over (partition by task_id order by coalesce(ended_at,started_at) desc, id desc) rn
              from task_runs where summary is not null and summary<>'') where rn=1),
  kids as (select l.parent_id id, count(*) total, sum(c.status='done') done from task_links l join tasks c on c.id=l.child_id group by l.parent_id),
  ups as (select l.child_id id, count(*) n, sum(p.status not in ('done','archived')) open from task_links l left join tasks p on p.id=l.parent_id group by l.child_id),
  cm as (select task_id id, count(*) n from task_comments group by task_id)
select json_group_array(json_patch('{}',json_object(
  'id',t.id,'title',t.title,'assignee',t.assignee,'status',t.status,'priority',t.priority,'tenant',t.tenant,
  'createdAt',t.created_at,'startedAt',coalesce(r.started_at,t.started_at),'completedAt',t.completed_at,
  'blockKind',t.block_kind,'blockRecurrences',nullif(t.block_recurrences,0),'failures',nullif(t.consecutive_failures,0),
  'lastError',substr(t.last_failure_error,1,120),'heartbeatAt',t.last_heartbeat_at,'maxRuntime',t.max_runtime_seconds,
  'pid',t.worker_pid,'claimExpires',t.claim_expires,
  'comments',nullif(cm.n,0),'parents',nullif(ups.n,0),'openParents',nullif(ups.open,0),'children',kids.total,'childrenDone',kids.done,
  'text',nullif(trim(substr(coalesce(t.body,''),1,150)||' '||substr(coalesce(t.result,''),1,75)||' '||substr(coalesce(sm.summary,''),1,75)),''),
  'reason',case when t.status in ('blocked','triage') then (select case when json_valid(e.payload) then substr(coalesce(json_extract(e.payload,'$.reason'),json_extract(e.payload,'$.error')),1,200) end
     from task_events e where e.task_id=t.id and e.kind in ('blocked','block_loop_detected','gave_up','timed_out','crashed') order by e.id desc limit 1) end)))
from tasks t left join task_runs r on r.id=t.current_run_id left join sm on sm.task_id=t.id left join kids on kids.id=t.id
  left join ups on ups.id=t.id left join cm on cm.id=t.id
where t.status<>'archived' or ${archived ? 1 : 0};
SQL
}
fi
S end`;
}

// ponytail: the log is the last 100 KB only; page backwards if long runs need more
export function detailScript(slug: string, id: string): string {
  const tid = `'${safeToken(id)}'`;
  const log = slug === "default" ? `"$H/kanban/logs/${safeToken(id)}.log"` : `"$H/kanban/boards/${safeToken(slug)}/logs/${safeToken(id)}.log"`;
  return String.raw`${live(slug)}S detail; ro ${dbPath(slug)} <<'SQL' || exit 1
select json_patch('{}',json_object(
 'task',json((select json_patch('{}',json_object('id',id,'title',title,'body',body,'assignee',assignee,'status',status,'priority',priority,'tenant',tenant,
   'workspaceKind',workspace_kind,'workspacePath',workspace_path,'branch',branch_name,'project',project_id,
   'skills',case when json_valid(skills) then json(skills) end,'model',model_override,'provider',provider_override,
   'reasoning',reasoning_effort,'goalMode',goal_mode,'goalMaxTurns',goal_max_turns,'createdBy',created_by,'createdAt',created_at,'startedAt',started_at,'completedAt',completed_at,
   'result',result,'blockKind',block_kind,'blockRecurrences',block_recurrences,'failures',consecutive_failures,'lastError',last_failure_error,
   'claimLock',claim_lock,'claimExpires',claim_expires,'pid',worker_pid,'heartbeatAt',last_heartbeat_at,'runId',current_run_id,
   'maxRuntime',max_runtime_seconds,'maxRetries',max_retries,'contract',completion_contract,'idempotencyKey',idempotency_key)) from tasks where id=${tid})),
 'parents',json((select json_group_array(json_object('id',t.id,'title',t.title,'status',t.status)) from task_links l join tasks t on t.id=l.parent_id where l.child_id=${tid})),
 'children',json((select json_group_array(json_patch('{}',json_object('id',t.id,'title',t.title,'status',t.status,'result',substr(t.result,1,600),'summary',
   (select substr(summary,1,600) from task_runs r where r.task_id=t.id and summary<>'' order by coalesce(ended_at,started_at) desc, id desc limit 1))))
   from task_links l join tasks t on t.id=l.child_id where l.parent_id=${tid})),
 'comments',json((select json_group_array(json_patch('{}',json_object('id',id,'author',author,'body',body,'at',created_at))) from (select * from task_comments where task_id=${tid} order by created_at,id))),
 'eventCount',(select count(*) from task_events where task_id=${tid}),
 'events',json((select json_group_array(json_patch('{}',json_object('id',id,'kind',kind,'payload',case when json_valid(payload) then json(payload) end,'at',created_at)))
   from (select * from task_events where task_id=${tid} order by id desc limit 20))),
 'runs',json((select json_group_array(json_patch('{}',json_object('id',id,'profile',profile,'status',status,'outcome',outcome,'summary',summary,'error',substr(error,1,600),
   'metadata',case when json_valid(metadata) then json(metadata) end,'startedAt',started_at,'endedAt',ended_at))) from (select * from task_runs where task_id=${tid} order by started_at,id))),
 'attachments',json((select json_group_array(json_patch('{}',json_object('id',id,'name',filename,'size',size,'type',content_type,'by',uploaded_by,'at',created_at,'path',stored_path))) from task_attachments where task_id=${tid}))));
SQL
S aroot; (cd -P ${attachRoot(slug)} 2>/dev/null && pwd -P) || :
f=${log}; [ -f "$f" ] && { S log; wc -c < "$f"; tail -c 100000 "$f" | tr -d '\036'; }
S end`;
}

// ponytail: 50 newest stuck events per board per tick; older ones in a burst are skipped
export const EVENTS = String.raw`ev() { c=$(cur "$1"); [ -f "$2" ] || return 0; [ -f "$3" ] && { S "meta $1"; cat "$3"; }; S "events $1"; ro "$2" <<SQL
select json_object('max',coalesce((select max(id) from task_events),0),'rows',json((select json_group_array(json_patch('{}',json_object('id',e.id,'task',e.task_id,'title',t.title,'kind',e.kind,
  'reason',case when json_valid(e.payload) then substr(coalesce(json_extract(e.payload,'\$.reason'),json_extract(e.payload,'\$.error')),1,200) end)))
  from (select * from task_events where $c >= 0 and id > $c and kind in ('blocked','block_loop_detected','gave_up','crashed','timed_out') order by id desc limit 50) e left join tasks t on t.id=e.task_id)));
SQL
}
ev default "$H/kanban.db" "$H/kanban/boards/default/board.json"
for d in "$H"/kanban/boards/*/; do s=$(basename "$d"); case "$s" in ${SKIP_BOARDS}) continue;; esac; ev "$s" "$d/kanban.db" "$d/board.json"; done
S end`;

/** Unknown boards get cursor -1: the first read only seeds `max`. */
export function eventsScript(cursors: Record<string, number>): string {
  const arms = Object.entries(cursors).flatMap(([slug, n]) => {
    try { return Number.isSafeInteger(n) && n >= 0 ? [`${safeToken(slug)}) echo ${n};;`] : []; } catch { return []; }
  });
  return `cur() { case "$1" in ${arms.join(" ")} *) echo -1;; esac; }\n${EVENTS}`;
}

/** `hc <path>`: each platform object at that JSON path of stdin (a `config get --json` dump) that has a home_channel, as
 *  {platform: {chat_id, thread_id, name}}; a home_channel that is not a mapping maps to null, which drops an earlier one. */
export const HC = String.raw`hc() { sqlite3 :memory: -cmd '.mode ascii' -cmd 'create table t(j)' -cmd '.import /dev/stdin t' -cmd '.mode list' "select json_group_object(key, case when json_type(value,'\$.home_channel')='object' then json_object('chat_id',cast(json_extract(value,'\$.home_channel.chat_id') as text),'thread_id',cast(json_extract(value,'\$.home_channel.thread_id') as text),'name',json_extract(value,'\$.home_channel.name')) end) from t, json_each(t.j,'$1') where key<>'platforms' and case when type='object' then json_type(value,'\$.home_channel') end is not null" 2>/dev/null; }
`;
