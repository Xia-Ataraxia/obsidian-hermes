import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { connect } from "node:net";
import { FixtureRefusal, ownedPath, verifyHost } from "./fixture-guard";
import { CONTROL_CENTER_PYTHON } from "./control-center-runtime";

const identity = verifyHost();
const root = ownedPath(process.argv[2] ?? "");
const numbers = process.argv.slice(3).map(Number);
if (numbers.length !== 4 || numbers.some(value => !Number.isSafeInteger(value) || value < 1)) throw new FixtureRefusal("two owned PIDs then two owned ports required");
const processes = numbers.slice(0, 2).map(pid => {
  let absent = false;
  try { process.kill(pid, 0); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") absent = true; else throw error; }
  return { pid, absent };
});
const ports = await Promise.all(numbers.slice(2).map(port => new Promise<{ port: number; closed: boolean }>((done, reject) => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.setTimeout(1000);
  socket.once("connect", () => { socket.destroy(); done({ port, closed: false }); });
  socket.once("error", error => { socket.destroy(); if ("code" in error && error.code === "ECONNREFUSED") done({ port, closed: true }); else reject(error); });
  socket.once("timeout", () => { socket.destroy(); reject(new FixtureRefusal("port cleanup probe timed out")); });
})));
const files = readdirSync("scripts/qa").filter(name => name.startsWith("control-center-") && /\.(ts|py)$/.test(name)).map(name => `scripts/qa/${name}`);
const sourceHashes = Object.fromEntries(files.sort().map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]));
const acceptance: unknown = JSON.parse(readFileSync(resolve(root, "acceptance.json"), "utf8"));
const receipt = { identity, root, processes, ports, sourceHashes, retainedPython: CONTROL_CENTER_PYTHON, retainedPythonExists: existsSync(CONTROL_CENTER_PYTHON), lifecycleRemoved: !existsSync(resolve(root, "lifecycle.json")), acceptance, pass: processes.every(item => item.absent) && ports.every(item => item.closed) && !existsSync(resolve(root, "lifecycle.json")) && existsSync(CONTROL_CENTER_PYTHON) };
writeFileSync(resolve(root, "cleanup-receipt.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
if (!receipt.pass) throw new FixtureRefusal("fixture cleanup incomplete");
