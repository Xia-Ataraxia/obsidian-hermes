import { writeFileSync } from "node:fs";
import { evaluate, uiCall } from "./control-center-gui";
import { FixtureRefusal, ownedPath } from "./fixture-guard";
const root = "/private/tmp/hermes-control-center-m1-01a161c0/task-20/gui";
async function click(selector: string): Promise<void> {
  const point = await evaluate(`const es=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.checkVisibility());if(es.length!==1)throw Error('Expected one control: '+es.length);const e=es[0],r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Control occluded');return {x,y};`);
  if(typeof point!=="object" || point===null) throw new FixtureRefusal("control point missing");
  for (const type of ["mousePressed", "mouseReleased"]) await uiCall("dev:cdp", "method=Input.dispatchMouseEvent", `params=${JSON.stringify({type,...point,button:"left",clickCount:1})}`);
}
async function text(value: string): Promise<void> {
  await uiCall("dev:cdp","method=Input.dispatchKeyEvent",'params={"type":"keyDown","key":"a","code":"KeyA","modifiers":4,"commands":["selectAll"]}');
  await uiCall("dev:cdp","method=Input.dispatchKeyEvent",'params={"type":"keyUp","key":"a","code":"KeyA","modifiers":4}');
  await uiCall("dev:cdp","method=Input.dispatchKeyEvent",'params={"type":"keyDown","key":"Backspace","code":"Backspace","commands":["deleteBackward"]}');
  await uiCall("dev:cdp","method=Input.dispatchKeyEvent",'params={"type":"keyUp","key":"Backspace","code":"Backspace"}');
  if(value) await uiCall("dev:cdp","method=Input.insertText",`params=${JSON.stringify({text:value})}`);
}
const results: unknown[] = [];
for (const theme of ["light","dark"]) for (const width of [1200,768,360]) {
  await evaluate(`if(!document.body.classList.contains('theme-${theme}'))app.commands.executeCommandById('theme:toggle-light-dark');return {theme:document.body.className};`);
  const actualTheme = await evaluate(`return document.body.classList.contains('theme-${theme}');`);
  if(actualTheme!==true) throw new FixtureRefusal(`host theme did not become ${theme}`);
  await uiCall("dev:cdp","method=Emulation.setDeviceMetricsOverride",`params=${JSON.stringify({width,height:900,deviceScaleFactor:1,mobile:false})}`);
  const measuredWidth = await evaluate("return document.querySelector('.hpc-root').getBoundingClientRect().width;");
  if(typeof measuredWidth!=="number") throw new FixtureRefusal("content width unavailable");
  await uiCall("dev:cdp","method=Emulation.setDeviceMetricsOverride",`params=${JSON.stringify({width:Math.round(width+width-measuredWidth),height:900,deviceScaleFactor:1,mobile:false})}`);
  await click('.hpc-search'); await text("");
  const geometry = await evaluate(`const root=document.querySelector('.hpc-root'),r=root.getBoundingClientRect();return {viewport:{width:innerWidth,height:innerHeight},theme:document.body.className,root:{x:r.x,y:r.y,width:r.width,height:r.height},documentOverflow:document.documentElement.scrollWidth>innerWidth,controls:[...root.querySelectorAll('.hpc-controls > *')].map(e=>{const b=e.getBoundingClientRect();return {left:b.left,right:b.right,width:b.width}}),labels:[...root.querySelectorAll('.hpc-node strong')].map(e=>{const b=e.getBoundingClientRect();return {text:e.textContent,width:b.width,height:b.height,font:getComputedStyle(e).fontSize}})};`);
  await uiCall("dev:screenshot",`path=${ownedPath(`${root}/profiles-${theme}-${width}.png`)}`);
  await click('.hpc-search'); await text("xia");
  await click('.hpc-node');
  const detail = await evaluate(`const root=document.querySelector('.hpc-root').getBoundingClientRect(),e=document.querySelector('.hcv-profile-inspector'),r=e.getBoundingClientRect();const contained=r.left>=root.left-1&&r.right<=root.right+1&&r.top>=root.top-1&&r.bottom<=root.bottom+1;if(Math.abs(root.width-${width})>1||!contained)throw Error('Width or inspector containment failed '+JSON.stringify({root:root.toJSON(),inspector:r.toJSON()}));return {text:document.body.innerText,search:document.querySelector('.hpc-search').value,inspectors:document.querySelectorAll('.hcv-profile-inspector').length,inspector:r.toJSON(),contained};`);
  await uiCall("dev:screenshot",`path=${ownedPath(`${root}/profiles-${theme}-${width}-inspector.png`)}`);
  const close = await evaluate("return [...document.querySelectorAll('button')].filter(e=>e.checkVisibility()&&e.textContent.trim()==='Close').length;");
  if(close!==1) throw new FixtureRefusal("inspector close missing");
  await click('.hcv-inspector-header button');
  results.push({theme,width,geometry,detail});
  writeFileSync(`${root}/profiles-size-theme.json`,JSON.stringify(results,null,2));
  console.log(JSON.stringify({theme,width,captured:true}));
}
