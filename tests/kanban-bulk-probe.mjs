import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { factorySource, SOURCE_PINS, PRIMITIVES } from "../src/vendor/hermes-kanban/build-factory.mjs";

export async function bulkProbe(scenario) {
  const vendor = new URL("../src/vendor/hermes-kanban/", import.meta.url);
  const files = Object.fromEntries(Object.keys(SOURCE_PINS).map(name => [name, readFileSync(new URL(name, vendor), "utf8")]));
  const source = factorySource(files, JSON.parse(readFileSync(new URL("provenance.json", vendor), "utf8")));
  const directory = mkdtempSync(join(tmpdir(), "kanban-bulk-"));
  const slots = [], effects = [], calls = [], prompts = [], notices = [], reads = [];
  let index = 0, tree, connect;
  const hooks = {
    useState(initial) { const slot = index++; if (!(slot in slots)) slots[slot] = typeof initial === "function" ? initial() : initial; return [slots[slot], value => { slots[slot] = typeof value === "function" ? value(slots[slot]) : value; }]; },
    useRef(initial) { const slot = index++; return slots[slot] ??= { current: initial }; },
    useCallback(value, dependencies) { const slot = index++; const old = slots[slot]; if (!old || dependencies.some((item, i) => item !== old.dependencies[i])) slots[slot] = { dependencies, value }; return slots[slot].value; },
    useMemo(value) { return value(); },
    useEffect(effect, dependencies) { const slot = index++; const old = slots[slot]; if (!old || dependencies.some((value, i) => value !== old.dependencies[i])) { slots[slot] = { dependencies }; effects.push(() => { old?.cleanup?.(); slots[slot].cleanup = effect(); }); } },
  };
  let boardData = { columns: [{ name: "ready", tasks: [{ id: "one", title: "One", status: "ready" }, { id: "two", title: "Two", status: "ready" }] }, { name: "done", tasks: [] }], tenants: [], assignees: [] };
  let response;
  const SDK = {
    React: { ...React, ...hooks }, hooks,
    components: Object.fromEntries(PRIMITIVES.map(name => [name, "div"])),
    utils: { cn: (...values) => values.filter(Boolean).join(" "), timeAgo: () => "now" },
    watch: () => () => {}, view: { connect(fn) { connect = fn; return () => {}; }, selected() {} },
    fetchJSON(path, init) {
      if (init?.method === "POST") { calls.push({ path, body: JSON.parse(init.body) }); return new Promise((resolve, reject) => { response = { resolve, reject }; }); }
      reads.push(path);
      if (path.includes("/config")) return Promise.resolve({ lane_by_profile: false });
      if (path.includes("/boards")) return Promise.resolve({ boards: [{ slug: "default" }, { slug: "other" }] });
      return Promise.resolve(boardData);
    },
    authedFetch() { throw Error("Unexpected attachment"); }, buildWsUrl() { throw Error("Unexpected socket"); },
  };
  const host = { window: { localStorage: { getItem: () => "default", setItem() {} }, addEventListener() {}, removeEventListener() {} }, document: {}, setTimeout, clearTimeout,
    prompt(label) { return new Promise(resolve => prompts.push({ label, resolve })); }, notice(message) { notices.push(message); } };
  try {
    const modulePath = join(directory, "factory.mjs"); writeFileSync(modulePath, source);
    const Page = (await import(pathToFileURL(modulePath).href)).createNativeKanban(SDK, host);
    const render = () => { index = 0; tree = Page(); while (effects.length) effects.shift()(); };
    const find = (node, name) => { if (!React.isValidElement(node)) return null; if (node.type.name === name) return node; for (const child of React.Children.toArray(node.props.children)) { const match = find(child, name); if (match) return match; } return null; };
    const part = name => { const node = find(tree, name); assert.ok(node, `Missing ${name}`); return node.props; };
    const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); render(); };
    const snapshot = () => ({ selected: [...part("BoardColumns").selectedIds], tasks: part("BoardColumns").board.columns.map(c => [c.name, c.tasks.map(t => t.id)]), failed: [...part("BoardColumns").failedIds] });
    render(); await settle(); await settle();
    part("BoardColumns").toggleSelected("one", true); render(); part("BoardColumns").toggleSelected("two", true); render();
    const before = snapshot(); assert.deepEqual(before.selected, ["one", "two"]);
    const apply = () => { part("BulkActionBar").onApply({ status: "done" }, "Mark 2 tasks as done?"); render(); };
    apply(); assert.equal(calls.length, 0); assert.equal(prompts.length, 0); assert.equal(part("KanbanDialogs").dialogProps.confirmLabel, "Apply");
    if (scenario === "cancel-confirm") { part("KanbanDialogs").dialogProps.onCancel(); await settle(); assert.deepEqual(snapshot(), before); assert.equal(calls.length, 0); assert.equal(prompts.length, 0); }
    else {
      part("KanbanDialogs").dialogProps.onConfirm(); await settle();
      assert.equal(prompts.length, 1, "Complete must collect summary after Apply and before transport"); assert.equal(calls.length, 0); assert.deepEqual(snapshot(), before);
      if (["cancel-summary", "blank"].includes(scenario)) { prompts[0].resolve(scenario === "blank" ? " \n " : null); await settle(); assert.equal(calls.length, 0); assert.deepEqual(snapshot(), before); assert.equal(notices.length, scenario === "blank" ? 1 : 0); }
      else if (["selection", "board", "unmount", "overlap"].includes(scenario)) {
        if (scenario === "selection") { part("BoardColumns").toggleSelected("one", true); render(); }
        if (scenario === "board") { connect({ board: "other", taskId: null }); await settle(); await settle(); }
        if (scenario === "unmount") for (const slot of slots) slot?.cleanup?.();
        if (scenario === "overlap") { apply(); part("KanbanDialogs").dialogProps.onConfirm(); await settle(); assert.equal(prompts.length, 2); }
        const current = scenario === "unmount" ? null : snapshot(); prompts[0].resolve("stale summary"); await settle(); assert.equal(calls.length, 0); if (current) assert.deepEqual(snapshot(), current);
        if (scenario === "overlap") { prompts[1].resolve("latest summary"); await settle(); assert.equal(calls.length, 1); assert.equal(calls[0].body.summary, "latest summary"); }
      } else {
        prompts[0].resolve("  Delivered <script>not executable</script>  "); await settle();
        assert.deepEqual(calls, [{ path: "/api/plugins/kanban/tasks/bulk?board=default", body: { ids: ["one", "two"], status: "done", summary: "Delivered <script>not executable</script>", result: "Delivered <script>not executable</script>" } }]);
        assert.deepEqual(snapshot().tasks, [["ready", []], ["done", ["one", "two"]]]);
        if (scenario === "response-stale") { part("BoardColumns").toggleSelected("one", true); render(); const changed = snapshot(); response.resolve({ results: [{ id: "one", ok: true }, { id: "two", ok: true }] }); await settle(); assert.deepEqual(snapshot(), changed); }
        else if (scenario === "transport-error") { response.reject(Error("Denied")); await settle(); assert.deepEqual(snapshot().selected, ["one", "two"]); assert.deepEqual(snapshot().failed, ["one", "two"]); assert.deepEqual(snapshot().tasks, before.tasks); }
        else {
          const mixed = scenario === "mixed";
          boardData = { ...boardData, columns: [{ name: "ready", tasks: mixed ? [{ id: "two", status: "ready" }] : [] }, { name: "done", tasks: [{ id: "one", status: "done" }, ...(mixed ? [] : [{ id: "two", status: "done" }])] }] };
          const readCount = reads.length; response.resolve({ results: [{ id: "one", ok: true }, mixed ? { id: "two", ok: false, error: "Native refusal" } : { id: "two", ok: true }] }); await settle(); await settle();
          assert.equal(reads.length, readCount + 1, "Native response triggers authoritative board readback"); assert.deepEqual(snapshot().selected, []); assert.deepEqual(snapshot().failed, mixed ? ["two"] : []); assert.deepEqual(snapshot().tasks, mixed ? [["ready", ["two"]], ["done", ["one"]]] : [["ready", []], ["done", ["one", "two"]]]);
        }
      }
    }
    console.log(JSON.stringify({ scenario, calls, prompts: prompts.map(p => p.label), notices, after: snapshot() }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
