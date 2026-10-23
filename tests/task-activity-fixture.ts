import { testPython } from "./isolated-environment";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { TASK_ACTIVITY_PYTHON } from "../src/domain/task-activity-python";
import { parseActivityReadRequest } from "../src/domain/task-activity-command";
import { parseActivityResponse } from "../src/domain/task-activity-response";
import { ACTIVITY_LIMITS } from "../src/types/task-activity";
import type { ActivityReadInput, ActivityRunner } from "../src/types/task-activity-read";

export const python = testPython();
export const end = 2_000_000_000_000;
export type Seed = { readonly kind?: string; readonly payload?: unknown; readonly stamp?: number | string; readonly creator?: string | null; readonly count?: number; readonly schema?: string };
export function fixture(seed: Seed = {}) {
  const root = mkdtempSync(join(tmpdir(), "activity-"));
  const db = join(root, "kanban.db");
  const input: ActivityReadInput = { connection: "fixture", board: "default", root, end, preset: "all" };
  execFileSync(python, ["-I", "-B", "-c", `
import sqlite3,json,sys
p,s=sys.argv[1],json.loads(sys.argv[2])
c=sqlite3.connect(p)
c.execute('PRAGMA journal_mode=WAL')
c.executescript(s.get('schema','CREATE TABLE tasks(id TEXT PRIMARY KEY,created_by TEXT,assignee TEXT); CREATE TABLE task_events(id INTEGER PRIMARY KEY,task_id TEXT,kind TEXT,payload TEXT,created_at INTEGER);'))
if not s.get('schema'):
 c.execute('INSERT INTO tasks VALUES(?,?,?)',('t_one',s.get('creator','creator'),'current-assignee-must-not-be-used'))
 rows=((i+1,'t_one',s.get('kind','created'),json.dumps(s.get('payload',{'assignee':'initial'})),s.get('stamp',1999999999)) for i in range(s.get('count',1)))
 c.executemany('INSERT INTO task_events VALUES(?,?,?,?,?)',rows)
c.commit()
c.close()
`, db, JSON.stringify(seed)]);
  return { root, db, input, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
export function parsed(input: ActivityReadInput) {
  const result = parseActivityReadRequest(input);
  if (!result.ok) throw new TypeError(result.code);
  return result.value;
}
export function rawSnapshot(input: ActivityReadInput) {
  const request = parsed(input);
  return execFileSync(python, ["-I", "-B", "-c", TASK_ACTIVITY_PYTHON, JSON.stringify({ root: request.root, board: request.board.board, window: request.window, limits: ACTIVITY_LIMITS })], { encoding: "utf8", maxBuffer: ACTIVITY_LIMITS.bytesPerBoard + 4096, timeout: 20_000 });
}
export function runSnapshot(input: ActivityReadInput) { return parseActivityResponse(rawSnapshot(input), parsed(input)); }
export function sql(db: string, statement: string) {
  return execFileSync(python, ["-I", "-B", "-c", "import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);r=c.execute(sys.argv[2]);print(json.dumps(r.fetchall()));c.commit();c.close()", db, statement], { encoding: "utf8" });
}
export function digest(path: string) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

export const localCommandRunner: ActivityRunner = (command, signal) => new Promise((resolve, reject) => {
  const remote = command.args.at(-1);
  if (remote === undefined) throw new TypeError("Missing command");
  const child = spawn("/bin/sh", ["-c", remote], { env: { ...process.env, PATH: `${python.slice(0, python.lastIndexOf("/"))}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  const abort = () => child.kill("SIGKILL");
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (part: Buffer) => { stdout += part.toString(); });
  child.stderr.on("data", (part: Buffer) => { stderr += part.toString(); });
  child.on("error", reject);
  child.on("close", (code) => {
    signal.removeEventListener("abort", abort);
    if (code !== 0 && !signal.aborted) reject(new Error(stderr));
    else resolve(code === 0 ? { ok: true, stdout } : { ok: false, reason: "transport-failure" });
  });
});

export async function concurrentSnapshot(input: ActivityReadInput, db: string, waitForDeadline = false) {
  const request = parsed(input);
  const wrapper = `
import sqlite3,sys,json
real_connect=sqlite3.connect
class SnapshotConnection:
 def __init__(self,*args,**kwargs): self.conn=real_connect(*args,**kwargs)
 def __getattr__(self,key): return getattr(self.conn,key)
 def execute(self,query,*args):
  cursor=self.conn.execute(query,*args)
  if query=='SELECT MAX(id) FROM task_events':
   print('SNAPSHOT_READY',flush=True)
   if sys.stdin.readline().strip()!='CONTINUE': raise RuntimeError('rendezvous failed')
  return cursor
sqlite3.connect=SnapshotConnection
`;
  return await new Promise<ReturnType<typeof parseActivityResponse>>((resolve, reject) => {
    const child = spawn(python, ["-I", "-B", "-c", wrapper + TASK_ACTIVITY_PYTHON, JSON.stringify({ root: request.root, board: request.board.board, window: request.window, limits: ACTIVITY_LIMITS })]);
    let output = "";
    let stderr = "";
    let released = false;
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Rendezvous timeout")); }, waitForDeadline ? 18_000 : 5000);
    child.stdout.on("data", (part: Buffer) => {
      output += part.toString();
      if (!released && output.includes("SNAPSHOT_READY\n")) {
        released = true;
        if (!waitForDeadline) {
          sql(db, "UPDATE tasks SET created_by='later-creator'");
          sql(db, "INSERT INTO task_events VALUES(2,'t_one','created','{\"assignee\":\"later-assignee\"}',1999999999)");
          child.stdin.end("CONTINUE\n");
        }
      }
    });
    child.stderr.on("data", (part: Buffer) => { stderr += part.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !released) reject(new Error(stderr || "No rendezvous"));
      else resolve(parseActivityResponse(output.replace("SNAPSHOT_READY\n", ""), request));
    });
  });
}

export function namedBoard(root: string, name: string) {
  const path = join(root, "kanban", "boards", name);
  mkdirSync(path, { recursive: true });
  return path;
}
