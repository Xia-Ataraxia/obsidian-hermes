import { spawn, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { FixtureRefusal, ownedPath, verifyHost, verifyVault } from "./fixture-guard";
import { prepareVault } from "./fixture-vault";

const base = "/private/tmp/hermes-control-center-m1-01a161c0/task-20";
const root = `${base}/gui`, vault = `${base}/HermesQA`, userData = `${root}/user-data`;
const socket = "/Users/beomsu/.obsidian-cli.sock", binary = "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const productionRegistry = "/Users/beomsu/Library/Application Support/obsidian/obsidian.json";
const assets = ["main.js", "manifest.json", "styles.css"];
const digest = (path: string) => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
type Session = { pid: number; socketInode: number; vault: string; userData: string; hashes: Record<string, string | null> };
function session(): Session {
  verifyHost(); verifyVault(vault);
  const value: Session = JSON.parse(readFileSync(ownedPath(`${root}/session.json`), "utf8"));
  if (!Number.isInteger(value.pid) || value.vault !== vault || value.userData !== userData || lstatSync(socket).ino !== value.socketInode) throw new FixtureRefusal("GUI identity mismatch");
  const ownership = execFileSync("/usr/sbin/lsof", ["-n", "-a", "-p", String(value.pid), "-U", "-Fpn"], { encoding: "utf8" });
  if (!ownership.includes(`p${value.pid}\n`) || !ownership.includes(`n${socket}`)) throw new FixtureRefusal("GUI socket owner mismatch");
  for (const asset of assets) if (value.hashes[asset] !== digest(`${base}/workspace/${asset}`) || value.hashes[asset] !== digest(`${vault}/.obsidian/plugins/hermes-cron-viewer/${asset}`)) throw new FixtureRefusal(`stale installed asset: ${asset}`);
  return value;
}
async function command(...args: string[]): Promise<string> {
  const child = spawn(binary, [`--user-data-dir=${userData}`, "vault=HermesQA", ...args], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new FixtureRefusal("bounded CLI timeout")); }, 30_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); child.stdin.destroy(); code === 0 ? done() : reject(new FixtureRefusal(`CLI inner exit ${code}: ${stderr}`)); });
  });
  return stdout;
}
export async function uiCall(...args: string[]): Promise<string> {
  session();
  const stdout = await command(...args);
  appendFileSync(`${root}/commands.ndjson`, `${JSON.stringify({ at: new Date().toISOString(), args, stdout })}\n`);
  if (/^Error:|^Evaluation error:/m.test(stdout)) throw new FixtureRefusal(stdout);
  return stdout;
}
export async function evaluate(code: string): Promise<unknown> {
  const raw = await uiCall("eval", `code=(async()=>JSON.stringify(await (async()=>{${code}})()))()`);
  return JSON.parse(raw.replace(/^=>\s*/, "").trim());
}
async function start(): Promise<void> {
  const identity = verifyHost(); ownedPath(root); verifyVault(vault);
  if (spawnSync("/usr/bin/pgrep", ["-x", "Obsidian"]).status !== 1 || lstatSync(socket, { throwIfNoEntry: false })) throw new FixtureRefusal("existing Obsidian process or socket refused");
  const binding = prepareVault(vault, `${base}/workspace`);
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  const beforeRegistry = digest(productionRegistry);
  writeFileSync(`${userData}/obsidian.json`, JSON.stringify({ vaults: { hermestask20: { path: vault, ts: Date.now(), open: true } }, cli: true, updateDisabled: true }));
  const socketReady = new Promise<void>((ready, reject) => {
    const watcher = watch("/Users/beomsu", (_event, filename) => { if (filename === ".obsidian-cli.sock" && existsSync(socket)) { clearTimeout(timer); watcher.close(); ready(); } });
    const timer = setTimeout(() => { watcher.close(); reject(new FixtureRefusal("GUI startup timeout")); }, 30_000);
  });
  const log = openSync(`${root}/app.log`, "a", 0o600);
  const child = spawn(binary, [`--user-data-dir=${userData}`], { stdio: ["ignore", log, log], env: { ...process.env, TMPDIR: root } }); closeSync(log);
  const exited = new Promise<void>(done => child.once("exit", () => done()));
  let inode: number | undefined;
  const stop = () => child.kill("SIGTERM");
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  try {
    await socketReady;
    inode = lstatSync(socket).ino;
    const value: Session = { pid: child.pid!, socketInode: inode, vault, userData, hashes: Object.fromEntries(assets.map(asset => [asset, digest(`${base}/workspace/${asset}`)])) };
    writeFileSync(`${root}/session.json`, JSON.stringify(value)); session();
    const deadline = Date.now() + 30_000;
    while (true) {
      const readiness = await command("eval", "code=JSON.stringify({ready:!!app.workspace.layoutReady})");
      if (readiness.includes('"ready":true')) break;
      if (Date.now() >= deadline) throw new FixtureRefusal(`vault readiness timeout: ${readiness}`);
      await new Promise(done => setTimeout(done, 250));
    }
    const observed = await evaluate("return {vault:app.vault.adapter.basePath,name:app.vault.getName(),sync:app.internalPlugins.plugins.sync?.enabled===true,plugin:!!app.plugins.plugins['hermes-cron-viewer'],commands:Object.keys(app.commands.commands).filter(k=>k.startsWith('hermes-cron-viewer:'))};");
    if (!JSON.stringify(observed).includes(vault) || !JSON.stringify(observed).includes('"sync":false')) throw new FixtureRefusal("unexpected vault or sync state");
    const bound = typeof observed === "object" && observed !== null && "plugin" in observed && observed.plugin === true;
    const receipt = { event: bound ? "UI-BIND" : "HOST-READY-PLUGIN-PENDING", identity, binding, ...value, observed };
    writeFileSync(`${root}/binding.json`, JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
    await exited;
  } finally {
    child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000); await exited; clearTimeout(timer);
    if (inode !== undefined && lstatSync(socket, { throwIfNoEntry: false })?.ino === inode) unlinkSync(socket);
    const receipt = { event: "GUI-cleanup", pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, socketRemains: existsSync(socket), registryUnchanged: beforeRegistry === digest(productionRegistry) };
    writeFileSync(`${root}/cleanup.json`, JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
    if (!receipt.registryUnchanged) throw new FixtureRefusal("production registry changed");
  }
}
if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === "start") await start();
  else if (mode === "call") console.log(await uiCall(...process.argv.slice(3)));
  else if (mode === "stop") { const active = session(); process.kill(active.pid, "SIGTERM"); console.log(JSON.stringify({ stopped: active.pid })); }
  else throw new FixtureRefusal("expected start, call or stop");
}
