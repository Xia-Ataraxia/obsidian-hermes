import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { evaluate } from "./control-center-gui";
import { FixtureRefusal, ownedPath } from "./fixture-guard";

const root = "/private/tmp/hermes-control-center-m1-01a161c0/task-20/gui";
const session = JSON.parse(readFileSync(ownedPath(`${root}/session.json`), "utf8"));
const before = await evaluate("return {vault:app.vault.adapter.basePath,active:document.activeElement?.getAttribute('aria-label'),value:document.activeElement?.value};");
if (typeof before !== "object" || before === null || !("active" in before) || before.active !== "활동 보드" || session.pid !== 87597) throw new FixtureRefusal("expected bound board selector and owned GUI PID");
const script = `tell application "System Events"
set frontProcess to first application process whose frontmost is true
if unix id of frontProcess is not 87597 then error "Unexpected frontmost process"
key code 49
delay 0.2
key code 125
key code 36
end tell`;
const native = execFileSync("/usr/bin/osascript", ["-e", script], {encoding:"utf8",timeout:5000});
const after = await evaluate("return {board:document.querySelector('select[aria-label=\"활동 보드\"]')?.value,text:document.body.innerText};");
const result = {before,native,after};
writeFileSync(ownedPath(`${root}/native-board-menu.json`),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
if (typeof after !== "object" || after === null || !("board" in after) || after.board !== "default") throw new FixtureRefusal("native selection did not select default");
