import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ActivityClient, activityScript, detailScript, only, parseActivity, parseDetail, same, taskOf, type Call } from "../src/hermes/activity";
import { parseSections } from "../src/hermes/remote";

const dump = (...parts: string[]) => parseSections(parts.map(part => `\u001e${part}`).join("\n"));
const adapter = (exitCode: number, stdout: string, stderr = "") =>
  ({ run: async () => ({ transport: "connected", exitCode, stdout, stderr, capExceeded: false }) }) as never;

test("the script reads one profile directory and a failed read is told apart from a missing database", async () => {
  expect(activityScript("default")).toContain('cd "$H" ');
  expect(activityScript("ops")).toContain('cd "$H/profiles/ops" ');
  expect(() => activityScript("../x")).toThrow();
  expect(parseActivity(dump())).toMatchObject({ at: 0, now: [], recent: [] });
  expect([parseActivity(dump("activity\nnull")), parseActivity(dump("activity\n{oops"))]).toEqual([null, null]);
  const read = (exitCode: number, stdout: string, stderr = "") => new ActivityClient(adapter(exitCode, stdout, stderr)).read("h", "ops");
  expect(await read(0, "\u001eactivity\n{\"at\":5}\n\u001elive\n[]")).toMatchObject({ at: 5, now: [], live: [] });
  expect(await read(1, "", "boom")).toBe("boom");
  expect(await read(0, "\u001eactivity\nnull")).toBe("Couldn't read activity");
  expect(await new ActivityClient(adapter(0, "")).read("h", "../x").catch((e: unknown) => e)).toBeInstanceOf(Error);
});

test("the queries answer in the shape the parsers expect, and a task finds its child by goal", async () => {
  const t = Math.floor(Date.now() / 1000);
  const db = new Database(":memory:");
  // Column types as in Hermes: the REAL ones matter, because the query compares them with strftime(), which is text.
  db.run(`create table sessions (id, source, title, model, model_config, parent_session_id, started_at real, ended_at real, end_reason,
      last_activity_at real, last_activity_description, api_call_count integer, input_tokens integer, output_tokens integer,
      cache_read_tokens integer, cache_write_tokens integer, estimated_cost_usd real, cost_status, message_count integer,
      hidden integer, archived integer);
    create table messages (id integer primary key, session_id, role, content);
    create table session_turn_leases (conversation_id, expires_at real);
    create table async_delegations (delegation_id, parent_session_id, state, delivery_state, dispatched_at real, completed_at real, task_json);`);
  const add = db.prepare("insert into sessions (id, source, title, model_config, parent_session_id, started_at, ended_at, end_reason, last_activity_at, input_tokens, output_tokens, cache_read_tokens) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 10, 5, 3)");
  add.run("p1", "cli", "Parent", "{}", null, t - 600, null, null, t - 5);
  const child = (id: string, started: number, ended: number | null, end: string | null, last: number) =>
    add.run(id, "subagent", `Subagent: ${id}`, '{"_delegate_from":"p1"}', "p1", started, ended, end, last);
  child("c1", t - 500, t - 400, "agent_close", t - 400);
  child("c2", t - 100, null, null, t - 2);
  child("c3", t - 2000, null, null, t - 1500);
  add.run("bad", "cli", "Bad config", "{oops", null, t - 800, t - 700, "done", t - 700); // a row that is not JSON must not fail the read
  db.run("insert into messages (session_id, role, content) values ('c1', 'user', 'goal text'), ('c1', 'assistant', 'done')");
  db.run(`insert into session_turn_leases values ('p1', ${t + 60})`);
  db.run(`insert into async_delegations values ('d1', 'p1', 'completed', 'delivered', ${t - 90}, ${t - 30}, '{"goals":[1,2],"goal":"g"}')`);
  db.run(`insert into async_delegations values ('d2', 'p1', 'error', null, ${t - 95}, null, 'not json')`);

  const sql = activityScript("default").split("<<'SQL' || echo null\n")[1]!.split("\nSQL\n")[0]!;
  const out = db.query(sql).values()[0]![0] as string;
  const a = parseActivity(dump(`activity\n${out}`))!;
  expect(a.now.map(s => [s.id, s.turn, s.child]).sort()).toEqual([["c2", false, true], ["p1", true, false]]);
  expect(a.delegations.map(g => [g.id, g.children.map(k => [k.id, k.status, k.end])])).toEqual([
    ["p1", [["c3", "stale", null], ["c1", "ended", "agent_close"], ["c2", "running", null]]]]);
  expect(a.delegations[0]?.children[1]).toMatchObject({ label: "c1", goal: "goal text", result: "done", input: 10, output: 5, cached: 3 });
  expect(a.recent.map(r => [r.title, r.kids])).toEqual([["Parent", 3], ["Bad config", 0]]);
  expect(a.async.map(j => [j.state, j.tasks])).toEqual([["completed", 2], ["error", null]]);
  expect(a.async[0]).toMatchObject({ delivery: "delivered" });

  // Outcomes: the detail query reads sync, refused and background calls.
  const log = new Database(":memory:");
  log.run(`create table messages (id integer primary key, session_id, role, content, tool_calls, tool_name, tool_call_id, timestamp real);
    create table async_delegations (delegation_id, state, result_json);`);
  const call = (id: string, args: object) => JSON.stringify([{ id, function: { name: "delegate_task", arguments: JSON.stringify(args) } }]);
  const put = log.prepare("insert into messages (session_id, role, content, tool_calls, tool_name, tool_call_id, timestamp) values ('local:1', ?, ?, ?, ?, ?, ?)");
  put.run("assistant", null, call("a", { tasks: [{ goal: "alpha goal" }, { goal: "beta goal" }, { goal: "gamma goal" }] }), null, null, 1);
  put.run("tool", JSON.stringify({ results: [{ task_index: 0, status: "completed", exit_reason: "done", summary: "alpha ok" }, { task_index: 1, status: "error", error: "boom" }, { task_index: 2 }] }), null, "delegate_task", "a", 2);
  put.run("tool", JSON.stringify({ error: "too many tasks" }), null, "delegate_task", "b", 3);
  put.run("tool", JSON.stringify({ mode: "async", delegation_id: "d1", goals: ["delta goal"] }), null, "delegate_task", "c", 4);
  log.run("insert into async_delegations (delegation_id, state) values ('d1', 'running')");

  const detail = detailScript("default", "local:1").split("<<'SQL' || echo null\n")[1]!.split("\nSQL")[0]!;
  const calls = parseDetail(dump(`detail\n${log.query(detail).values()[0]![0] as string}`))!;
  expect(calls.map(c => [c.error, c.tasks.map(t => t.status)])).toEqual([[null, ["running"]], ["too many tasks", []], [null, ["completed", "error", "unknown"]]]);
  expect(taskOf(calls, "  alpha   goal, then more")).toMatchObject({ status: "completed", exit: "done", summary: "alpha ok" });
  expect(taskOf(calls, "beta goal")).toMatchObject({ status: "error", error: "boom" });
  expect([same("a  b", "a b c"), same("", "x"), same(null, "x"), same("x".repeat(80), "x".repeat(60))]).toEqual([true, false, false, true]);
  // Siblings that open alike (same 60 characters): a child takes the one task whose whole goal opens its own goal, else it has no outcome.
  const stem = "s".repeat(60);
  const pair = (...goals: string[]): Call[] => [{ at: 1, error: null, tasks: goals.map((goal, i) => ({ goal, status: i ? "error" : "completed" })) }];
  const twins = pair(`${stem} one`, `${stem} two`);
  expect([taskOf(twins, `${stem} two, more`)?.status, taskOf(twins, `${stem} one`)?.status]).toEqual(["error", "completed"]);
  expect([taskOf(twins, stem), taskOf(pair(stem, `${stem} two`), `${stem} two`), taskOf([...twins, ...twins], `${stem} two`)]).toEqual([undefined, undefined, undefined]);
  expect([only([1, 2, 3], n => n > 2), only([1, 2, 3], n => n > 1), only([1], n => n > 1)]).toEqual([3, undefined, undefined]);

  expect(detailScript("ops", "local:1")).toContain("'local:1'");
  expect(() => detailScript("ops", "x'; drop table messages; --")).toThrow();
  const read = (exitCode: number, stdout: string, stderr = "") => new ActivityClient(adapter(exitCode, stdout, stderr)).detail("h", "ops", "local:1");
  expect([await read(0, ""), await read(0, "\u001edetail\nnull"), await read(1, "", "boom")]).toEqual([[], "Couldn't read outcomes", "boom"]);
});
