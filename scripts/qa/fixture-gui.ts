import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FixtureRefusal, isRecord, ownedPath, verifyHost, verifyVault } from "./fixture-guard";

const identity = verifyHost();
const root = ownedPath(resolve(".omo/qa/gui"));
const vault = ownedPath(resolve(".omo/qa/HermesQA"));
verifyVault(vault);
if (!existsSync(resolve(vault, ".hermes-fixture-vault.json"))) throw new FixtureRefusal("prepared fixture vault required");
const socket = "/Users/beomsu/.obsidian-cli.sock";
const userData = ownedPath(resolve(root, "user-data"));
const binary = "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const productionRegistry = "/Users/beomsu/Library/Application Support/obsidian/obsidian.json";
const digest = (path: string) => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
const beforeRegistry = digest(productionRegistry);
if (spawnSync("/usr/bin/pgrep", ["-x", "Obsidian"]).status !== 1 || lstatSync(socket, { throwIfNoEntry: false })) throw new FixtureRefusal("existing Obsidian process or CLI socket; isolated route not available");
mkdirSync(userData, { recursive: true, mode: 0o700 });
const registryPath = ownedPath(resolve(userData, "obsidian.json"));
if (existsSync(registryPath)) {
  const registry: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
  if (!isRecord(registry) || !isRecord(registry.vaults) || Object.values(registry.vaults).some(value => !isRecord(value) || value.path !== vault)) throw new FixtureRefusal("non-fixture registry refused");
}
writeFileSync(registryPath, JSON.stringify({ vaults: { hermesfixture001: { path: vault, ts: Date.now(), open: true } }, cli: true, updateDisabled: true }), { mode: 0o600 });
const log = openSync(ownedPath(resolve(root, "app.log")), "a", 0o600);
const socketReady = new Promise<void>((resolveReady, reject) => {
  const watcher = watch("/Users/beomsu", (_event, filename) => {
    if (filename === ".obsidian-cli.sock" && existsSync(socket)) { clearTimeout(timer); watcher.close(); resolveReady(); }
  });
  const timer = setTimeout(() => { watcher.close(); reject(new FixtureRefusal("isolated GUI socket startup timeout")); }, 30_000);
});
const child = spawn(binary, [`--user-data-dir=${userData}`], { stdio: ["ignore", log, log], env: { ...process.env, TMPDIR: root } });
closeSync(log);
const exited = new Promise(resolveExit => child.once("exit", resolveExit));
const commands: { readonly argv: readonly string[]; readonly stdout: string }[] = [];
let ownedSocketInode: number | undefined;
let failed = false;
try {
  await socketReady;
  const ownership = execFileSync("/usr/sbin/lsof", ["-n", "-a", "-p", String(child.pid), "-U", "-Fpn"], { encoding: "utf8" });
  if (!ownership.includes(`p${child.pid}\n`) || !ownership.includes(`n${socket}`)) throw new FixtureRefusal("CLI socket not owned by launched process");
  ownedSocketInode = lstatSync(socket).ino;
  const cli = async (...args: string[]) => {
    const argv = [`--user-data-dir=${userData}`, "vault=HermesQA", ...args];
    const command = spawn(binary, argv, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    command.stdout.on("data", chunk => { stdout += String(chunk); });
    command.stderr.on("data", chunk => { stderr += String(chunk); });
    await new Promise<void>((resolveDone, reject) => {
      const timer = setTimeout(() => { command.kill("SIGTERM"); reject(new FixtureRefusal("CLI command timeout")); }, 30_000);
      command.once("error", error => { clearTimeout(timer); reject(error); });
      command.once("close", code => { clearTimeout(timer); command.stdin.destroy(); if (code === 0) resolveDone(); else reject(new FixtureRefusal(`CLI exit ${code}: ${stderr}`)); });
    });
    commands.push({ argv, stdout });
    return stdout;
  };
  await cli("--help");
  const observed = await cli("eval", 'code=JSON.stringify({vault:app.vault.adapter.basePath,name:app.vault.getName(),sync:app.internalPlugins.plugins.sync?.enabled===true,plugins:Array.from(app.plugins.enabledPlugins)})');
  if (!observed.includes(vault) || !observed.includes('"sync":false')) throw new FixtureRefusal("CLI routed to unexpected vault or sync state");
  await cli("eval", 'code=app.workspace.getLeaf("tab").setViewState({type:"empty",active:true})');
  await cli("dev:cdp", "method=Page.getLayoutMetrics");
  await cli("dev:cdp", "method=Input.dispatchKeyEvent", 'params={"type":"keyDown","key":"Escape","code":"Escape"}');
  await cli("dev:cdp", "method=Input.dispatchKeyEvent", 'params={"type":"keyUp","key":"Escape","code":"Escape"}');
  const screenshot = ownedPath(resolve(root, "HermesQA.png"));
  await cli("dev:screenshot", `path=${screenshot}`);
  if (!existsSync(screenshot) || readFileSync(screenshot).length < 1000) throw new FixtureRefusal("rendered screenshot missing");
  const targetOutput = await cli("eval", 'code=JSON.stringify(Array.from(document.querySelectorAll("*")).filter(e=>e.textContent?.trim().startsWith("Create new note")&&!Array.from(e.children).some(c=>c.textContent?.trim().startsWith("Create new note"))).map(e=>{const r=e.getBoundingClientRect();return {tag:e.tagName,text:e.textContent,x:r.x+r.width/2,y:r.y+r.height/2,width:r.width}}).filter(e=>e.width>0&&e.width<300))');
  const targets: unknown = JSON.parse(targetOutput.replace(/^=>\s*/, "").trim());
  const target: unknown = Array.isArray(targets) ? targets[0] : undefined;
  if (!isRecord(target) || typeof target.x !== "number" || typeof target.y !== "number") throw new FixtureRefusal("observed Create new note control missing");
  await cli("dev:cdp", "method=Input.dispatchMouseEvent", `params=${JSON.stringify({ type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 })}`);
  await cli("dev:cdp", "method=Input.dispatchMouseEvent", `params=${JSON.stringify({ type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 })}`);
  const activeFile = await cli("eval", 'code=JSON.stringify({path:app.workspace.getActiveFile()?.path,type:app.workspace.activeLeaf?.view.getViewType()})');
  if (!activeFile.includes("Untitled") || !activeFile.includes('"type":"markdown"')) throw new FixtureRefusal("pointer action did not create a synthetic note editor");
  const interactionScreenshot = ownedPath(resolve(root, "HermesQA-pointer.png"));
  await cli("dev:screenshot", `path=${interactionScreenshot}`);
  await cli("dev:cdp", "method=Input.dispatchKeyEvent", 'params={"type":"keyDown","key":"Escape","code":"Escape"}');
  await cli("dev:cdp", "method=Input.dispatchKeyEvent", 'params={"type":"keyUp","key":"Escape","code":"Escape"}');
  await cli("dev:errors");
  console.log(JSON.stringify({ identity, vault, userData, pid: child.pid, socket, ownership, screenshot, screenshotSha256: digest(screenshot), interactionScreenshot, interactionSha256: digest(interactionScreenshot), commands }));
} catch (error) {
  console.log(JSON.stringify({ event: "gui-failed", identity, vault, userData, commands, error: error instanceof Error ? error.message : "unknown failure" }));
  failed = true;
} finally {
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
  if (ownedSocketInode !== undefined && lstatSync(socket, { throwIfNoEntry: false })?.ino === ownedSocketInode) unlinkSync(socket);
  const afterRegistry = digest(productionRegistry);
  console.log(JSON.stringify({ event: "gui-cleanup", ownedPid: child.pid, exitCode: child.exitCode, signal: child.signalCode, productionRegistryUnchanged: beforeRegistry === afterRegistry, socketRemains: existsSync(socket) }));
  if (beforeRegistry !== afterRegistry) throw new FixtureRefusal("production registry changed");
}
if (failed) process.exit(1);
