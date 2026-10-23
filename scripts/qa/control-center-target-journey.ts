import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { evaluate, uiCall } from "./control-center-gui";
import { FixtureRefusal, ownedPath } from "./fixture-guard";
const base="/private/tmp/hermes-control-center-m1-01a161c0/task-20",root=`${base}/gui`;
const records:unknown[]=[];
function save(name:string,value:unknown):void{records.push({name,at:new Date().toISOString(),value});writeFileSync(ownedPath(`${root}/target-journey.json`),JSON.stringify(records,null,2));}
function scenario(value:string):void{save("scenario",execFileSync("/opt/homebrew/bin/bun",["scripts/qa/control-center-fixture.ts","control","--root",`${base}/fixture-worker/native`,"--scenario",value],{encoding:"utf8",timeout:10000}));}
async function click(selector:string,text?:string):Promise<void>{
  const point=await evaluate(`const es=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.checkVisibility()${text?`&&(e.textContent.trim()===${JSON.stringify(text)}||e.querySelector('strong')?.textContent===${JSON.stringify(text)})`:""});if(es.length!==1)throw Error('Control count '+es.length);const e=es[0],r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded control');return{x,y};`);
  for(const type of ["mousePressed","mouseReleased"])await uiCall("dev:cdp","method=Input.dispatchMouseEvent",`params=${JSON.stringify({type,...Object(point),button:"left",clickCount:1})}`);
}
async function key(key:string):Promise<void>{for(const type of ["keyDown","keyUp"])await uiCall("dev:cdp","method=Input.dispatchKeyEvent",`params=${JSON.stringify({type,key,code:key,windowsVirtualKeyCode:key==="Enter"?13:undefined})}`);}
await click('.hpc-node','xia');
await click('.hermes-kanban-drawer-title-text');
await uiCall("dev:cdp","method=Input.dispatchKeyEvent",'params={"type":"keyDown","key":"a","code":"KeyA","modifiers":4,"commands":["selectAll"]}');
await uiCall("dev:cdp","method=Input.dispatchKeyEvent",'params={"type":"keyUp","key":"a","code":"KeyA","modifiers":4}');
await uiCall("dev:cdp","method=Input.insertText",'params={"text":"Task20 target pending commit 2"}');
scenario("lost-response");
const journal=ownedPath(`${base}/fixture-worker/native/mutations.ndjson`);
const initial=readFileSync(journal,"utf8").trim().split("\n").length;
await key("Enter");
const deadline=Date.now()+3000;
while(readFileSync(journal,"utf8").trim().split("\n").length===initial){if(Date.now()>deadline)throw new FixtureRefusal("native commit not observed");await new Promise(done=>setTimeout(done,50));}
save("native-pending-mutation",JSON.parse(readFileSync(journal,"utf8").trim().split("\n").at(-1)!));
scenario("delay");
await click('.hpc-controls button','새로 고침');
const pending=await evaluate("const p=app.plugins.plugins['hermes-cron-viewer'],cc=p.controlCenter;const views=[...cc.views];const k=views.find(v=>v.getViewType()==='hermes-kanban').mounted.view;const c=views.find(v=>v.getViewType()==='hermes-profiles').mounted.view.canvas;const before={decision:k.session.closeDecision(),inspector:c.inspector.leaf?.snapshot.loading,visible:[...cc.pool.entries.values()].map(e=>e.visible)};globalThis.__task20Old={views,entries:[...cc.pool.entries.values()],scopes:[...cc.pool.entries.values()].map(e=>e.scope)};globalThis.__task20Replacement=p.replaceServerTarget('hermes-fixture','hermes-fixture-next');return before;");
save("pending-before-target",pending);
if(typeof pending!=="object"||pending===null||!("decision" in pending)||!Object(pending.decision).saving||!("inspector" in pending)||pending.inspector!==true)throw new FixtureRefusal("save/read were not both pending");
save("concurrent-settings",await evaluate("const p=app.plugins.plugins['hermes-cron-viewer'];const duplicate=await p.replaceServerTarget('hermes-fixture','hermes-fixture-third');await p.saveSettings({...p.settings,historyLimit:77});return {duplicate,settings:p.settings,text:document.body.innerText};"));
await uiCall("dev:screenshot",`path=${root}/target-pending-dialog.png`);
await click('.modal button','Keep waiting');
save("cancelled-target",await evaluate("return {result:await globalThis.__task20Replacement,settings:app.plugins.plugins['hermes-cron-viewer'].settings,text:document.body.innerText};"));
await evaluate("globalThis.__task20Replacement=app.plugins.plugins['hermes-cron-viewer'].replaceServerTarget('hermes-fixture','hermes-fixture-next');return true;");
await click('.modal button','Close anyway');
const replaced=await evaluate("const result=await globalThis.__task20Replacement;const p=app.plugins.plugins['hermes-cron-viewer'];return {result,settings:p.settings,views:[...p.controlCenter.views].map(v=>v.connection),entries:[...p.controlCenter.pool.entries.keys()],old:globalThis.__task20Old.entries.map(e=>({aborted:e.lifetime.signal.aborted,wire:e.wire!==null,scope:e.scope!==null})),oldViews:globalThis.__task20Old.views.map(v=>({disposed:v.disposed,body:v.contentEl.textContent})),oldStates:globalThis.__task20Old.scopes.map(s=>({stateDisposed:s.state.disposed,clientDisposed:s.client.disposed,currentClient:s.client.current!==null})),data:await p.loadData()};");
save("accepted-target",replaced);
if(typeof replaced!=="object"||replaced===null||!("settings" in replaced)||Object(replaced.settings).historyLimit!==77||Object(replaced.settings).servers.join()!=="hermes-fixture-next")throw new FixtureRefusal("replacement lost concurrent settings");
scenario("reset");
await evaluate("return app.commands.executeCommandById('hermes-cron-viewer:open-hermes-profiles');");
await new Promise(done=>setTimeout(done,13000));
save("new-target-after-late-response",await evaluate("const p=app.plugins.plugins['hermes-cron-viewer'];return {text:document.body.innerText,views:[...p.controlCenter.views].map(v=>({connection:v.connection,state:v.getState()})),data:await p.loadData()};"));
save("native-mutations-since",readFileSync(journal,"utf8").trim().split("\n").slice(initial).map(line=>JSON.parse(line)));
await uiCall("dev:screenshot",`path=${root}/target-next-clean.png`);
console.log(JSON.stringify({completed:true,records:records.length}));
