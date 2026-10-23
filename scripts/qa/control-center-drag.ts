import { evaluate, uiCall } from "./control-center-gui";
import { FixtureRefusal } from "./fixture-guard";
const [x,y,toX,toY]=process.argv.slice(2).map(Number);
if(x===undefined||y===undefined||toX===undefined||toY===undefined||![x,y,toX,toY].every(Number.isFinite))throw new FixtureRefusal("four observed drag coordinates required");
console.log(JSON.stringify(await evaluate(`return {from:document.elementFromPoint(${x},${y})?.outerHTML.slice(0,500),to:document.elementFromPoint(${toX},${toY})?.outerHTML.slice(0,500)};`)));
await uiCall("dev:cdp","method=Input.dispatchMouseEvent",`params=${JSON.stringify({type:"mousePressed",x,y,button:"left",buttons:1,clickCount:1})}`);
for(let step=1;step<=6;step++)await uiCall("dev:cdp","method=Input.dispatchMouseEvent",`params=${JSON.stringify({type:"mouseMoved",x:x+(toX-x)*step/6,y:y+(toY-y)*step/6,button:"left",buttons:1})}`);
await uiCall("dev:cdp","method=Input.dispatchMouseEvent",`params=${JSON.stringify({type:"mouseReleased",x:toX,y:toY,button:"left",buttons:0,clickCount:1})}`);
console.log(JSON.stringify(await evaluate("return {text:document.body.innerText};")));
