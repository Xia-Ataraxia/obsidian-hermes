import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fixtureSession } from "./control-center-fixture";
import { CONTROL_CENTER_PYTHON, fixtureProcess } from "./control-center-runtime";
import { FixtureRefusal, isRecord, ownedPath, verifyHost } from "./fixture-guard";

const identity = verifyHost();
const root = ownedPath(process.argv[2] ?? "");
const taskId = process.argv[3] ?? "";
if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new FixtureRefusal("explicit task id required");
const lifecycle: unknown = JSON.parse(readFileSync(resolve(root, "lifecycle.json"), "utf8"));
if (!isRecord(lifecycle) || lifecycle.owner !== "task20_fixture" || lifecycle.root !== root || typeof lifecycle.origin !== "string") throw new FixtureRefusal("owned lifecycle required");
const session = await fixtureSession(lifecycle.origin);
const route = `/api/plugins/kanban/tasks/${taskId}?profile=default&board=default`;
const response = await fetch(lifecycle.origin + route, { headers: session.headers, signal: AbortSignal.timeout(5000) });
const apiBody = await response.text();
const program = String.raw`
import json, pathlib, re, sqlite3, sys
root = pathlib.Path(sys.argv[1])
task_id = sys.argv[2]
path = root / 'home/kanban.db'
db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row
db.execute('PRAGMA query_only=ON')
tables = {}
for item in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
    name = item[0]
    if not re.fullmatch('[a-z_]+', name):
        continue
    columns = [row['name'] for row in db.execute('PRAGMA table_info("' + name + '")')]
    keys = [column for column in columns if column in ('task_id', 'parent_id', 'child_id') or name == 'tasks' and column == 'id']
    if keys:
        where = ' OR '.join('"' + column + '"=?' for column in keys)
        rows = [dict(row) for row in db.execute('SELECT * FROM "' + name + '" WHERE ' + where, [task_id] * len(keys))]
        tables[name] = dict(columns=columns, rows=rows)
print(json.dumps(dict(databasePath=str(path), queryOnly=bool(db.execute('PRAGMA query_only').fetchone()[0]), tables=tables)))
db.close()
`;
const db = await fixtureProcess(CONTROL_CENTER_PYTHON, ["-I", "-B", "-c", program, root, taskId], { root, timeoutMs: 5000, maxBytes: 2_097_152 });
if (db.exitCode !== 0 || db.capExceeded) throw new FixtureRefusal(`read-only database query failed: ${db.stderr}`);
const database: unknown = JSON.parse(db.stdout);
const api: unknown = JSON.parse(apiBody);
if (!isRecord(api) || !isRecord(api.task) || !Array.isArray(api.comments) || !Array.isArray(api.events) || !isRecord(api.links) || !isRecord(database) || !isRecord(database.tables)) throw new FixtureRefusal("native readback shape rejected");
const table = database.tables.tasks;
const row = isRecord(table) && Array.isArray(table.rows) ? table.rows[0] : null;
if (!isRecord(row)) throw new FixtureRefusal("native database task absent");
const events = api.events.filter(isRecord);
const lastOverride = events.filter(event => event.kind === "model_override_set").at(-1);
const taskChecks = {
  title: api.task.title === "Task20 edited title" && row.title === api.task.title,
  body: typeof api.task.body === "string" && api.task.body.includes("Task20 body saved from installed native editor") && row.body === api.task.body,
  comment: api.comments.length === 1 && isRecord(api.comments[0]) && api.comments[0].body === "Task20 comment from actual keyboard",
  parent: Array.isArray(api.links.parents) && api.links.parents.includes("repeat-001"),
  dependencyWait: api.task.status === "todo" && row.status === "todo" && events.some(event => event.kind === "dependency_wait" && isRecord(event.payload) && event.payload.parent === "repeat-001"),
  unassigned: api.task.assignee === null && row.assignee === null && events.some(event => event.kind === "assigned" && isRecord(event.payload) && event.payload.assignee === null && event.payload.from === "xia"),
  modelCleared: api.task.model_override === null && row.model_override === null && api.task.provider_override === null && row.provider_override === null && lastOverride !== undefined && isRecord(lastOverride.payload) && lastOverride.payload.model === null && lastOverride.payload.provider === null,
};
const journal = readFileSync(resolve(root, "mutations.ndjson"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as unknown).filter(isRecord).filter(entry => entry.route === `/api/plugins/kanban/tasks/${taskId}`);
const refusedDragAt = Date.parse("2026-10-22T16:31:22Z");
const checks = taskId === "running-001" ? {
  readyAfterAllowedTransition: api.task.status === "ready" && row.status === "ready",
  allowedReclaimEvent: events.some(event => event.kind === "status" && isRecord(event.payload) && event.payload.status === "ready" && event.created_at === 1792686614),
  noNativeRequestAfterRefusedDrag: journal.every(entry => typeof entry.time === "number" && entry.time < refusedDragAt),
  noEventAfterRefusedDrag: events.every(event => typeof event.created_at === "number" && event.created_at < refusedDragAt / 1000),
} : taskChecks;
const soulPath = resolve(root, "home/profiles/xia/SOUL.md");
const soul = readFileSync(soulPath);
const assets = await Promise.all(["/reference", "/reference/upstream.js", "/reference/sdk.js", "/reference/primitives.mjs", "/reference/styles.css"].map(async path => {
  const asset = await fetch(lifecycle.origin + path, { signal: AbortSignal.timeout(5000) });
  const bytes = Buffer.from(await asset.arrayBuffer());
  return { path, status: asset.status, contentType: asset.headers.get("content-type"), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}));
const receipt = { readOnly: true, capturedAt: new Date().toISOString(), identity, lifecycle, taskId, checks, pass: Object.values(checks).every(Boolean), api: { route, status: response.status, body: api }, database, mutationJournal: journal, journalResponseBody: "not recorded by structural fixture journal; no replay performed", soul: { path: soulPath, bytes: soul.length, sha256: createHash("sha256").update(soul).digest("hex"), body: soul.toString("utf8") }, referenceAssets: assets };
writeFileSync(resolve(root, taskId === "running-001" ? "ui-running-readback.json" : "ui-native-readback.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
if (!receipt.pass || !response.ok || assets.some(asset => asset.status !== 200)) throw new FixtureRefusal("native readback verification failed");
