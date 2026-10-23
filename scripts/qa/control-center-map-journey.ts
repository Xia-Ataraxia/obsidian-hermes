import { writeFileSync } from "node:fs";
import { evaluate, uiCall } from "./control-center-gui";
import { FixtureRefusal } from "./fixture-guard";
const root = "/private/tmp/hermes-control-center-m1-01a161c0/task-20/gui";
const records: unknown[] = [];
async function record(name: string): Promise<void> {
  const value = await evaluate(`return {text:document.body.innerText,world:document.querySelector('.hpc-world')?.style.transform,nodes:[...document.querySelectorAll('.hpc-node')].map(e=>({name:e.querySelector('strong').textContent,transform:e.style.transform,hidden:e.hidden,rect:e.getBoundingClientRect().toJSON()})),active:document.activeElement?.outerHTML.slice(0,300),data:await app.plugins.plugins['hermes-cron-viewer'].loadData()};`);
  records.push({name,value}); writeFileSync(`${root}/map-journey.json`,JSON.stringify(records,null,2));
}
async function point(selector: string, name?: string): Promise<{x:number;y:number}> {
  const value = await evaluate(`const es=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.checkVisibility()${name ? `&&(e.textContent.trim()===${JSON.stringify(name)}||e.querySelector('strong')?.textContent===${JSON.stringify(name)})` : ""});if(es.length!==1)throw Error('Expected unique control '+es.length);const e=es[0],r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Occluded control');return {x,y};`);
  if(typeof value!=="object"||value===null||!("x" in value)||typeof value.x!=="number"||!("y" in value)||typeof value.y!=="number")throw new FixtureRefusal("point unavailable");
  return {x:value.x,y:value.y};
}
async function mouse(type:string,p:{x:number;y:number},buttons=0):Promise<void>{await uiCall("dev:cdp","method=Input.dispatchMouseEvent",`params=${JSON.stringify({type,...p,button:buttons||type==="mouseReleased"?"left":"none",buttons,clickCount:1})}`);}
async function click(selector:string,name?:string):Promise<void>{const p=await point(selector,name);await mouse("mousePressed",p,1);await mouse("mouseReleased",p);}
async function key(key:string,modifiers=0):Promise<void>{for(const type of ["keyDown","keyUp"])await uiCall("dev:cdp","method=Input.dispatchKeyEvent",`params=${JSON.stringify({type,key,modifiers})}`);}
async function drag(p:{x:number;y:number},dx:number,dy:number):Promise<void>{await mouse("mousePressed",p,1);await mouse("mouseMoved",{x:p.x+dx/2,y:p.y+dy/2},1);await mouse("mouseMoved",{x:p.x+dx,y:p.y+dy},1);await mouse("mouseReleased",{x:p.x+dx,y:p.y+dy});}
await uiCall("dev:cdp","method=Emulation.setDeviceMetricsOverride",'params={"width":1292,"height":900,"deviceScaleFactor":1,"mobile":false}');
await click('.hpc-tools button','화면 초기화');
await record("reset-before");
await drag(await point('.hpc-node','xia'),50,30);
await record("pointer-drag");
await key("ArrowRight",8);
await record("keyboard-shift-right");
await click('.hpc-tools button','+');
await record("zoom-button");
const blank=await evaluate("const e=document.querySelector('.hpc-stage'),r=e.getBoundingClientRect();const x=r.right-90,y=r.bottom-120;return {x,y,hit:document.elementFromPoint(x,y)?.className};");
if(typeof blank!=="object"||blank===null||!("x" in blank)||typeof blank.x!=="number"||!("y" in blank)||typeof blank.y!=="number"||!("hit" in blank)||blank.hit!=="hpc-world")throw new FixtureRefusal("pan area not empty");
await drag({x:blank.x,y:blank.y},-60,-40);
await record("pointer-pan");
await uiCall("dev:screenshot",`path=${root}/map-gestures.png`);
await click('.hpc-tools button','화면 초기화');
await drag(await point('.hpc-node','xia'),50,30);
await record("position-before-switch");
await evaluate("return app.commands.executeCommandById('hermes-cron-viewer:open-hermes-kanban');");
await evaluate("return app.commands.executeCommandById('hermes-cron-viewer:open-hermes-profiles');");
await record("position-after-switch");
await uiCall("dev:screenshot",`path=${root}/map-position-restored.png`);
console.log(JSON.stringify({records:records.length,completed:true}));
