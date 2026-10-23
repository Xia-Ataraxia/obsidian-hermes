import { evaluate, uiCall } from "./control-center-gui";
import { FixtureRefusal } from "./fixture-guard";
const mode=process.argv[2];
if(mode==="open") console.log(JSON.stringify(await evaluate("if(globalThis.__hcvQaReference)throw Error('QA reference already open');const leaf=app.workspace.getLeaf('tab');await leaf.setViewState({type:'empty',active:true});const host=leaf.view.contentEl??leaf.view.containerEl;const frame=document.createElement('iframe');frame.src='http://127.0.0.1:19129/reference';frame.setAttribute('title','Original native Hermes reference');frame.style.cssText='width:100%;height:100%;min-height:700px;border:0';host.replaceChildren(frame);globalThis.__hcvQaReference={leaf,frame};return {leaf:leaf.id,src:frame.src,rect:frame.getBoundingClientRect().toJSON()};")));
else if(mode==="frames")console.log(await uiCall("dev:cdp","method=Page.getFrameTree"));
else if(mode==="close")console.log(JSON.stringify(await evaluate("const ref=globalThis.__hcvQaReference;if(!ref)throw Error('Reference missing');ref.frame.remove();ref.leaf.detach();delete globalThis.__hcvQaReference;return {removed:true};")));
else throw new FixtureRefusal("expected open, frames or close");
