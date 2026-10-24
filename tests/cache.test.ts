import { expect, mock, test } from "bun:test";
import { CACHE_VERSION, diskCache, keepBoard, keepChat, keepDetail, keepProfiles, piece, type CacheFs, type DiskCache } from "../src/hermes/cache";
import type { ProfilesSnapshot } from "../src/hermes/data";
import type { Detail } from "../src/hermes/inspect";
import type { BoardRead } from "../src/hermes/kanban";
import type { Ask, TaskHost } from "../src/hermes/kanban-drawer";

const ROOT = "plug/cache";
const MARK = "PLANTED";

/** An in-memory vault adapter. Like a disk, it refuses a mkdir or a write whose parent folder is missing. */
function memory() {
  const files = new Map<string, string>();
  const dirs = new Set(["plug"]);
  const writes: string[] = [];
  const made: string[] = [];
  const parent = (path: string): string => path.slice(0, path.lastIndexOf("/"));
  const fs: CacheFs = {
    read: (path) => {
      const text = files.get(path);
      return text === undefined ? Promise.reject(new Error("ENOENT")) : Promise.resolve(text);
    },
    write: (path, data) => {
      if (!dirs.has(parent(path))) return Promise.reject(new Error("ENOENT"));
      files.set(path, data);
      writes.push(path);
      return Promise.resolve();
    },
    exists: (path) => Promise.resolve(files.has(path) || dirs.has(path)),
    mkdir: (path) => {
      if (!dirs.has(parent(path))) return Promise.reject(new Error("ENOENT"));
      dirs.add(path);
      made.push(path);
      return Promise.resolve();
    },
    rmdir: (path) => {
      for (const dir of [...dirs]) if (dir === path || dir.startsWith(`${path}/`)) dirs.delete(dir);
      for (const file of [...files.keys()]) if (file.startsWith(`${path}/`)) files.delete(file);
      return Promise.resolve();
    },
  };
  return { fs, files, writes, made };
}

/** Saves are fire and forget; a drop of a host that is not there waits for every queued write. */
const flush = (cache: DiskCache): Promise<void> => cache.drop("no such host");

test("a saved entry loads back, wrapped with the version and a time", async () => {
  const { fs, files } = memory();
  const cache = diskCache(fs, ROOT, () => true);
  cache.save("mac", "profiles", { n: 1, list: ["a"] });
  await flush(cache);
  const saved = await cache.load("mac", "profiles");
  expect(saved?.data).toEqual({ n: 1, list: ["a"] });
  expect(typeof saved?.at).toBe("number");
  expect(JSON.parse(files.get(`${ROOT}/mac/profiles.json`) ?? "null")).toMatchObject({ v: CACHE_VERSION, data: { n: 1 } });
  expect(await cache.load("mac", "other")).toBeNull();
});

test("a missing, other-version, torn or foreign file reads as a miss", async () => {
  const { fs, files } = memory();
  const cache = diskCache(fs, ROOT, () => true);
  expect(await cache.load("mac", "profiles")).toBeNull();
  for (const text of [
    JSON.stringify({ v: CACHE_VERSION + 1, at: 1, data: {} }),
    JSON.stringify({ v: CACHE_VERSION, data: {} }),
    JSON.stringify({ v: CACHE_VERSION, at: "1", data: {} }),
    JSON.stringify({ v: CACHE_VERSION, at: 1 }),
    '{"v":1,"at":1,"data":{"half":', "not json", "null", "[]", "",
  ]) {
    files.set(`${ROOT}/mac/profiles.json`, text);
    expect(await cache.load("mac", "profiles")).toBeNull();
  }
});

test("an alias or key from the host or the settings stays inside the cache folder", async () => {
  const { fs, files, writes, made } = memory();
  const cache = diskCache(fs, ROOT, () => true);
  const texts = ["../x", "..", ".", "", "a/b", "a\\b", "/etc/passwd", ".hidden", "trail.", "a.b", "Mixed", "_", "_2e", "서버", "a b", "x\0y", "%2e%2e"];
  for (const text of texts) cache.save(text, text, { text });
  await flush(cache);
  expect(writes).toHaveLength(texts.length);
  for (const path of [...writes, ...made]) {
    if (path === ROOT) continue;
    expect(path.startsWith(`${ROOT}/`)).toBe(true);
    for (const part of path.slice(ROOT.length + 1).split("/")) {
      expect(part).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(part === "." || part === "..").toBe(false);
    }
  }
  expect(files.size).toBe(texts.length);
  expect(new Set(texts.map(piece)).size).toBe(texts.length);
  for (const text of texts) expect((await cache.load(text, text))?.data).toEqual({ text });
});

test("a switched-off cache neither reads nor writes, a null root is no cache, and drop forgets a host or all", async () => {
  const { fs, writes } = memory();
  let on = true;
  const cache = diskCache(fs, ROOT, () => on);
  cache.save("a", "k", 1);
  cache.save("b", "k", 2);
  await flush(cache);
  on = false;
  expect(await cache.load("a", "k")).toBeNull();
  cache.save("a", "k2", 3);
  await flush(cache);
  expect(writes).toEqual([`${ROOT}/a/k.json`, `${ROOT}/b/k.json`]);
  on = true;
  await cache.drop("a");
  expect(await cache.load("a", "k")).toBeNull();
  expect((await cache.load("b", "k"))?.data).toBe(2);
  await cache.drop();
  expect(await cache.load("b", "k")).toBeNull();
  cache.save("b", "k", 4);
  await flush(cache);
  expect((await cache.load("b", "k"))?.data).toBe(4);

  const none = diskCache(fs, null, () => true);
  none.save("a", "k", 5);
  await none.drop();
  expect(await none.load("a", "k")).toBeNull();
  expect(writes).toHaveLength(3);
});

test("a profiles copy carries no job prompt, session title, activity snippet or config value", async () => {
  const snapshot: ProfilesSnapshot = {
    now: 1,
    profiles: [{
      id: "hermes", description: `${MARK}-description`, model: "m", provider: "p",
      skills: [{ name: "tdd", category: `${MARK}-category`, description: `${MARK}-skill` }],
      jobs: [{
        id: "j1", name: "nightly", schedule: "0 3 * * *", enabled: true, state: "scheduled", next: "n", last: "l", status: "ok",
        error: `${MARK}-error`, deliver: `${MARK}-deliver`, skills: [`${MARK}-job-skill`], prompt: `${MARK}-prompt`,
      }],
      gateway: { state: "running", alive: true, platforms: { telegram: "connected" }, served: ["a"] },
      usage: {
        sessions7d: 2, tokens7d: 3, cost7d: 4, messages7d: 5, last: 6, busy: 1, daily: [1, 2], sources: { cli: 2 },
        recent: [[`${MARK}-title`, "cli", 7], [`${MARK}-busy-snippet`, "cli", 8]],
      },
      load: { running: 1, ready: 0, blocked: 0, todo: 0, review: 0, done7d: 3 },
    }],
    edges: [{ a: "hermes", b: "ops", handoffs: 1, comments: 2, links: 3 }],
  };
  // Fields the types do not list: a copy built from a list of fields to keep leaves them behind too.
  const wide = {
    ...snapshot,
    config: { api_key: `${MARK}-top-config` },
    profiles: snapshot.profiles.map(p => ({ ...p, config: { api_key: `${MARK}-config` } })),
    edges: snapshot.edges.map(e => ({ ...e, note: `${MARK}-edge` })),
  };
  const copy = keepProfiles(wide);
  expect(JSON.stringify(copy)).not.toContain(MARK);

  const { fs, files } = memory();
  const cache = diskCache(fs, ROOT, () => true);
  cache.save("mac", "profiles", copy);
  await flush(cache);
  expect([...files.values()].join("")).not.toContain(MARK);

  expect(copy.edges).toEqual(snapshot.edges);
  const [profile] = copy.profiles;
  expect(profile).toMatchObject({ id: "hermes", model: "m", provider: "p", description: "", skills: [{ name: "tdd" }] });
  expect(profile?.jobs[0]).toMatchObject({ id: "j1", name: "nightly", schedule: "0 3 * * *", enabled: true, last: "l", status: "ok", prompt: "" });
  expect(profile?.usage).toMatchObject({ sessions7d: 2, busy: 1, daily: [1, 2], sources: { cli: 2 }, recent: [] });
  expect(profile?.gateway).toEqual(snapshot.profiles[0]?.gateway ?? null);
  expect(profile?.load).toEqual({ running: 1, ready: 0, blocked: 0, todo: 0, review: 0, done7d: 3 });
});

test("a board copy keeps card titles, metadata and two fresh layout flags, and no card text, blocked reason, error, token or other config", () => {
  const read: BoardRead = {
    board: "default", token: "tok-1", profiles: ["hermes"],
    // Even the two kept keys never carry their own value over: a marker in auto_decompose must not reach the copy.
    config: {
      lane_by_profile: "off", auto_decompose: `${MARK}-auto`, orchestrator_profile: `${MARK}-orch`,
      default_assignee: `${MARK}-assignee`, dispatch: `${MARK}-config`,
    },
    boards: [{ slug: "default", name: "Default", archived: false, counts: { todo: 1 } }],
    tasks: [{
      id: "t1", title: "Fix it", status: "blocked", priority: 2, createdAt: 10, assignee: "hermes", comments: 1,
      text: `${MARK}-body`, reason: `${MARK}-reason`, lastError: `${MARK}-error`,
    }],
  };
  const copy = keepBoard({ ...read, tasks: read.tasks.map(card => ({ ...card, secret: `${MARK}-extra` })) });
  expect(JSON.stringify(copy)).not.toContain(MARK);
  expect(copy).toEqual({
    board: "default", token: null, profiles: ["hermes"], config: { lane_by_profile: "false", auto_decompose: "true" }, boards: read.boards,
    tasks: [{ id: "t1", title: "Fix it", status: "blocked", priority: 2, createdAt: 10, assignee: "hermes", comments: 1 }],
  });
});

test("the two layout flags follow the view's rule: off only for false, no, off or 0, and unset is on", () => {
  const flags = (config: Record<string, string>) => keepBoard({ board: "b", token: null, profiles: [], boards: [], tasks: [], config }).config;
  expect(flags({})).toEqual({ lane_by_profile: "true", auto_decompose: "true" });
  for (const off of ["false", "No", "OFF", "0"]) {
    expect(flags({ lane_by_profile: off, auto_decompose: off })).toEqual({ lane_by_profile: "false", auto_decompose: "false" });
  }
  for (const on of ["true", "yes", "1", "x", ""]) {
    expect(flags({ lane_by_profile: on, auto_decompose: on })).toEqual({ lane_by_profile: "true", auto_decompose: "true" });
  }
});

test("a chat copy is the profile chips and nothing of any thread", () => {
  const profiles = [{ id: "hermes", live: true, title: `${MARK}-title` }, { id: "ops", live: false }];
  expect(keepChat(profiles)).toEqual({ profiles: [{ id: "hermes", live: true }, { id: "ops", live: false }] });
});

test("an inspector copy keeps skill and plugin rows, and no path, text, setting, env name or checksum", () => {
  const detail: Detail = {
    home: `/home/${MARK}/.hermes`, sksum: `${MARK}-sk`, cfgsum: `${MARK}-cfg`, disabled: [`${MARK}-off`], platformDisabled: { cli: [`${MARK}-cli`] }, at: 5,
    skills: [{
      name: "tdd", rdir: `${MARK}-rdir`, category: "research", tier: 2, path: `/home/${MARK}/SKILL.md`, source: "local", owner: `${MARK}-owner`,
      enabled: true, platformOff: [`${MARK}-plat`], lastUsed: 99, uses: 4, description: `${MARK}-desc`, verdict: `${MARK}-verdict`, readOnly: null,
    }],
    plugins: [{
      key: `${MARK}/key`, name: "memory", version: "1.0", description: `${MARK}-pdesc`, origin: "user", kind: "tool", status: "enabled",
      tools: [`${MARK}-tool`], hooks: [`${MARK}-hook`], skills: 2, settings: [["token", `${MARK}-secret`]], env: [`${MARK}_ENV`],
      source: `${MARK}-src`, namespace: `${MARK}-ns`, readOnly: null,
    }],
  };
  const copy = keepDetail(detail);
  expect(JSON.stringify(copy)).not.toContain(MARK);
  expect(copy.at).toBe(5);
  // The category and the use count are plain metadata, so a restored skill lands in its own group with the real count.
  expect(copy.skills[0]).toMatchObject({ name: "tdd", source: "local", tier: 2, enabled: true, lastUsed: 99, category: "research", uses: 4 });
  expect(copy.plugins[0]).toMatchObject({ name: "memory", status: "enabled" });
  // Every switch stays off while the copy shows, and no row points at a real file or plugin key.
  expect(copy.skills[0]?.readOnly).toBeTruthy();
  expect(copy.plugins[0]?.readOnly).toBeTruthy();
  expect(copy.skills[0]?.path.startsWith("cached:")).toBe(true);
  expect(copy.plugins[0]?.key.startsWith("cached:")).toBe(true);
});

// The views around the cache. ui.ts and the Kanban view import the Obsidian runtime, which bun does not have.
// bun shares one module registry across test files, so every "obsidian" mock declares the same names (see chat.test.ts, inspect.test.ts):
// this file comes first, so its mock has to name everything a view of any file needs.
const modals: unknown[] = [];
const notices: string[] = [];
await mock.module("obsidian", () => ({
  ItemView: class {
    app = { workspace: { requestSaveLayout: () => undefined } };
    getState() { return {}; }
    setState() { return Promise.resolve(); }
    onClose() { return Promise.resolve(); }
    registerInterval() { return 0; }
  },
  Modal: class { constructor(public app: unknown) { /* stub */ } open() { modals.push(this); } close() { /* stub */ } setTitle() { /* stub */ } },
  Component: class {},
  AbstractInputSuggest: class {},
  FuzzySuggestModal: class {},
  Menu: class {},
  Setting: class {},
  SuggestModal: class {},
  Notice: class { constructor(text: string) { notices.push(text); } },
  setIcon: () => undefined,
  setTooltip: () => undefined,
  parseYaml: () => ({}),
  MarkdownRenderer: { render: () => undefined },
}));
const { HermesView } = await import("../src/hermes/ui");
const { KanbanView } = await import("../src/hermes/kanban-view");
const { openCreate } = await import("../src/hermes/kanban-drawer");

/** Answers every property read and call with itself, so the view can "draw" into it. */
const el: unknown = new Proxy(function () { /* stub */ }, { get: () => el, apply: () => el });

class View extends HermesView {
  log: string[] = [];
  pulls: string[] = [];
  data: string | null = null;
  gate: Promise<void> = Promise.resolve();
  key = "k";
  constructor() {
    super({} as never, { cache: { load: () => Promise.resolve(null), save: () => undefined } } as never, 0);
    Object.assign(this, { toolbar: el, tools: el, body: el, stamp: el, refreshButton: el });
  }
  at(alias: string): void { this.alias = alias; }
  go(): Promise<void> { return this.reload(); }
  getViewType(): string { return "test"; }
  getDisplayText(): string { return "Test"; }
  protected async pull(alias: string): Promise<string | null> { this.pulls.push(alias); await this.gate; this.data = alias; return null; }
  protected render(): void { this.log.push(`render:${this.data}`); }
  protected override empty(name: string): void { this.log.push(`empty:${name}`); }
  protected override cacheKey(): string { return this.key; }
  protected override cacheData(): unknown { return this.data; }
  protected override cacheRestore(saved: unknown): boolean {
    this.log.push(`restore:${String(saved)}`);
    this.data = typeof saved === "string" ? saved : null;
    return this.data !== null;
  }
  protected override leaveHost(): void { this.log.push("leave"); }
}

test("a host change drops the old host's state at once, before the new host is pulled", async () => {
  const view = new View();
  view.at("a");
  await view.go();
  expect(view.data).toBe("a");
  view.log.length = 0;
  view.at("b");
  const pending = view.go();
  // Synchronously: a click right after the switch finds nothing of host a (no drawer, selection or read).
  expect(view.log).toEqual(["leave", "restore:null", "empty:loader"]);
  expect(view.data).toBeNull();
  await pending;
  expect(view.pulls).toEqual(["a", "b"]);
  expect(view.data).toBe("b");
});

test("a new key on the same host is not a host change", async () => {
  const view = new View();
  view.at("a");
  await view.go();
  view.log.length = 0;
  view.key = "k2";
  const pending = view.go();
  expect(view.log).toEqual([]);
  await pending;
  expect(view.log).not.toContain("leave");
});

test("a closed view starts no ssh read and paints nothing", async () => {
  const view = new View();
  view.at("a");
  let release = (): void => undefined;
  view.gate = new Promise<void>(resolve => { release = resolve; });
  const pending = view.go();
  // A second reload mid-pull queues one more pull for after this one.
  void view.go();
  await new Promise(resolve => setImmediate(resolve));
  expect(view.pulls).toEqual(["a"]);
  await view.onClose();
  release();
  await pending;
  expect(view.log).not.toContain("render:a");
  // A poll or a host change after close touches neither the disk, the screen nor the host.
  view.log.length = 0;
  view.at("b");
  await view.go();
  expect(view.log).toEqual([]);
  expect(view.pulls).toEqual(["a"]);
});

// The Kanban view, real (render and reload are stubbed: there is no DOM), over a client that only records what it is asked to send.
/** The private corner of a KanbanView these tests reach into. */
interface Kanban {
  alias: string; key: string; read: BoardRead | null; drawer: unknown; dirty: string | null;
  render(): void; reload(): Promise<void>; onClose(): Promise<void>;
  pull(alias: string): Promise<string | null>;
  drop(ids: string[], to: string): Promise<void>;
  assign(cards: BoardRead["tasks"], profile: string | null): Promise<void>;
  nudge(): Promise<void>;
  taskHost(): TaskHost;
}

const MOVED = "The SSH host changed; open it again.";
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** A promise the test settles by hand. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>(resolve => { open = resolve; });
  return { wait, open };
}

const boardOf = (ids: string[], status: BoardRead["tasks"][number]["status"] = "ready"): BoardRead => ({
  board: "ops", token: null, profiles: ["p"], config: {}, boards: [{ slug: "ops", name: "ops", archived: false, counts: {} }],
  tasks: ids.map(id => ({ id, title: id, status, priority: 0, createdAt: 1, comments: 0 })),
});

/** The dialog opened last: the AskModal keeps its form as `ask`. */
function dialog(): Ask {
  const modal = modals.at(-1) as { ask: Ask } | undefined;
  if (!modal) throw new Error("no dialog is open");
  return modal.ask;
}

/** A view on host A showing board ops, and the calls its client gets, as "verb alias/board ids". */
function kanban(gates: { board?: Promise<void>; diagnostics?: Promise<void>; bulk?: Promise<void> } = {}): { view: Kanban; calls: string[] } {
  const calls: string[] = [];
  const { board: boardGate = Promise.resolve(), diagnostics: diagGate = Promise.resolve(), bulk: bulkGate = Promise.resolve() } = gates;
  const host = {
    kanban: {
      board: async () => { calls.push("board"); await boardGate; return boardOf(["t1", "t2"]); },
      diagnostics: async () => { calls.push("diagnostics"); await diagGate; return { t1: [{ id: "d1" }] }; },
      bulk: async (alias: string, slug: string, verbs: { id: string }[]) => {
        calls.push(`bulk ${alias}/${slug} ${verbs.map(v => v.id).join(",")}`);
        await bulkGate;
        return Object.fromEntries(verbs.map(v => [v.id, { ok: true }]));
      },
      nudge: (alias: string, slug: string) => { calls.push(`nudge ${alias}/${slug}`); return Promise.resolve({ ok: true, text: "" }); },
      run: (alias: string, slug: string, v: { verb: string; id: string }) => { calls.push(`run ${alias}/${slug} ${v.verb} ${v.id}`); return Promise.resolve({ ok: true }); },
      create: (alias: string, slug: string, task: { title: string }) => {
        calls.push(`create ${alias}/${slug} ${task.title}`);
        return Promise.resolve({ ok: true, id: "t_new" });
      },
    },
    board: () => "ops", saveBoard: () => undefined, servers: () => ["A", "B"],
  };
  const view = new KanbanView({} as never, host as never) as unknown as Kanban;
  view.render = () => undefined;
  view.reload = () => Promise.resolve();
  view.alias = "A"; view.key = "A|ops"; view.read = boardOf(["t_old"]);
  modals.length = 0;
  notices.length = 0;
  return { view, calls };
}

/** The host changes to B and B's board lands: what the view holds once enter() and its first pull are done. */
const switchToB = (view: Kanban): void => { view.alias = "B"; view.key = "B|ops"; view.read = boardOf(["t_b1", "t_b2"]); };

/** One board pull on a view with a task drawer open; `closeAt` closes the view while the board read or the diagnostics read is in flight. */
async function pulled(closeAt?: "board" | "diagnostics"): Promise<{ calls: string[]; renders: number }> {
  const board = gate(), diagnostics = gate();
  const { view, calls } = kanban({ board: board.wait, diagnostics: diagnostics.wait });
  let renders = 0;
  view.render = () => { renders++; };
  view.drawer = { id: "t1", refresh: () => { calls.push("drawer"); return Promise.resolve(); }, close: () => undefined };
  view.dirty = "t1";
  const pulling = view.pull("A");
  if (closeAt === "board") await view.onClose();
  board.open();
  await pulling;
  if (closeAt === "diagnostics") await view.onClose();
  diagnostics.open();
  await tick();
  return { calls, renders };
}

test("a Kanban view closed mid-pull starts no further ssh read and paints nothing", async () => {
  // Control: left open, the board read leads to the diagnostics read and a drawer refresh, and its answer to a second refresh and a paint.
  const open = await pulled();
  expect(open.calls).toEqual(["board", "diagnostics", "drawer", "drawer"]);
  // Closed while the board read is in flight: nothing after it.
  expect(await pulled("board")).toEqual({ calls: ["board"], renders: 0 });
  // Closed while the diagnostics read is in flight: its answer neither refreshes the drawer nor paints.
  const late = await pulled("diagnostics");
  expect(late.calls).toEqual(["board", "diagnostics", "drawer"]);
  expect(late.renders).toBe(open.renders - 1);
});

/** A reassign whose answer comes back after the view is closed, or not; resolves to the number of paints. */
async function reassigned(close: boolean): Promise<number> {
  const bulk = gate();
  const { view } = kanban({ bulk: bulk.wait });
  let renders = 0;
  view.render = () => { renders++; };
  const moving = view.assign(view.read?.tasks ?? [], "p");
  if (close) await view.onClose();
  bulk.open();
  await moving;
  return renders;
}

test("a Kanban view closed while a move is in flight does not paint its answer", async () => {
  expect(await reassigned(false)).toBe(2); // the paint before the call, and the answer's
  expect(await reassigned(true)).toBe(1);
});

/** Opens a dialog on host A with `open`, then (unless `stay`) the host changes to B, then the dialog is answered. */
async function answered(open: (view: Kanban) => Promise<void>, stay = false): Promise<{ calls: string[]; reply: string | null; notices: string[] }> {
  const { view, calls } = kanban();
  const opened = open(view);
  await tick();
  if (!stay) switchToB(view);
  const reply = await dialog().submit({ summary: "", result: "", kind: "needs_input", reason: "why" });
  dialog().closed?.();
  await opened;
  return { calls, reply, notices: [...notices] };
}

test("a dialog opened on one SSH host and answered on another sends nothing and says so", async () => {
  const complete = (view: Kanban): Promise<void> => view.drop(["t_old"], "done");
  const block = (view: Kanban): Promise<void> => view.drop(["t_old"], "blocked");
  const archive = (view: Kanban): Promise<void> => view.drop(["t_old"], "archived");
  const reassign = (view: Kanban): Promise<void> => {
    view.read = boardOf(["t_old"], "running");
    return view.assign(view.read.tasks, "p");
  };
  const nudge = (view: Kanban): Promise<void> => view.nudge();
  // Control: answered on the host it was opened on, each one sends.
  for (const open of [complete, block, archive, reassign]) expect((await answered(open, true)).calls).toEqual(["bulk A/ops t_old"]);
  expect((await answered(nudge, true)).calls).toEqual(["nudge A/ops"]);
  // Answered on host B: a form shows why, a confirm closes quietly, the nudge says so in a notice.
  for (const open of [complete, block]) expect(await answered(open)).toEqual({ calls: [], reply: MOVED, notices: [] });
  for (const open of [archive, reassign]) expect(await answered(open)).toEqual({ calls: [], reply: null, notices: [] });
  expect(await answered(nudge)).toEqual({ calls: [], reply: null, notices: [MOVED] });
});

test("the new-task form and the drawer, kept from one SSH host, write nothing on another", async () => {
  const written = async (stay: boolean): Promise<{ calls: string[]; form: string | null; comment: string | null }> => {
    const { view, calls } = kanban();
    const host = view.taskHost();
    openCreate(host, "ready", undefined, () => undefined);
    if (!stay) switchToB(view);
    const form = await dialog().submit({ title: "x", workspace: "scratch" });
    return { calls, form, comment: await host.write({ verb: "comment", id: "t_old", text: "hi" }) };
  };
  expect(await written(true)).toEqual({ calls: ["create A/ops x", "run A/ops comment t_old"], form: null, comment: null });
  expect(await written(false)).toEqual({ calls: [], form: MOVED, comment: MOVED });
});
