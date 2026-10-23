import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fixtureSession } from "./control-center-fixture";
import { CONTROL_CENTER_PYTHON, fixtureProcess } from "./control-center-runtime";
import { FixtureRefusal, ownedPath, verifyHost } from "./fixture-guard";
const base="/private/tmp/hermes-control-center-m1-01a161c0/task-20",root=ownedPath(`${base}/fixture-worker/native`);
const identity=verifyHost();
const life=JSON.parse(readFileSync(`${root}/lifecycle.json`,"utf8"));
if(life.owner!=="task20_fixture"||life.root!==root||life.origin!=="http://127.0.0.1:19129")throw new FixtureRefusal("fixture identity mismatch");
const session=await fixtureSession(life.origin);
interface NativeReply { task: Record<string, unknown>; comments: Record<string, unknown>[]; links: { parents: string[] } }
const tasks:{board:string;id:string;status:number;value:NativeReply}[]=[];
for(const [board,id] of [["default","t_b03c833a"],["default","running-001"],["xia-dev","repeat-001"]]){
  const response=await fetch(`${life.origin}/api/plugins/kanban/tasks/${id}?profile=default&board=${board}`,{headers:session.headers,signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new FixtureRefusal(`native readback status ${response.status}`);
  tasks.push({board:board!,id:id!,status:response.status,value:await response.json() as NativeReply});
}
const database=await fixtureProcess(CONTROL_CENTER_PYTHON,["-I","-B","-c",String.raw`
import json,pathlib,sqlite3,sys
root=pathlib.Path(sys.argv[1])
result=[]
for board,path,ids in [('default',root/'home/kanban.db',['t_b03c833a','running-001']),('xia-dev',root/'home/kanban/boards/xia-dev/kanban.db',['repeat-001'])]:
 db=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True);db.row_factory=sqlite3.Row;db.execute('PRAGMA query_only=ON')
 result.append({'board':board,'path':str(path),'queryOnly':bool(db.execute('PRAGMA query_only').fetchone()[0]),'tasks':[dict(db.execute('SELECT * FROM tasks WHERE id=?',(id,)).fetchone()) for id in ids]})
 db.close()
print(json.dumps(result))
`,root],{root,timeoutMs:5000,maxBytes:2097152});
if(database.exitCode!==0)throw new FixtureRefusal(`readonly database read failed: ${database.stderr}`);
const rows:{board:string;queryOnly:boolean;tasks:Record<string,unknown>[]}[]=JSON.parse(database.stdout);
const created=tasks[0]!.value,running=tasks[1]!.value,review=tasks[2]!.value;
const journal:{route:string;board:string;scenario:string;nativeStatus:number}[]=readFileSync(`${root}/mutations.ndjson`,"utf8").trim().split("\n").map(line=>JSON.parse(line));
const checks={createdTitle:created.task.title==="Task20 target pending commit 2",allowedDrag:created.task.status==="triage",body:created.task.body==="Task20 body saved from installed native editor. <script>external text</script>",comment:created.comments.some(v=>v.body==="Task20 comment from actual keyboard"),dependency:created.links.parents.includes("repeat-001"),unassigned:created.task.assignee===null,modelCleared:created.task.model_override===null&&created.task.provider_override===null,runningRefused:running.task.status==="ready"&&journal.some(v=>v.route.endsWith('/running-001')&&v.nativeStatus===400),lostResponse:review.task.title==="Task20 lost response title",unsavedBodyNotWritten:review.task.body===null,partialOnce:journal.filter(v=>v.route.endsWith('/repeat-001')&&v.board==="xia-dev"&&v.scenario==="partial-patch").length===1,lostOnce:journal.filter(v=>v.route.endsWith('/repeat-001')&&v.board==="xia-dev"&&v.scenario==="lost-response").length===1,queryOnly:rows.every(v=>v.queryOnly),apiDatabaseMatch:tasks.every(t=>{const row=rows.find(r=>r.board===t.board)?.tasks.find(r=>r.id===t.id);return row!==undefined&&['title','body','status','assignee','model_override','provider_override'].every(k=>row[k]===t.value.task[k]);})};
const soul=readFileSync(`${root}/home/profiles/xia/SOUL.md`);
const reference=await fetch(`${life.origin}/reference/upstream.js`,{signal:AbortSignal.timeout(5000)});
const referenceBytes=Buffer.from(await reference.arrayBuffer());
const referenceSha=createHash("sha256").update(referenceBytes).digest("hex");
const result={capturedAt:new Date().toISOString(),identity,readOnly:true,checks,pass:Object.values(checks).every(Boolean),tasks,database:rows,journal,soul:{body:soul.toString(),sha256:createHash("sha256").update(soul).digest("hex")},reference:{status:reference.status,sha256:referenceSha,unchanged:referenceSha==="c316f2e7155b288de8dd709fd8975e9dbc3af6d59a255c74039ce401fd121a3a"}};
writeFileSync(ownedPath(`${base}/gui/final-native-readback.json`),JSON.stringify(result,null,2));
console.log(JSON.stringify({checks,pass:result.pass,reference:result.reference}));
if(!result.pass||!result.reference.unchanged)throw new FixtureRefusal("final native readback mismatch");
