import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHud, elapsed, hudScript, LINGER, parseHud, parseProcs } from "../src/hermes/hud";
import { HermesChat } from "../src/hermes/chat";
import { SendQueue, type Queued } from "../src/hermes/send-queue";
import { askFor, invocationOf, matchSkills, slashSkill, userInvocation } from "../src/hermes/skills-chat";
import { parseSections, type Sections } from "../src/hermes/remote";
import type { Activity, Session, Subagent } from "../src/hermes/activity";

const dump = (...parts: string[]): Sections => parseSections(parts.map(part => `\u001e${part}`).join("\n"));
const session = (over: Partial<Session>): Session => ({ id: "s", source: "cli", title: "Chat", model: "m", started: 900, last: 990, doing: null, turn: true, parent: null, child: false, ...over });
const kid = (over: Partial<Subagent>): Subagent => ({ id: "k", label: "research", goal: null, status: "running", end: null, model: "gpt", started: 950, secs: 0, calls: null, input: null, output: null, cached: 0, cost: null, costStatus: null, doing: "searching", result: null, ...over });
const activity = (over: Partial<Activity>): Activity => ({ at: 1000, now: [], delegations: [], async: [], recent: [], live: [], ...over });

test("buildHud shows turns, live agents, lingering finished ones, open background jobs and processes; running first", () => {
  const hud = buildHud(activity({
    now: [session({ id: "a" }), session({ id: "idle", turn: false }), session({ id: "kid", child: true })],
    delegations: [{ id: "a", title: null, source: null, children: [
      kid({ id: "run" }),
      kid({ id: "fresh", status: "ended", started: 960, secs: 30, end: "agent_close" }),
      kid({ id: "bad", status: "ended", started: 960, secs: 30, end: "error" }),
      kid({ id: "old", status: "ended", started: 100, secs: 10, end: "agent_close" }),
      kid({ id: "quiet", status: "stale" }),
    ] }],
    async: [{ state: "x", delivery: null, dispatched: 800, completed: null, tasks: 2, goal: "digest" }, { state: "x", delivery: null, dispatched: 700, completed: 900, tasks: 1, goal: "done" }],
  }), [{ id: "p", pid: 5, command: "npm run dev", started: 600 }]);
  expect(hud.items.map(i => [i.key, i.state])).toEqual([
    ["p:p", "running"], ["j:800", "running"], ["s:a", "running"], ["a:run", "running"], ["a:fresh", "done"], ["a:bad", "failed"],
  ]);
  expect(hud.items.find(i => i.key === "a:fresh")?.ended).toBe(990);
  expect(LINGER).toBe(20);
});

test("parseProcs keeps only pids that are alive; parseHud tells a failed query from an empty profile", () => {
  const procs = JSON.stringify([{ id: "x", pid: 7, command: " a   b ", started: 1 }, { id: "y", pid: 8, command: "gone", started: 2 }]);
  expect(parseProcs(dump(`procs\n${procs}`, "alive\n7"))).toEqual([{ id: "x", pid: 7, command: "a b", started: 1 }]);
  expect(parseHud(dump())).toMatchObject({ items: [] });
  expect(parseHud(dump("activity\nnull"))).toBeNull();
});

test("elapsed reads as seconds, minutes, hours", () => {
  expect([elapsed(-3), elapsed(42), elapsed(187), elapsed(3900)]).toEqual(["0s", "42s", "3:07", "1h 05m"]);
});

test("the processes query lists only live host-scoped pids from processes.json", async () => {
  const home = mkdtempSync(join(tmpdir(), "hud-"));
  mkdirSync(join(home, ".hermes"));
  writeFileSync(join(home, ".hermes", "processes.json"), JSON.stringify([
    { session_id: "s1", pid: process.pid, command: "sleep 99", started_at: 5 },
    { session_id: "s2", pid: 2 ** 22 + 12345, command: "dead", started_at: 6 },
    { session_id: "s3", pid: process.pid, pid_scope: "sandbox", command: "elsewhere", started_at: 7 },
  ]));
  const script = `HOME='${home}'; H="$HOME/.hermes"; S() { printf '\\036%s\\n' "$1"; }\n${hudScript("default")}`;
  const run = Bun.spawnSync(["sh", "-c", script]);
  const procs = parseProcs(parseSections(run.stdout.toString()));
  expect(procs.map(p => [p.id, p.pid, p.command])).toEqual([["s1", process.pid, "sleep 99"]]);
});

test("slashSkill matches a known skill by slug and keeps what follows; matchSkills ranks prefix before description", () => {
  const skills = [{ name: "code-review", description: "review a diff" }, { name: "plan" }, { name: "deploy", description: "ship the code" }];
  expect(slashSkill("/Code-Review  the diff\nplease", skills)).toEqual({ name: "code-review", instruction: "the diff\nplease" });
  expect(slashSkill("/plan", skills)).toEqual({ name: "plan", instruction: "" });
  expect([slashSkill("/help", skills), slashSkill("hello", skills)]).toEqual([null, null]);
  expect(matchSkills(skills, "co").map(s => s.name)).toEqual(["code-review", "deploy"]);
  expect(matchSkills(skills, "").map(s => s.name)).toEqual(["code-review", "deploy", "plan"]);
});

test("invocationOf recovers the typed instruction from the CLI scaffold, single and bundle, and userInvocation prefers our own skill", () => {
  const single = `[IMPORTANT: The user has invoked the "plan" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]\n\n# Plan\nThe user has provided the following instruction alongside the skill invocation: not this\n\nbody\nThe user has provided the following instruction alongside the skill invocation: ship it\n\n[Runtime note: x]`;
  expect(invocationOf(single)).toEqual({ name: "plan", instruction: "ship it" });
  const bundle = `[IMPORTANT: The user has invoked the /a /b skill bundle, in order.]\nUser instruction: do it\n\n[Loaded as part of the bundle]`;
  expect(invocationOf(bundle)).toEqual({ name: "a /b", instruction: "do it" });
  expect(invocationOf("plain")).toBeNull();
  expect(userInvocation(askFor("plan"), "plan")).toEqual({ name: "plan", instruction: "" });
  expect(userInvocation("hi")).toBeNull();
});

test("send preloads the skill with --skills after --resume and refuses an unsafe name without sending", async () => {
  const sent: string[] = [];
  const decode = (command: string) => Buffer.from(command.match(/printf %s (\S+)/)![1]!, "base64").toString();
  const adapter = { buildArgv: (_a: string, c: { remoteCommand: string }) => ["--", c.remoteCommand] } as never;
  const processes = { stream: (_f: string, argv: string[]) => { sent.push(decode(argv.at(-1)!)); return { stop() {}, done: Promise.resolve({ exitCode: 0, stderrTail: "" }) }; } } as never;
  const chat = new HermesChat(adapter, processes);
  chat.send("h", "logos", "20261001_000926_56c382", "hi", () => {}, () => {}, "code-review");
  expect(sent.pop()).toContain("hermes -p logos chat --resume 20261001_000926_56c382 --skills code-review --query-file -");
  const refused = await chat.send("h", "logos", "", "hi", () => {}, () => {}, "-x; rm").done;
  expect(refused).toMatchObject({ refused: true });
  expect(sent).toEqual([]);
});

test("SendQueue keeps order, holds while paused, retries a requeued message first and resets when emptied", () => {
  const q = new SendQueue();
  const add = (draft: string) => q.push({ alias: "h", profile: "p", draft, query: draft, skill: "" });
  const [a, b, c] = [add("a"), add("b"), add("c")] as [Queued, Queued, Queued];
  expect([a.id, b.id, c.id]).toEqual([1, 2, 3]);
  expect(q.remove(b.id)?.draft).toBe("b");
  expect(q.remove(99)).toBeUndefined();
  expect(q.take()).toBe(a);
  q.requeue(a);
  q.paused = true;
  expect(q.take()).toBeUndefined();
  expect(q.list.map(i => i.draft)).toEqual(["a", "c"]);
  q.paused = false;
  expect([q.take()?.draft, q.take()?.draft, q.take()]).toEqual(["a", "c", undefined]);
  q.paused = true;
  add("d");
  expect(q.paused).toBe(false);
  q.paused = true;
  q.clear();
  expect([q.list.length, q.paused]).toEqual([0, false]);
});
