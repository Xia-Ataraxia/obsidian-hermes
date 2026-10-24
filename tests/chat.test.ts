import { expect, mock, spyOn, test } from "bun:test";
import { HermesChat, reduce, sessionFrom, type Turn } from "../src/hermes/chat";
import { safeToken } from "../src/hermes/remote";
import { ControlCenterProcesses } from "../src/ui/control-center-processes";

const SID = "20261001_000926_56c382";

test("reduce folds stream-json: our after line, deltas, tools paired by id then by name, the result after a replay gap", () => {
  const turn: Turn = { user: "hi", after: null, sid: "", code: null, text: "", tools: [], usage: null, error: null, done: false };
  const fold = (...lines: string[]) => lines.map(line => reduce(turn, line));
  expect(fold("not json", "[1]", '{"type":"system","subtype":"init","model":"m","session_id":""}', '{"type":"after","id":41}', '{"type":"text","text":"Hel"}', '{"type":"text","text":"lo"}'))
    .toEqual([null, null, null, "turn", "text", "text"]);
  expect(turn).toMatchObject({ after: 41, text: "Hello" });
  fold(
    '{"type":"tool_use","name":"web","tool_call_id":"a","input":{"q":"x"}}',
    '{"type":"tool_use","name":"terminal"}',
    '{"type":"tool_result","name":"terminal","output":"BLOCKED: x","duration_ms":5,"is_error":false}',
    '{"type":"tool_result","name":"web","tool_call_id":"a","output":"{}","duration_ms":1200,"is_error":true}',
  );
  expect(turn.tools).toEqual([
    { id: "a", name: "web", input: '{\n  "q": "x"\n}', output: "{}", ms: 1200, error: true },
    { id: "", name: "terminal", input: "", output: "BLOCKED: x", ms: 5, error: false },
  ]);
  expect(fold(`{"type":"result","session_id":"${SID}","exit_code":0,"text":"Hello world","tokens":{"input":1200,"output":34,"total":1234,"cache_read":0,"cache_write":0},"duration_ms":8400,"replay_gap":true}`))
    .toEqual(["turn"]);
  expect(turn).toMatchObject({ text: "Hello world", sid: SID, code: 0, error: null, done: true, usage: { in: 1200, out: 34, ms: 8400 } });
});

test("sessionFrom takes only safe ids, from either stderr form", () => {
  expect(sessionFrom(`Session: ${SID}`)).toBe(SID);
  expect(sessionFrom(`session_id: local-${"a".repeat(64)}`)).toBe(`local-${"a".repeat(64)}`);
  expect(sessionFrom("Session: x;rm -rf ~")).toBeNull();
  expect(sessionFrom("Session: -p")).toBeNull();
});

test("read parses one dump; send creates with --source cli, resumes without creation flags, guards the gateway and exits with the script", async () => {
  const sent: string[] = [];
  const rows = [{ id: 2, role: "assistant", at: 2, text: "b", tools: null }, { id: 1, role: "user", at: 1, text: "a", tools: null }] as const;
  const thread = { id: SID, source: "cli", title: "t", at: 1 };
  const decode = (command: string) => Buffer.from(command.match(/printf %s (\S+)/)![1]!, "base64").toString();
  const adapter = {
    run: async (_alias: string, command: { remoteCommand: string }) => {
      sent.push(decode(command.remoteCommand));
      return { transport: "connected", exitCode: 0, stdout: `\u001eprofiles\ndefault 1\nlogos 0\n\u001ethreads\n${JSON.stringify([{ ...thread, id: "latest" }, { ...thread, id: null }, thread])}\n\u001erows\n${JSON.stringify(rows)}\n`, stderr: "", capExceeded: false };
    },
    buildArgv: (alias: string, command: { remoteCommand: string }) => ["--", alias, command.remoteCommand],
  } as never;
  const processes = { stream: (_file: string, argv: string[], options: { onStdout(line: string): void }) => {
    sent.push(decode(argv.at(-1)!));
    options.onStdout('{"type":"x"}\u001e?75'); // hermes's last line without a newline, then the script's status
    return { stop() {}, done: Promise.resolve({ exitCode: 0, stderrTail: "" }) };
  } } as never;
  const chat = new HermesChat(adapter, processes);
  expect(await chat.read("h", "logos", SID)).toEqual({ profiles: [{ id: "default", live: true }, { id: "logos", live: false }], threads: [thread], rows: [rows[1], rows[0]] });
  expect(sent.pop()).toContain("S rows");
  await chat.read("h", "logos", "");
  expect(sent.pop()).not.toContain("S rows");
  expect(await chat.read("h", "../x", "")).toContain("Unsafe remote token");
  for (const bad of ["..", "-x"]) expect(() => safeToken(bad)).toThrow("Unsafe remote token");
  const events: string[] = [];
  const created = chat.send("h", "logos", "", "x'; rm -rf ~", line => events.push(line), () => {});
  chat.send("h", "logos", SID, "hi", () => {}, () => {});
  chat.send("h", "default", SID, "hi", () => {}, () => {});
  const [create = "", resume = "", fallback = ""] = sent.splice(0);
  expect(create).toContain("| hermes -p logos chat --query-file - --format stream-json --source cli\n");
  expect(create).toContain(`echo 'SELECT max(id) FROM messages;' | ro "$H/profiles/logos"/state.db`);
  expect(create).not.toContain("rm -rf");
  const guard = create.indexOf(`|| { echo "Gateway is not running" >&2; exit 75; }`);
  expect(guard).toBeGreaterThan(0);
  expect(guard).toBeLessThan(create.indexOf("| hermes"));
  expect(create).toEndWith(`printf '\\036?%s\\n' "$?"\n`);
  expect(await created.done).toEqual({ exitCode: 75, stderrTail: "" });
  expect(events).toEqual(['{"type":"x"}']);
  expect(resume).toContain(`| hermes -p logos chat --resume ${SID} --query-file - --format stream-json\n`);
  expect(fallback).toContain(`| hermes -p default chat --resume ${SID} `);
  for (const bad of ["-p", "latest", "LATEST"]) expect(await chat.send("h", "logos", bad, "hi", () => {}, () => {}).done).toEqual({ exitCode: null, stderrTail: `Unsafe session id: ${bad}`, refused: true });
  expect(sent).toEqual([]);
});

test("stream keeps a character split across chunks and the unterminated last line, shows a spawn error and outlives a throwing callback", async () => {
  const lines: string[] = [];
  const options = { timeoutMs: 5000, maxBytes: 1000, onStdout: (line: string) => lines.push(line), onStderr: () => {} };
  const processes = new ControlCenterProcesses();
  // "한" is ED 95 9C; the sleep sends its last byte in a later chunk.
  const run = processes.stream("sh", ["-c", String.raw`printf '\355\225'; sleep 0.2; printf '\234\nlast'; exit 3`, "--", "h"], options);
  expect(await run.done).toEqual({ exitCode: 3, stderrTail: "" });
  expect(lines).toEqual(["한", "last"]);
  expect((await processes.stream("/nonexistent/hermes", ["--", "h"], options).done).stderrTail).toContain("ENOENT");
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  await processes.stream("sh", ["-c", String.raw`printf 'boom\nok\n'`, "--", "h"], { ...options, onStdout: line => { if (line === "boom") throw new Error(line); lines.push(line); } }).done;
  expect([lines.at(-1), quiet.mock.calls.length]).toEqual(["ok", 1]);
  quiet.mockRestore();
});

test("stream ends with a null exit on the byte cap or stop, and refuses a cancelled alias and a disposed owner", async () => {
  const options = { timeoutMs: 5000, maxBytes: 1000, onStdout: () => {}, onStderr: () => {} };
  const processes = new ControlCenterProcesses();
  const closed = { exitCode: null, stderrTail: "Connection closed", refused: true };
  expect(await processes.stream("sh", ["-c", "exec yes", "--", "h"], options).done).toEqual({ exitCode: null, stderrTail: "Response too large\n" });
  const stopped = processes.stream("sh", ["-c", "exec sleep 5", "--", "h"], options);
  stopped.stop();
  expect((await stopped.done).exitCode).toBeNull();
  const cancelled = processes.stream("sh", ["-c", "exec sleep 5", "--", "h"], options);
  await processes.cancel("h");
  expect((await cancelled.done).exitCode).toBeNull();
  expect(await processes.stream("sh", ["-c", "true", "--", "h"], options).done).toEqual(closed);
  await processes.dispose();
  expect(await processes.stream("sh", ["-c", "true", "--", "g"], options).done).toEqual(closed);
});

const rendered: string[] = [];
// bun shares one module registry across test files, so every "obsidian" mock declares the same names (see inspect.test.ts).
await mock.module("obsidian", () => ({
  parseYaml: () => ({}),
  MarkdownRenderer: { render: (_app: unknown, _md: string, _el: unknown, sourcePath: string) => void rendered.push(sourcePath) },
}));
const { tame, renderSafe, web } = await import("../src/hermes/markdown");

test("tame keeps code and highlighting, and drops plugin blocks, embeds and raw HTML", () => {
  expect(tame("```dataviewjs\ndv.x\n```")).toBe("\n```text\ndv.x\n```");
  expect(tame("> ```dataview\n> LIST\n> ```")).toBe("\n> ```text\n> LIST\n> ```");
  expect(tame("```ts\nlet x = 1;\n```")).toBe("\n```ts\nlet x = 1;\n```");
  expect(tame("![](http://x/p.png) ![[n]]")).toBe("\n[](http://x/p.png) [[n]]");
  expect(tame("<img src=x> <iframe")).toBe("\n&lt;img src=x> &lt;iframe");
  expect(tame("`$= dv.x` `= this`")).toBe("\n`$= dv.x` `= this`");
  const code = "`Array<string>`\n```html\n<img>\n```";
  expect(tame(code)).toBe("\n<code>Array&lt;string&gt;</code>\n```html\n<img>\n```");
  expect(tame("[a](x`y) <b> `")).toBe("\n[a](x`y) &lt;b> `");
  expect(tame("> ```js\n<b>")).toBe("\n> ```js\n&lt;b>");
  expect(tame("`\n$= x`\n    ```dataviewjs")).toBe("\n`\n$= x`\n    ```text");
});

test("tame escapes HTML wherever Obsidian may not see a fence", () => {
  for (const md of [
    "$$\n```\n$$\n<iframe src=http://e>\n```",
    "%%\n```\n%%\n<iframe src=http://e>\n```",
    "1) ```html\n   <img src=x>\n   ```",
    "1) ```html\n   x\n   ```\n<img src=x>",
    "`$$`\n```\n$$\n```\n<img src=x>",
    "`$$`\n$$\n```\n$$\n<img src=x>",
    "\\$$\n$$\n```\n$$\n<img src=x>",
    "- a\n    ```\n  ```\n<img src=x>",
    "a ` b\n` <img src=x> `",
    "| `a|<img src=x>` | b |",
  ]) expect(tame(md)).toMatch(/&lt;(iframe|img)/);
  expect(tame("$$\nx\n$$\n```ts\n<a>\n```")).toBe("\n$$\nx\n$$\n```ts\n&lt;a>\n```");
  expect(tame("```\n<img src=x>\r```\r<img src=y>\n```")).toContain("&lt;img src=y");
  expect(tame("```js x\u{2028}\n```\n<img src=x>\n```")).toContain("&lt;img src=x");
  expect(tame("a|b\n-|-\n```js |\n<img src=x>\n```")).toContain("&lt;img src=x");
  expect(tame("> ```\nx\n```\n<img src=y>\n```")).toContain("&lt;img src=y");
  expect(tame("*`*<img src=x>`")).not.toMatch(/<img|!\[/);
  expect(tame("[`]![a](http://x)`")).not.toMatch(/<img|!\[/);
  expect(tame("http://a.b/\\<img src=x>")).not.toContain("<img");
  const fm = "---\n```\n---\n<img src=y>\n```";
  expect(tame(fm)).toBe("\n" + fm);
  const bom = tame("\u{FEFF}```\n<img src=x>\n```\n<img src=y>");
  expect(bom).toStartWith("\n\u{FEFF}");
  expect(bom).toContain("&lt;img src=x");
});

test("renderSafe renders with Dataview off", async () => {
  await renderSafe({} as never, "x", { querySelectorAll: () => [] } as never, {} as never);
  expect(rendered).toEqual(["?no-dataview"]);
});

test("web keeps only http(s) and mailto links", () => {
  for (const href of ["http://a", "HTTPS://a", "mailto:x"]) expect(web(href)).toBe(true);
  for (const href of ["foo", "#tag", "obsidian://x", "//x", "javascript:x", " http://a"]) expect(web(href)).toBe(false);
});
