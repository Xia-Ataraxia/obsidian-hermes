import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { evaluate, uiCall } from "./control-center-gui";
import { FixtureRefusal, ownedPath } from "./fixture-guard";

const base = "/private/tmp/hermes-control-center-m1-01a161c0/task-20";
const root = `${base}/gui`;
const draft = "Current build local SOUL draft retained across live refresh and external conflict.";
const records: unknown[] = [];
async function record(name: string): Promise<void> {
  const value = await evaluate("return {text:document.body.innerText,value:document.querySelector('textarea[aria-label=\"SOUL.md contents\"]')?.value,focus:document.activeElement?.getAttribute('aria-label'),status:document.querySelector('.hcv-inspector-status')?.textContent};");
  records.push({name,at:new Date().toISOString(),value});
  writeFileSync(ownedPath(`${root}/inspector-journey.json`),JSON.stringify(records,null,2));
}
async function click(selector: string): Promise<void> {
  const point = await evaluate(`const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded control');return {x,y};`);
  for(const type of ["mousePressed","mouseReleased"]) await uiCall("dev:cdp","method=Input.dispatchMouseEvent",`params=${JSON.stringify({type,...Object(point),button:"left",clickCount:1})}`);
}
async function scrollActions(): Promise<void> {
  const point=await evaluate("const r=document.querySelector('.hcv-inspector-body').getBoundingClientRect();return{x:r.right-5,y:r.bottom-10};");
  await uiCall("dev:cdp","method=Input.dispatchMouseEvent",`params=${JSON.stringify({type:"mouseWheel",...Object(point),deltaX:0,deltaY:1000})}`);
}
await click('textarea[aria-label="SOUL.md contents"]');
await uiCall("dev:cdp","method=Input.dispatchKeyEvent",'params={"type":"keyDown","key":"a","code":"KeyA","modifiers":4,"commands":["selectAll"]}');
await uiCall("dev:cdp","method=Input.dispatchKeyEvent",'params={"type":"keyUp","key":"a","code":"KeyA","modifiers":4}');
await uiCall("dev:cdp","method=Input.insertText",'params={"text":"Current build synthetic SOUL saved by real keyboard. <script>inert</script>"}');
await scrollActions();
await click('button[aria-label="Save SOUL.md"]');
await new Promise(done=>setTimeout(done,300));
const saved = readFileSync(ownedPath(`${base}/fixture-worker/native/home/profiles/xia/SOUL.md`),"utf8");
records.push({name:"native-document-readback",saved,sha256:createHash("sha256").update(saved).digest("hex")});
if(saved!=="Current build synthetic SOUL saved by real keyboard. <script>inert</script>")throw new FixtureRefusal("native saved document mismatch");
await click('textarea[aria-label="SOUL.md contents"]');
await uiCall("dev:cdp","method=Input.dispatchKeyEvent",'params={"type":"keyDown","key":"a","code":"KeyA","modifiers":4,"commands":["selectAll"]}');
await uiCall("dev:cdp","method=Input.dispatchKeyEvent",'params={"type":"keyUp","key":"a","code":"KeyA","modifiers":4}');
await uiCall("dev:cdp","method=Input.insertText",`params=${JSON.stringify({text:draft})}`);
await record("dirty-before-live-refresh");
await new Promise(done=>setTimeout(done,16_500));
await record("dirty-after-live-refresh");
const retained = await evaluate(`return document.querySelector('textarea[aria-label="SOUL.md contents"]')?.value===${JSON.stringify(draft)}&&document.activeElement?.getAttribute('aria-label')==='SOUL.md contents';`);
if(retained!==true)throw new FixtureRefusal("live refresh changed draft or focus");
const control=execFileSync("/opt/homebrew/bin/bun",["scripts/qa/control-center-fixture.ts","control","--root",`${base}/fixture-worker/native`,"--scenario","external-soul"],{encoding:"utf8",timeout:10_000});
records.push({name:"external-change",control});
await scrollActions();
await click('button[aria-label="Save SOUL.md"]');
await new Promise(done=>setTimeout(done,500));
await record("external-conflict");
const conflict=await evaluate(`return {retained:document.querySelector('textarea[aria-label="SOUL.md contents"]')?.value===${JSON.stringify(draft)},text:document.body.innerText};`);
if(typeof conflict!=="object"||conflict===null||!("retained" in conflict)||conflict.retained!==true||!("text" in conflict)||typeof conflict.text!=="string"||!conflict.text.includes("server"))throw new FixtureRefusal("missing conflict or retained draft");
await uiCall("dev:screenshot",`path=${root}/soul-current-conflict.png`);
console.log(JSON.stringify({completed:true,records:records.length}));
