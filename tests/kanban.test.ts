import { expect, test } from "bun:test";
import { attachmentPath, dropVerb, KanbanClient, parseBoard, parseBulk, parseCreate, parseDiagnostics, staleness, stuck, verb, type Card, type Feed, type FeedRow, type Status } from "../src/hermes/kanban";
import { b64Arg, parseSections } from "../src/hermes/remote";
import { SshReadOnlyAdapter } from "../src/ui/ssh-read-only-adapter";

const sec = (...parts: [string, string][]) => parseSections(parts.map(([name, body]) => `\u001e${name}\n${body}\n`).join(""));

test("parseBoard reads boards and config, and keeps the previous tasks while the token holds", () => {
  const base: [string, string][] = [
    ["meta default", ""], ["counts default", '{"todo":2}'],
    ["meta gone", '{"slug":"gone","name":"Gone","archived":true}'],
    ["meta x", '{"name":"X","icon":"🧪","description":"","default_workdir":"/w"}'], ["counts x", "{}"],
    ["profiles", "alice\nbob"], ["config", '  dispatch_in_gateway: true\n  default_workspace: "scratch"'],
    ["board", "x"], ["token", "12.3"],
  ];
  const prev = [{ id: "t_0" }] as Card[];
  const read = parseBoard(sec(...base), prev);
  expect(read.boards.map(b => [b.slug, b.name, b.archived])).toEqual([["default", "Default", false], ["gone", "Gone", true], ["x", "X", false]]);
  expect(read.boards[2]).toStrictEqual({ slug: "x", name: "X", icon: "🧪", workdir: "/w", archived: false, counts: {} });
  expect(read.boards[0]?.counts).toEqual({ todo: 2 });
  expect(read).toMatchObject({ board: "x", token: "12.3", profiles: ["alice", "bob"], config: { dispatch_in_gateway: "true", default_workspace: "scratch" } });
  expect(read.tasks).toBe(prev);
  expect(parseBoard(sec(...base, ["tasks", '[{"id":"t_1"}]']), prev).tasks.map(t => t.id)).toEqual(["t_1"]);
  const broken = parseBoard(sec(...base, ["tasks", "[{"]), prev);
  expect(broken.token).toBeNull();
  expect(broken.tasks).toBe(prev);
  expect(parseBoard(sec(["board", "x"])).tasks).toEqual([]);
  expect(parseBoard(sec(["config", 'a: x # note\nb: "y # z" # note\nc: # only\nu: http://x/#y'])).config).toEqual({ a: "x", b: "y # z", u: "http://x/#y" });
});

test("dropVerb maps column drops to CLI verbs", () => {
  const cases: [Status, Status, ReturnType<typeof dropVerb>][] = [
    ["todo", "ready", "promote"], ["scheduled", "ready", "unblock"], ["review", "ready", "reopen-review"], ["running", "ready", "reclaim"],
    ["running", "blocked", "block"], ["review", "done", "complete"], ["done", "archived", "archive"],
    ["ready", "todo", "refuse"], ["ready", "review", null], ["todo", "done", null], ["ready", "ready", null],
  ];
  for (const [from, to, want] of cases) expect([from, to, dropVerb(from, to)]).toEqual([from, to, want]);
});

test("staleness ages running cards from their start, the rest from creation", () => {
  const card = (status: Status, extra: Partial<Card> = {}): Card => ({ id: "t", title: "t", status, priority: 0, createdAt: 0, ...extra });
  expect(staleness(card("ready"), 3599)).toBe("");
  expect(staleness(card("ready"), 3600)).toBe("amber");
  expect(staleness(card("blocked"), 86400)).toBe("red");
  expect(staleness(card("running", { startedAt: 1000 }), 1601)).toBe("amber");
  expect(staleness(card("done"), 1e9)).toBe("");
});

test("stuck alerts once per task on known boards, seeds new ones, skips our own blocks and keeps absent boards' cursors", () => {
  const row = (id: number, task: string, kind = "blocked"): FeedRow => ({ id, task, title: task.toUpperCase(), kind, reason: "why" });
  const feed: Feed = {
    default: { archived: false, max: 9, rows: [row(8, "a", "gave_up"), row(9, "a"), row(7, "b"), row(6, "mine")] },
    fresh: { name: "Fresh", archived: false, max: 4, rows: [row(4, "c")] },
    old: { archived: true, max: 3, rows: [row(3, "d")] },
    reset: { archived: false, max: 2, rows: [row(2, "e")] },
  };
  const { alerts, next } = stuck(feed, { default: 5, old: 1, reset: 50, gone: 7 }, new Map([["mine", 1000]]), 61_000);
  expect(alerts.map(a => [a.task, a.kind, a.boardName])).toEqual([["a", "blocked", "Default"], ["b", "blocked", "Default"]]);
  expect(next).toEqual({ default: 9, fresh: 4, reset: 2, old: 1, gone: 7 });
});

test("verb keeps ids to safe tokens and free text in base64", () => {
  expect(verb({ verb: "reclaim", id: "t_1", reason: "stale" })).toBe(`reclaim --reason=${b64Arg("stale")} -- t_1`);
  expect(verb({ verb: "reassign", id: "t_1", profile: null, reason: "r" })).toBe(`reassign --reclaim --reason=${b64Arg("r")} -- t_1 none`);
  expect(verb({ verb: "complete", id: "t_1", summary: "s", force: true })).toBe(`complete --summary=${b64Arg("s")} --force -- t_1`);
  expect(verb({ verb: "block", id: "t_1", kind: "needs_input", reason: "-x" })).toBe(`block --kind=needs_input -- t_1 ${b64Arg("-x")}`);
  expect(verb({ verb: "purge", id: "t_1" })).toBe("archive --rm=t_1");
  expect(verb({ verb: "attach-rm", id: "t_1", attachment: 3 })).toBe("attach-rm -- 3");
  expect(() => verb({ verb: "attach-rm", id: "t_1", attachment: 1.5 })).toThrow();
  expect(verb({ verb: "set-model", id: "t_1", model: null })).toBe("set-model -- t_1 none");
  expect(() => verb({ verb: "promote", id: "t_1; rm -rf ~" })).toThrow();
  expect(() => verb({ verb: "edit", id: "t_1", priority: 1.5 })).toThrow();
});

test("CLI output parsers: create, bulk and diagnostics", () => {
  expect(parseCreate("Created t_ab12  (ready, assignee=alice)\n\n⚠  No dispatcher is running")).toEqual({ id: "t_ab12", warning: "No dispatcher is running" });
  expect(parseCreate("Created t_ab12  (blocked, assignee=-)")).toEqual({ id: "t_ab12" });
  const bulk = sec(["ok t_1", ""], ["fail t_2", "Traceback (most recent call last):\n  File x\nValueError: bad state"]);
  expect(parseBulk(bulk, ["t_1", "t_2", "t_3"].map(id => ({ verb: "promote" as const, id })))).toEqual({
    t_1: { ok: true }, t_2: { ok: false, message: "ValueError: bad state" }, t_3: { ok: false, message: "No confirmation from host" },
  });
  const batch = sec(["archive", "Archived a\ncannot archive b"], ["purge", "cannot delete e (must already be archived)\nDeleted d"]);
  expect(parseBulk(batch, [...["a", "b", "c"].map(id => ({ verb: "archive" as const, id })), { verb: "purge", id: "d" }, { verb: "purge", id: "e" }])).toEqual({
    a: { ok: true }, b: { ok: false, message: "cannot archive b" }, c: { ok: false, message: "No confirmation from host" },
    d: { ok: true }, e: { ok: false, message: "cannot delete e (must already be archived)" },
  });
  const aborted = sec(["archive", "Archived a\nTraceback (most recent call last):\nsqlite3.OperationalError: database is locked"]);
  expect(parseBulk(aborted, [{ verb: "archive", id: "c" }])).toEqual({ c: { ok: false, message: "sqlite3.OperationalError: database is locked" } });
  const d = { kind: "stale_claim", severity: "warning", title: "Stale", actions: [] };
  expect(parseDiagnostics(JSON.stringify([{ task_id: "t_1", diagnostics: [d] }, { task_id: "t_2", diagnostics: [] }, { task_id: null, diagnostics: [d] }]))).toEqual({ t_1: [d] });
  expect(parseDiagnostics("not json")).toEqual({});
});

test("write scripts: nudge, create, board create, watcher cursors, slow verbs and diagnostics (never run live)", async () => {
  const sent: string[] = [];
  const fake = (tag: string) => ({ run: async (_alias: string, command: { remoteCommand: string }) => {
    sent.push(tag + Buffer.from(command.remoteCommand.match(/printf %s (\S+)/)![1]!, "base64").toString());
    return { transport: "connected", exitCode: 0, stdout: "\u001eok\nCreated t_9  (blocked, assignee=-)\nSpawned:      0\nSkipped (unassigned): t_a, t_b\n", stderr: "", capExceeded: false };
  } }) as never;
  const client = new KanbanClient(fake(""), fake("slow:"));
  expect(await client.nudge("h", "zz-probe")).toEqual({ ok: true, text: "Spawned: 0 · Skipped (unassigned): t_a, t_b" });
  expect(await client.create("h", "zz-probe", { title: "Probe", status: "blocked" })).toEqual({ ok: true, id: "t_9" });
  expect(client.mine.has("t_9")).toBe(true);
  expect(await client.boards("h", { verb: "create", slug: "zz-obsidian-probe-1", name: "Obsidian probe", description: "", icon: "🧪", color: "", workdir: "" })).toEqual({ ok: true });
  expect(await client.boards("h", { verb: "rm", slug: "default" })).toMatchObject({ ok: false });
  expect(await client.events("h", { default: 5, "a b": 3, x: -1, y: 1.5 })).toBeNull();
  expect(await client.run("h", "zz-probe", { verb: "specify", id: "t_1" })).toEqual({ ok: true });
  expect(await client.diagnostics("h", "zz-probe")).toEqual({});
  expect(sent).toHaveLength(6);
  expect(sent[0]).toContain("hermes kanban --board zz-probe dispatch --max=8");
  expect(sent[1]).toContain(`create --created-by=obsidian --initial-status=blocked -- ${b64Arg("Probe")}`);
  expect(sent[2]).toContain(`[ -e "$H/kanban/boards/zz-obsidian-probe-1" ] && {`);
  expect(sent[2]).toContain("boards create --name=");
  expect(sent[3]).toContain(`cur() { case "$1" in default) echo 5;; *) echo -1;; esac; }`);
  expect(sent[4]).toStartWith("slow:");
  expect(sent[4]).toContain("hermes kanban --board zz-probe specify -- t_1");
  expect(sent[5]).toContain(`[ -f "$H/kanban/boards/zz-probe/kanban.db" ] || {`);
  expect(sent.join("\n")).not.toMatch(/--switch|--delete|boards delete/);
});

/** A fake ssh adapter that records each script; `reply(n)` overrides the outcome of the n-th call (from 1). */
function fakeSsh(reply: (n: number) => object = () => ({})) {
  const scripts: string[] = [];
  const adapter = { run: async (_alias: string, command: { remoteCommand: string }) => {
    scripts.push(Buffer.from(command.remoteCommand.match(/printf %s (\S+)/)![1]!, "base64").toString());
    return { transport: "connected", stdout: "", stderr: "", exitCode: 0, capExceeded: false, ...reply(scripts.length) };
  } } as unknown as SshReadOnlyAdapter;
  return { adapter, scripts };
}
const archives = (n: number) => Array.from({ length: n }, (_, i) => ({ verb: "archive" as const, id: `t_${i}` }));

test("bulk runs chunks of 15 on the slow adapter, archives and purges in one call each (never run live)", async () => {
  const fast = fakeSsh(), slow = fakeSsh(), client = new KanbanClient(fast.adapter, slow.adapter);
  expect(Object.keys(await client.bulk("h", "zz-probe", archives(45)))).toHaveLength(45);
  expect(fast.scripts).toHaveLength(0);
  expect(slow.scripts.map(s => s.match(/archive -- .*/g))).toEqual([0, 1, 2].map(n =>
    [`archive -- ${archives(45).slice(n * 15, n * 15 + 15).map(v => v.id).join(" ")} 2>&1 </dev/null; :`]));
  await client.bulk("h", "zz-probe", [{ verb: "purge", id: "p_1" }, { verb: "block", id: "b_1", reason: "r" }, { verb: "purge", id: "p_2" }]);
  expect(slow.scripts[3]).toContain("S purge; hermes kanban --board zz-probe archive --rm p_1 p_2 2>&1 </dev/null; :");
  expect(slow.scripts[3]).toContain(`out=$(hermes kanban --board zz-probe block -- b_1 ${b64Arg("r")} 2>&1`);
  expect(client.mine.has("b_1")).toBe(false);
});

test("bulk stops at a failed chunk and skips the rest", async () => {
  const slow = fakeSsh(n => n === 2 ? { transport: "timeout", exitCode: null } : {});
  const result = await new KanbanClient(fakeSsh().adapter, slow.adapter).bulk("h", "zz-probe", archives(45));
  expect(slow.scripts).toHaveLength(2);
  expect([result.t_14, result.t_15, result.t_29, result.t_30, result.t_44]).toEqual([
    { ok: false, message: "No confirmation from host" }, { ok: false, unknown: true, message: "timeout" }, { ok: false, unknown: true, message: "timeout" },
    { ok: false, message: "Skipped: an earlier batch failed" }, { ok: false, message: "Skipped: an earlier batch failed" },
  ]);
});

test("attachmentPath accepts only <root>/<task id>/<file>", () => {
  const root = "/h/.hermes/kanban/attachments", ok = `${root}/t_1/f.txt`;
  expect(attachmentPath(ok, root, "t_1")).toBe(ok);
  for (const stored of ["h/.hermes/kanban/attachments/t_1/f.txt", `${root}/t_1/../t_2/f.txt`, `${root}/t_1/./f.txt`, `${root}/t_1//f.txt`, `${root}/t_1/..`,
    "/h/.hermes/kanban/attachments-evil/t_1/f.txt", "/etc/passwd", `${root}/t_1/f\n.txt`, `${root}/t_1/f\u0000.txt`, root, `${root}/t_1`, `${root}/t_1/`,
    `${root}/t_2/f.txt`, `${root}/t_1/d/f.txt`, `${root}/t_1/f.txt/`, undefined])
    expect(attachmentPath(stored, root, "t_1")).toBeNull();
  for (const r of [undefined, `${root}/`, "/h/.hermes/kanban/../kanban/attachments", "/"]) expect(attachmentPath(ok, r, "t_1")).toBeNull();
});

test("upload: bytes ride stdin into a trapped temp file, the name travels base64, over 25 MiB never reaches ssh (never run live)", async () => {
  const sent: { script: string; stdin?: Uint8Array | undefined }[] = [];
  const slow = { run: async (_alias: string, command: { remoteCommand: string; stdin?: Uint8Array }) => {
    sent.push({ script: Buffer.from(command.remoteCommand.match(/printf %s (\S+)/)![1]!, "base64").toString(), stdin: command.stdin });
    return { transport: "connected", stdout: "\u001eok\n", stderr: "", exitCode: 0, capExceeded: false };
  } } as unknown as SshReadOnlyAdapter;
  const fast = fakeSsh(), client = new KanbanClient(fast.adapter, slow), bytes = new Uint8Array([0, 1, 2, 255]);
  expect(await client.run("h", "zz-probe", { verb: "attach", id: "t_1", name: "a b.txt", bytes })).toEqual({ ok: true });
  expect(fast.scripts).toHaveLength(0);
  expect(sent[0]!.stdin).toBe(bytes);
  for (const line of [`t=$(mktemp "\${TMPDIR:-/tmp}/hermes-attach.XXXXXX") || exit 1`, `trap 'rm -f "$t"' EXIT`, `cat > "$t" || exit 1`, `[ $(wc -c < "$t") -eq 4 ] || {`,
    `hermes kanban --board zz-probe attach --author=obsidian --name=${b64Arg("a b.txt")} -- t_1 "$t" </dev/null`])
    expect(sent[0]!.script).toContain(line);
  expect(sent[0]!.script).not.toContain("a b.txt");
  expect(String(await client.run("h", "zz-probe", { verb: "attach", id: "t;1", name: "x", bytes }).catch((e: unknown) => e))).toContain("Unsafe remote token");
  expect(await client.run("h", "zz-probe", { verb: "attach", id: "t_1", name: "x", bytes: new Uint8Array(25 * 1024 * 1024 + 1) })).toEqual({ ok: false, message: "Larger than 25 MiB" });
  expect(sent).toHaveLength(1);
  const ssh = new SshReadOnlyAdapter({ runner: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0, capExceeded: false }) });
  const command = { kind: "hermes" as const, remoteCommand: "true", byteCap: 1, nulSeparated: false };
  expect(ssh.buildArgv("h", { ...command, stdin: bytes })).not.toContain("-n");
  expect(ssh.buildArgv("h", command)).toContain("-n");
});

test("poll reads the board only when the probed token moved (never run live)", async () => {
  const read = (token: string) => ({ stdout: `\u001eboard\nzz-probe\n\u001etoken\n${token}\n\u001etasks\n[]\n` });
  const probe = (token: string) => ({ stdout: `\u001etoken\n${token}\n` });
  const replies = [read("1.1"), probe("1.1"), probe("2.1"), read("2.1")];
  const ssh = fakeSsh(n => replies[n - 1] ?? {}), client = new KanbanClient(ssh.adapter);
  await client.board("h", "zz-probe", false);
  expect(await client.poll("h", "zz-probe", false)).toBeNull();
  expect(await client.poll("h", "zz-probe", false)).toMatchObject({ token: "2.1" });
  expect(ssh.scripts.map(s => s.includes("S board"))).toEqual([true, false, false, true]);
});

test("watch asks once per tick, and only a moved token calls changed (never run live)", async () => {
  const ssh = new SshReadOnlyAdapter({ runner: () => Promise.resolve({ stdout: "\u001eboard\nzz-probe\n\u001etoken\n1.1\n\u001etasks\n[]\n", stderr: "", exitCode: 0, capExceeded: false }) });
  const writes: string[] = [];
  let argv: readonly string[] = [], feed = (_line: string): void => undefined;
  const processes = { stream: (_file: string, args: readonly string[], options: { onStdout(line: string): void }) => {
    argv = args;
    feed = line => options.onStdout(line);
    return { stop() {}, write: (text: string) => writes.push(text), done: new Promise(() => {}) };
  } };
  const client = new KanbanClient(ssh, ssh, processes as never);
  await client.board("h", "zz-probe", false);
  let changed = 0;
  const live = client.watch("h", "zz-probe", () => false, () => changed++);
  expect([live.tick(), live.tick(), writes.length]).toEqual([true, true, 1]);
  feed("1.1");
  feed("");
  expect(changed).toBe(0);
  live.tick();
  feed("2.1");
  expect([changed, writes.length]).toEqual([1, 2]);
  feed("\u001e?0");
  expect(live.tick()).toBe(false);
  expect([argv.includes("-n"), argv.includes("BatchMode=yes")]).toEqual([false, true]);
});
