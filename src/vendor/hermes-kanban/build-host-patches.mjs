import ts from "typescript";
import { orchestrationPatches } from "./build-orchestration-patches.mjs";

function once(source, from, to) {
  if (source.split(from).length !== 2) throw new Error(`Host patch mismatch: ${from.slice(0, 70)}`);
  return source.replace(from, to);
}

export function hostPatches(input) {
  let source = orchestrationPatches(input);
  const start = source.indexOf("    // --- WebSocket ---");
  const end = source.indexOf("    // --- filtering ---", start);
  if (start < 0 || end < 0) throw new Error("Native watch effect boundary changed");
  source = source.slice(0, start) + `    useEffect(function () {
      if (!boardData) return undefined;
      return SDK.watch({ board: board || "default", since: cursorRef.current || 0,
        onRefresh: function () {
          loadBoard();
          const selected = selectedTaskRef.current;
          if (selected) setTaskEventTick(function (previous) {
            return Object.assign({}, previous, { [selected]: (previous[selected] || 0) + 1 });
          });
        },
        onFailure: function (error) { setError(error.message); },
        onEvents: function (batch) {
          cursorRef.current = batch.cursor;
        }
      });
    }, [!!boardData, board, loadBoard]);

` + source.slice(end);
  for (const [from, to] of [
    ['const [selectedTaskId, setSelectedTaskId] = useState(null);', 'const [selectedTaskId, setSelectedTaskId] = useState(null);\n    const selectedTaskRef = useRef(selectedTaskId);\n    selectedTaskRef.current = selectedTaskId;'],
    ['const resolverRef = React.useRef(null);', 'const resolverRef = React.useRef(null);\n    React.useEffect(function () { return function () { if (resolverRef.current) resolverRef.current({ confirmed: false }); resolverRef.current = null; }; }, []);'],
    ['resolverRef.current = resolve;', 'if (resolverRef.current) resolverRef.current({ confirmed: false });\n        resolverRef.current = resolve;'],
    ['function move(ev) {', 'function move(ev) {\n        if (ev.pointerId !== e.pointerId) return;'],
    ['function up() {', 'function up(ev) {\n        if (ev.pointerId !== e.pointerId) return;'],
    ['if (lastTarget) {\n          lastTarget.classList.remove', 'if (lastTarget && ev.type === "pointercancel") lastTarget.classList.remove("hermes-kanban-column--drop");\n        if (lastTarget && ev.type !== "pointercancel") {\n          lastTarget.classList.remove'],
    ["const requestCompletionSummary = useCallback(function (count)", "const requestCompletionSummary = useCallback(async function (count)"],
    ["var summary = window.prompt(", "var summary = await host.prompt("],
    ["function applyPatch(patch) {", "async function applyPatch(patch) {"],
    ["const finalPatch = withCompletionSummary(patch);", "const finalPatch = await withCompletionSummary(patch);"],
    ["function withCompletionSummary(patch) {", "async function withCompletionSummary(patch) {"],
    ["const value = window.prompt(", "const value = await host.prompt("],
    ['window.prompt("Copy this command:", cmd);', 'void host.prompt("Copy this command:", cmd);'],
    [", reclaim_first: reclaimFirst", ""],
    ['const b = function (label, patch, enabled, confirmMsg) {', 'const b = function (label, patch, enabled, confirmMsg) {\n      if (patch.status === "archived") return null;'],
    ['const specifyButton = (task.status === "triage" && props.onSpecify)', 'const specifyButton = false'],
    ['const decomposeButton = (task.status === "triage" && props.onDecompose)', 'const decomposeButton = false'],
    ['disabled: isBusy || !props.onToggle,', 'disabled: true,'],
    ['const { action, onExec, busy, extra } = props;', 'const { action, onExec, busy, extra } = props;\n    if (action.kind === "reclaim" || action.kind === "reassign") return null;'],
    ['return a.kind === "reassign";', 'return false;'],
    ['href: (action.payload && action.payload.url) || "#",', 'href: host.safeLink(action.payload && action.payload.url),'],
  ]) source = once(source, from, to);
  source = once(source, 'const [selectedIds, setSelectedIds] = useState(() => new Set());', `const [selectedIds, setSelectedIds] = useState(() => new Set());
    const bulkTarget = useRef({ board, selectedIds, generation: 0 });
    if (bulkTarget.current.board !== board || bulkTarget.current.selectedIds !== selectedIds) {
      bulkTarget.current = { board, selectedIds, generation: bulkTarget.current.generation + 1 };
    }
    useEffect(function () { return function () { bulkTarget.current.generation++; }; }, []);`);
  const bulkStart = source.indexOf("    const applyBulk = useCallback(");
  const bulkEnd = source.indexOf("    // --- board switching", bulkStart);
  if (bulkStart < 0 || bulkEnd < 0) throw new Error("Native bulk callback boundary changed");
  let bulk = source.slice(bulkStart, bulkEnd);
  bulk = once(bulk, `      const count = selectedIds.size;
      const run = function () {
        const finalPatch = patch;`, `      const operationIds = new Set(selectedIds);
      const operationBoard = board;
      const generation = ++bulkTarget.current.generation;
      const count = operationIds.size;
      const run = async function () {
        if (generation !== bulkTarget.current.generation) return;
        let finalPatch = patch;
        if (patch.status === "done") {
          const completion = await requestCompletionSummary(count);
          if (!completion.confirmed || generation !== bulkTarget.current.generation) return;
          finalPatch = Object.assign({}, patch, { result: completion.summary, summary: completion.summary });
        }`);
  for (const [from, to] of [
    ["Array.from(selectedIds)", "Array.from(operationIds)"],
    ["selectedIds.has(t.id)", "operationIds.has(t.id)"],
    ['withBoard(`${API}/tasks/bulk`, board)', 'withBoard(`${API}/tasks/bulk`, operationBoard)'],
    [".then(function (res) {", ".then(function (res) {\n            if (generation !== bulkTarget.current.generation) return;"],
    [".catch(function (e) {", ".catch(function (e) {\n            if (generation !== bulkTarget.current.generation) return;"],
    ["setFailedIds(new Set(selectedIds));", "setFailedIds(new Set(operationIds));"],
    ["        run();", "        run().catch(function () { /* dialog cancelled */ });"],
    ["if (r.confirmed) run();", "if (r.confirmed) return run();"],
    ["[selectedIds, loadBoard, board, t, kanbanDialogs]", "[selectedIds, loadBoard, board, t, kanbanDialogs, requestCompletionSummary]"],
  ]) bulk = once(bulk, from, to);
  source = source.slice(0, bulkStart) + bulk + source.slice(bulkEnd);
  source = source.replaceAll('window.alert(tx(', 'host.notice(tx(');
  source = source.replaceAll('`${startX - el.offsetWidth / 2}px`', '`${startX - document.body.getBoundingClientRect().left - el.offsetWidth / 2}px`');
  source = source.replaceAll('`${startY - 24}px`', '`${startY - document.body.getBoundingClientRect().top - 24}px`');
  source = source.replaceAll('`${ev.clientX - proxy.offsetWidth / 2}px`', '`${ev.clientX - document.body.getBoundingClientRect().left - proxy.offsetWidth / 2}px`');
  source = source.replaceAll('`${ev.clientY - 24}px`', '`${ev.clientY - document.body.getBoundingClientRect().top - 24}px`');

  const tree = ts.createSourceFile("native.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "h") {
      const kind = node.arguments[0]?.getText(tree);
      const props = node.arguments[1]?.getText(tree) ?? "";
      const children = node.arguments.slice(2).map(child => child.getText(tree)).join(" ");
      const excludedComponent = ["TrashDropZone", "NewBoardDialog", "BoardSettingsDialog"].includes(kind);
      const excludedControl = ["Button", '"button"', '"input"', '"label"'].includes(kind) && (
        /props\.on(NewClick|SettingsClick|Unbind|NudgeDispatch|Delete|Upload)|props\.homeToggle/.test(props) ||
        /hermes-kanban-bulk-reclaim-first|type: "file"/.test(props) ||
        /tx\(\w+, "(archive|delete|newBoard|boardSettings|addFiles|uploadFile)"/.test(children));
      if (excludedComponent || excludedControl) { edits.push([node.getStart(tree), node.end, "null"]); return; }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) source = source.slice(0, start) + replacement + source.slice(end);
  if (edits.length < 15) throw new Error("Excluded-control inventory unexpectedly changed");
  return source;
}
