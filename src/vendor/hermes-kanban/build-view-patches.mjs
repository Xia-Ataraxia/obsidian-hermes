import ts from "typescript";

function once(source, from, to) {
  if (source.split(from).length !== 2) throw new Error(`View patch mismatch: ${from.slice(0, 90)}`);
  return source.replace(from, to);
}
function section(source, name, change) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf("\n  function ", start + 1);
  if (start < 0 || end < 0) throw new Error(`Missing view section: ${name}`);
  return source.slice(0, start) + change(source.slice(start, end)) + source.slice(end);
}

export function viewPatches(input) {
  let source = once(input, "  function KanbanPage() {", `
  const DraftContext = React.createContext({ board: "default" });
  function CreateScope(props) {
    const scope = React.useContext(DraftContext);
    return h(DraftContext.Provider, { value: { board: scope.board, createColumn: props.column } }, props.children);
  }
  function useNativeDraft(field, initial) {
    const scope = React.useContext(DraftContext);
    const [local, localSet] = useState(() => SDK.view ? SDK.view.get(scope, field, initial) : initial);
    const [, redraw] = useState(0);
    useEffect(() => SDK.view ? SDK.view.subscribe(() => redraw(n => n + 1)) : undefined, []);
    const value = SDK.view ? SDK.view.get(scope, field, initial) : local;
    const set = value => { localSet(value); if (SDK.view) SDK.view.edit(scope, field, value); };
    const clear = (...expected) => { if (expected.length && SDK.view && SDK.view.get(scope, field, initial) !== expected[0]) return; localSet(initial); if (SDK.view) SDK.view.clear(scope, field); };
    const unchanged = () => !SDK.view || SDK.view.get(scope, field, value) === value;
    return [value, set, clear, unchanged];
  }
  function DraftNotice() {
    const scope = React.useContext(DraftContext);
    const [, redraw] = useState(0);
    useEffect(() => SDK.view ? SDK.view.subscribe(() => redraw(n => n + 1)) : undefined, []);
    const issue = SDK.view && SDK.view.issue(scope);
    return issue ? h("div", { role: "status", className: "hcv-kanban-draft-notice" }, issue) : null;
  }
  function KanbanPage() {`);
  source = section(source, "KanbanPage", page => {
    page = once(page, "    const cursorRef = useRef(0);", "    const cursorRef = useRef(0);\n    const boardRequest = useRef(0);\n    const boardScope = useRef(board);\n    if (boardScope.current !== board) { boardScope.current = board; boardRequest.current++; }");
    page = once(page, "    const loadBoard = useCallback(() => {", "    const loadBoard = useCallback(() => {\n      const request = ++boardRequest.current;");
    page = once(page, "          setBoardData(data);", "          if (request !== boardRequest.current) return;\n          setBoardData(data);");
    page = once(page, "          setError(String(err && err.message ? err.message : err));", "          if (request === boardRequest.current) setError(String(err && err.message ? err.message : err));");
    page = once(page, ".finally(function () { setLoading(false); });", ".finally(function () { if (request === boardRequest.current) setLoading(false); });");
    page = once(page, "      setBoardData(null);", "      setBoardData(null);\n      setSelectedTaskId(null);");
    page = once(page, "    }, [board, clearSelected]);", `    }, [board, clearSelected]);
    useEffect(function () {
      if (!SDK.view) return undefined;
      return SDK.view.connect(function (target) {
        switchBoard(target.board);
        setSelectedTaskId(target.taskId);
      }, function () {
        loadBoard();
        const selected = selectedTaskRef.current;
        if (selected) setTaskEventTick(previous => Object.assign({}, previous, { [selected]: (previous[selected] || 0) + 1 }));
      });
    }, [board, loadBoard, switchBoard]);
    useEffect(function () { if (SDK.view) SDK.view.selected(board || "default"); }, [board]);`);
    const tree = ts.createSourceFile("page.js", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const edits = [];
    function visit(node) {
      if (ts.isReturnStatement(node) && node.expression && node.parent === tree.statements[0].body) {
        edits.push([node.expression.getStart(tree), node.expression.end, `h(DraftContext.Provider, { value: { board: board || "default" } }, ${node.expression.getText(tree)})`]);
      }
      if (ts.isCallExpression(node) && node.expression.getText(tree) === "h" && node.arguments[0]?.getText(tree) === "TaskDrawer") {
        edits.push([node.getStart(tree), node.end, `h(DraftContext.Provider, { key: JSON.stringify([board, selectedTaskId]), value: { board: board || "default", taskId: selectedTaskId } }, ${node.getText(tree)})`]);
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    // Nested edits require the outer provider to be applied after the inner drawer.
    const outer = edits.find(edit => edit[2].startsWith("h(DraftContext.Provider, { value"));
    for (const [start, end, replacement] of edits.filter(edit => edit !== outer).sort((a,b) => b[0]-a[0])) page = page.slice(0,start) + replacement + page.slice(end);
    if (!outer) throw new Error("Native page return boundary changed");
    const returnStart = outer[0], returnEnd = page.lastIndexOf(";\n  }");
    page = page.slice(0, returnStart) + 'h(DraftContext.Provider, { value: { board: board || "default" } }, ' + page.slice(returnStart, returnEnd) + ')' + page.slice(returnEnd);
    return page;
  });
  source = section(source, "TaskDrawer", drawer => {
    drawer = once(drawer, "    const load = useCallback(function () {", "    const detailRequest = useRef(0);\n    useEffect(() => () => { detailRequest.current++; }, []);\n    const load = useCallback(function () {\n      const request = ++detailRequest.current;");
    drawer = once(drawer, ".then(function (d) { setData(d);", ".then(function (d) { if (request !== detailRequest.current) return; setData(d);");
    drawer = once(drawer, '.catch(function (e) { setErr(String(e.message || e)); })\n        .finally(function () { setLoading(false); });', '.catch(function (e) { if (request === detailRequest.current && e.code !== "stale-generation") setErr(String(e.message || e)); })\n        .finally(function () { if (request === detailRequest.current) setLoading(false); });');
    drawer = once(drawer, 'const [newComment, setNewComment] = useState("");', 'const [newComment, setNewComment, clearComment] = useNativeDraft("comment", "");');
    drawer = once(drawer, 'setNewComment("");', "clearComment(newComment); setPatchErr(null);");
    drawer = once(drawer, '      }).catch(function (e) { setErr(String(e.message || e)); });\n    };\n\n    // File upload', '      }).catch(function (e) { setPatchErr(parseApiErrorMessage(e)); });\n    };\n\n    // File upload');
    const linksStart = drawer.indexOf("    const addLink = function"), linksEnd = drawer.indexOf("    const toggleHomeSubscription", linksStart);
    if (linksStart < 0 || linksEnd < 0) throw new Error("Native dependency handlers changed");
    const links = drawer.slice(linksStart, linksEnd).replaceAll('load(); props.onRefresh();', 'load(); props.onRefresh(); setPatchErr(null); return true;').replaceAll('setErr(String(e.message || e));', 'setPatchErr(parseApiErrorMessage(e)); return false;');
    drawer = drawer.slice(0, linksStart) + links + drawer.slice(linksEnd);
    drawer = once(drawer, "setErr(null); setPatchErr(null);", "setErr(null);");
    drawer = once(drawer, '.then(function () { load(); props.onRefresh(); })\n          .catch(function (e) { setPatchErr(parseApiErrorMessage(e)); });', '.then(function () { load(); props.onRefresh(); return true; })\n          .catch(function (e) { setPatchErr(parseApiErrorMessage(e)); return false; });');
    drawer = once(drawer, "if (!finalPatch) return Promise.resolve();", "if (!finalPatch) return false;");
    drawer = once(drawer, '        loading ? h("div",', '        h(DraftNotice),\n        patchErr ? h("div", { role: "alert", className: "hcv-kanban-draft-notice" }, patchErr) : null,\n        loading ? h("div",');
    return drawer;
  });
  source = section(source, "TaskDetail", part => once(part, "return props.onPatch({ title: newTitle }).then(function () { props.setEditing(false); });", "return props.onPatch({ title: newTitle });").replace("              onCancel: function () { props.setEditing(false); },", "              onSaved: function () { props.setEditing(false); },\n              onCancel: function () { props.setEditing(false); },"));
  for (const [name, field, initial] of [["TitleEditor", "title", "props.initial"], ["AssigneeEditor", "assignee", 'props.task.assignee || ""'], ["PriorityEditor", "priority", "String(props.task.priority || 0)"], ["BodyEditor", "body", 'props.task.body || ""']]) {
    source = section(source, name, part => {
      part = once(part, `const [v, setV] = useState(${initial});`, `const [v, setV, clearDraft, unchanged] = useNativeDraft("${field}", ${initial});`);
      part = part.replace(`    useEffect(function () { setV(${initial}); }, [props.task.${field}]);\n`, "");
      part = part.replaceAll("then(function () { setEditing(false); })", "then(function (saved) { if (saved && unchanged()) setEditing(false); })");
      if (name === "BodyEditor") part = once(part, 'setEditing(false); setV(props.task.body || "");', "setEditing(false); clearDraft();");
      if (name === "TitleEditor") part = once(part, "props.onSave(trimmed);", "props.onSave(trimmed).then(function (saved) { if (saved && unchanged()) props.onSaved(); });").replace('if (e.key === "Escape") props.onCancel();', 'if (e.key === "Escape") { clearDraft(); props.onCancel(); }').replace('onClick: props.onCancel', 'onClick: function () { clearDraft(); props.onCancel(); }');
      return part;
    });
  }
  source = section(source, "ModelEditor", part => once(part, 'const [freeText, setFreeText] = useState("");', 'const [freeText, setFreeText] = useNativeDraft("model_override", "");').replace("props.onPatch(patch).then(function () {\n        setEditing(false);", "props.onPatch(patch).then(function (saved) {\n        if (saved) setEditing(false);"));
  source = section(source, "DependencyEditor", part => {
    for (const name of ["Parent", "Child"]) {
      part = once(part, `const [new${name}, setNew${name}] = useState("");`, `const [new${name}, setNew${name}, clear${name}] = useNativeDraft("dependency${name}", "");`);
      part = once(part, `then(function () { setNew${name}(""); })`, `then(function (saved) { if (saved) clear${name}(new${name}); })`);
    }
    return part;
  });
  source = section(source, "InlineCreate", part => {
    part = once(part, '    const { t } = useI18n();', '    const { t } = useI18n();\n    const parentScope = React.useContext(DraftContext);\n    const [createError, setCreateError] = useState(null);');
    part = once(part, '        h("div", { className: "hermes-kanban-dialog-title" },', '        createError ? h("div", { role: "alert", className: "hcv-kanban-draft-notice" }, createError) : null,\n        h("div", { className: "hermes-kanban-dialog-title" },');
    for (const name of ["title", "assignee", "priority", "parent", "skills", "workspaceKind", "workspacePath", "goalMode", "goalMaxTurns"]) {
      const pattern = new RegExp(`const \\[${name}, (set\\w+)\\] = useState\\(([^;]+)\\);`);
      if (!pattern.test(part)) throw new Error(`Missing create field: ${name}`);
      part = part.replace(pattern, `const [${name}, $1] = useNativeDraft("${name}", $2);`);
    }
    const start = part.indexOf("      props.onSubmit(body);"), end = part.indexOf('\n    };', start);
    if (start < 0 || end < 0) throw new Error("Native create submit boundary changed");
    return part.slice(0,start) + '      const submitted = { title, assignee, priority, parent, skills, workspaceKind, workspacePath, goalMode, goalMaxTurns };\n      return props.onSubmit(body).then(function (saved) { if (!saved) { setCreateError("Create was not confirmed. Draft retained; inspect the board before retrying."); return; } if (SDK.view) for (const [field, value] of Object.entries(submitted)) { if (SDK.view.get(parentScope, field, value) === value) SDK.view.clear(parentScope, field); } });' + part.slice(end);
  });
  source = once(source, "props.onCreate(body).then(function () { setShowCreate(false); });", "return props.onCreate(body).then(function () { setShowCreate(false); return true; }).catch(function () { return false; });");
  const tree = ts.createSourceFile("create.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "h" && node.arguments[0]?.getText(tree) === "InlineCreate") {
      edits.push([node.getStart(tree), node.end, `h(CreateScope, { column: props.column.name }, ${node.getText(tree)})`]);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (edits.length !== 1) throw new Error("Native create mount boundary changed");
  for (const [start,end,replacement] of edits) source = source.slice(0,start) + replacement + source.slice(end);
  return source;
}
