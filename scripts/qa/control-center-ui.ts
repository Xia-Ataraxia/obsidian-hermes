import { readFileSync, writeFileSync } from "node:fs";
import { evaluate, uiCall } from "./control-center-gui";
import { FixtureRefusal, ownedPath } from "./fixture-guard";

const base = "/private/tmp/hermes-control-center-m1-01a161c0/task-20";
const mode = process.argv[2], arg = process.argv[3];
let result: unknown;
if (mode === "inspect") result = await evaluate(`return {text:document.body.innerText.slice(0,24000),buttons:[...document.querySelectorAll('button,[role=button],[role=option],input,textarea,select')].filter(e=>e.checkVisibility()).map(e=>{const r=e.getBoundingClientRect();return {tag:e.tagName,text:e.innerText?.slice(0,100),label:e.getAttribute('aria-label'),placeholder:e.getAttribute('placeholder'),value:e.value,x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height}}),plugins:{enabled:[...app.plugins.enabledPlugins],manifests:Object.keys(app.plugins.manifests),methods:Object.getOwnPropertyNames(Object.getPrototypeOf(app.plugins))}};`);
else if (mode === "tabs") result = await evaluate("return [...document.querySelectorAll('.workspace-tab-header')].filter(e=>e.checkVisibility()).map(e=>{const close=e.querySelector('.workspace-tab-header-inner-close-button'),r=close?.getBoundingClientRect();return {text:e.innerText,close:r?{x:r.x+r.width/2,y:r.y+r.height/2}:null}});");
else if (mode === "state") result = await evaluate("return {text:document.body.innerText,fields:[...document.querySelectorAll('input,textarea')].filter(e=>e.checkVisibility()).map(e=>({label:e.getAttribute('aria-label'),placeholder:e.getAttribute('placeholder'),value:e.value})),active:document.activeElement?.outerHTML.slice(0,500)};");
else if (mode === "click-text" && arg) {
  const point = await evaluate(`const matches=[...document.querySelectorAll('button,summary,[role=button],[role=option]')].filter(e=>e.checkVisibility()&&(e.innerText.trim()===${JSON.stringify(arg)}||e.getAttribute('aria-label')===${JSON.stringify(arg)}));if(matches.length!==1)throw Error('Expected one observed control, found '+matches.length);const e=matches[0],r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);if(!e.contains(hit))throw Error('Control is occluded');return {x,y};`);
  if (typeof point !== "object" || point === null || !("x" in point) || !("y" in point)) throw new FixtureRefusal("invalid control rectangle");
  for (const type of ["mousePressed", "mouseReleased"]) await uiCall("dev:cdp", "method=Input.dispatchMouseEvent", `params=${JSON.stringify({ type, ...point, button: "left", clickCount: 1 })}`);
  result = { clicked: arg, point };
}
else if (mode === "eval-file" && arg) result = await evaluate(readFileSync(ownedPath(arg), "utf8"));
else if (mode === "inject") result = await evaluate(`const deps=require('${base}/fixture-worker/workspace/scripts/qa/injection.cjs').createControlCenterFixtureDependencies({root:'${base}/fixture-worker/native',origin:'http://127.0.0.1:19129',sourceRoot:'/Users/beomsu/.hermes/hermes-agent'});await app.plugins.plugins['hermes-cron-viewer'].configureControlCenter(deps);return {injected:true,persisted:await app.plugins.plugins['hermes-cron-viewer'].loadData()};`);
else if (mode === "command" && arg) result = await evaluate(`return {executed:app.commands.executeCommandById(${JSON.stringify(`hermes-cron-viewer:${arg}`)})};`);
else if (mode === "screenshot" && arg) result = await uiCall("dev:screenshot", `path=${ownedPath(`${base}/gui/${arg}.png`)}`);
else if (mode === "key" && arg) {
  const nativeKeys: Readonly<Record<string,number>>={ArrowDown:40,ArrowUp:38,ArrowLeft:37,ArrowRight:39,Enter:13,Escape:27,Tab:9,Home:36,End:35};
  for (const type of ["keyDown", "keyUp"]) await uiCall("dev:cdp", "method=Input.dispatchKeyEvent", `params=${JSON.stringify({ type, key: arg, code: arg.length === 1 ? `Key${arg.toUpperCase()}` : arg, modifiers: Number(process.argv[4] ?? 0), ...(nativeKeys[arg]===undefined?{}:{windowsVirtualKeyCode:nativeKeys[arg]}), ...(type === "keyDown" && arg.toLowerCase() === "a" && process.argv[4] === "4" ? {commands:["selectAll"]} : type === "keyDown" && arg === "Backspace" ? {commands:["deleteBackward"]} : {}) })}`);
  result = { key: arg };
} else if (mode === "text" && arg) result = await uiCall("dev:cdp", "method=Input.insertText", `params=${JSON.stringify({ text: arg })}`);
else if (mode === "click" && arg && process.argv[4]) {
  const x = Number(arg), y = Number(process.argv[4]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new FixtureRefusal("invalid observed coordinates");
  for (const type of ["mousePressed", "mouseReleased"]) await uiCall("dev:cdp", "method=Input.dispatchMouseEvent", `params=${JSON.stringify({ type, x, y, button: "left", clickCount: 1 })}`);
  result = { clicked: { x, y } };
} else if (mode === "wheel" || mode === "wheel-x") {
  result = await uiCall("dev:cdp", "method=Input.dispatchMouseEvent", `params=${JSON.stringify({type:"mouseWheel",x:Number(arg),y:Number(process.argv[4]),deltaX:mode === "wheel-x" ? Number(process.argv[5]) : 0,deltaY:mode === "wheel" ? Number(process.argv[5]) : 0})}`);
} else throw new FixtureRefusal("expected inspect, eval-file, inject, command, screenshot or click");
if (process.argv[5] && mode !== "wheel" && mode !== "wheel-x") writeFileSync(ownedPath(process.argv[5]), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
