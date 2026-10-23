import { appendFileSync, closeSync, constants, fchmodSync, fchownSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { ASSETS, InstallRefusal, canonical, digest, directory, equal, guardPaths, inspect, keys, membership, owned, parseRequest, readHost, readMember, record, targetState, verifyAuthority } from "./obsidian-install-guard";
import type { Asset, FileState, Observation, Request } from "./obsidian-install-guard";

type Checkpoint = Readonly<{ request: Request; expected: Observation; anchor: string }>;
type Hooks = Readonly<{ signal?: AbortSignal; afterReplace?: (name: Asset) => void }>;
export class InstallFailure extends Error {
  override readonly name = "InstallFailure";
  constructor(readonly failure: string, readonly rolledBack: boolean, readonly recoveryFailure: string | null) { super(failure); }
}
const message = (error: unknown): string => error instanceof Error ? error.message : "unknown installer failure";
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durable(path: string, bytes: Uint8Array | string, mode = 0o600): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { writeFileSync(fd, bytes); fchmodSync(fd, mode); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
function journal(checkpoint: Checkpoint, event: string, member?: Asset): void {
  const path = resolve(checkpoint.request.backup, "journal.ndjson");
  readMember(path, true);
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try { appendFileSync(fd, JSON.stringify({ event, ...(member ? { member } : {}) }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
}
export function observe(request: Request): Observation {
  verifyAuthority(request, readHost());
  return inspect(request);
}
export function prepare(request: Request): { readonly backup: string; readonly anchor: string; readonly observation: Observation } {
  const before = observe(request);
  if (!request.expected || !equal(before, request.expected)) throw new InstallRefusal("expected current observation differs");
  mkdirSync(request.backup, { mode: 0o700 }); syncDirectory(dirname(request.backup));
  directory(request.backup, true);
  for (const name of ASSETS) {
    for (const [prefix, root, expected] of [["before", request.target, before.targetFiles], ["after", request.source, before.sourceFiles]] as const) {
      const member = readMember(resolve(root, name));
      if (!equal(member.state, expected[name])) throw new InstallRefusal("revision changed during backup");
      durable(resolve(request.backup, `${prefix}-${name}`), member.bytes);
    }
  }
  durable(resolve(request.backup, "journal.ndjson"), "");
  if (!equal(observe(request), before)) throw new InstallRefusal("revision changed before checkpoint completion");
  const bytes = JSON.stringify({ schema: 1, request }, null, 2) + "\n";
  durable(resolve(request.backup, "checkpoint.json"), bytes);
  const anchor = digest(bytes);
  const checkpoint = loadCheckpoint(request.backup, anchor);
  journal(checkpoint, "prepared");
  return { backup: request.backup, anchor, observation: before };
}
function loadCheckpoint(backup: string, anchor: string): Checkpoint {
  directory(backup, true); directory(dirname(backup), true);
  if (!/^[a-f0-9]{64}$/.test(anchor)) throw new InstallRefusal("trusted checkpoint SHA256 required");
  const bytes = readMember(resolve(backup, "checkpoint.json"), true).bytes;
  if (digest(bytes) !== anchor) throw new InstallRefusal("checkpoint anchor mismatch");
  const manifest = record(JSON.parse(bytes.toString("utf8"))); keys(manifest, ["schema", "request"]);
  if (manifest.schema !== 1) throw new InstallRefusal("unsupported checkpoint");
  const request = parseRequest(manifest.request);
  if (request.backup !== backup || !request.expected) throw new InstallRefusal("checkpoint target or expected state missing");
  verifyAuthority(request, readHost()); guardPaths(request);
  membership(backup, ["checkpoint.json", "journal.ndjson", ...ASSETS.flatMap(name => [`before-${name}`, `after-${name}`])]);
  readMember(resolve(backup, "journal.ndjson"), true);
  for (const name of ASSETS) {
    for (const [prefix, state] of [["before", request.expected.targetFiles[name]], ["after", request.expected.sourceFiles[name]]] as const) {
      const member = readMember(resolve(backup, `${prefix}-${name}`), true);
      if (member.state.sha256 !== state.sha256 || member.state.bytes !== state.bytes) throw new InstallRefusal("corrupt recovery asset");
    }
  }
  return { request, expected: request.expected, anchor };
}
function afterState(checkpoint: Checkpoint, name: Asset): FileState {
  const before = checkpoint.expected.targetFiles[name], source = checkpoint.expected.sourceFiles[name];
  return { ...before, sha256: source.sha256, bytes: source.bytes };
}
function checkedTarget(checkpoint: Checkpoint): ReturnType<typeof targetState> {
  verifyAuthority(checkpoint.request, readHost()); guardPaths(checkpoint.request);
  const current = targetState(checkpoint.request);
  if (!equal(current.targetDirectory, checkpoint.expected.targetDirectory) || !equal(current.settings, checkpoint.expected.settings)) throw new InstallRefusal("target directory or settings revision changed");
  return current;
}
function replace(checkpoint: Checkpoint, name: Asset, expected: FileState, bytes: Buffer): void {
  const path = resolve(checkpoint.request.target, name);
  const temporary = resolve(checkpoint.request.target, `.hermes-install-${randomUUID()}`);
  if (!equal(readMember(path).state, expected)) throw new InstallRefusal("member revision changed before staging");
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { writeFileSync(fd, bytes); fchownSync(fd, expected.uid, expected.gid); fchmodSync(fd, expected.mode); fsyncSync(fd); }
    finally { closeSync(fd); }
    canonical(path); directory(checkpoint.request.target);
    if (!equal(readMember(path).state, expected)) throw new InstallRefusal("member revision changed before replacement");
    const settings = resolve(checkpoint.request.target, "data.json");
    const currentSettings = lstatSync(settings, { throwIfNoEntry: false }) ? readMember(settings).state : null;
    if (!equal(currentSettings, checkpoint.expected.settings)) throw new InstallRefusal("settings revision changed before replacement");
    membership(checkpoint.request.target, [...ASSETS, ...(currentSettings ? ["data.json"] : []), temporary.slice(temporary.lastIndexOf("/") + 1)]);
    renameSync(temporary, path); syncDirectory(checkpoint.request.target);
  } finally {
    if (lstatSync(temporary, { throwIfNoEntry: false })) { unlinkSync(temporary); syncDirectory(checkpoint.request.target); }
  }
}
export function rollback(backup: string, anchor: string, hooks: Hooks = {}): Observation["targetFiles"] {
  const checkpoint = loadCheckpoint(backup, anchor);
  const current = checkedTarget(checkpoint);
  if (ASSETS.some(name => !owned(current.targetFiles[name], checkpoint.expected.targetFiles[name]) && !owned(current.targetFiles[name], afterState(checkpoint, name)))) throw new InstallRefusal("third-party asset drift; rollback refused");
  journal(checkpoint, "rollback-started");
  for (const name of [...ASSETS].reverse()) {
    hooks.signal?.throwIfAborted();
    loadCheckpoint(backup, anchor);
    const next = checkedTarget(checkpoint);
    if (ASSETS.some(member => !owned(next.targetFiles[member], checkpoint.expected.targetFiles[member]) && !owned(next.targetFiles[member], afterState(checkpoint, member)))) throw new InstallRefusal("asset drift during rollback");
    if (owned(next.targetFiles[name], checkpoint.expected.targetFiles[name])) continue;
    replace(checkpoint, name, next.targetFiles[name], readMember(resolve(backup, `before-${name}`), true).bytes);
    journal(checkpoint, "restored", name); hooks.afterReplace?.(name);
  }
  const restored = checkedTarget(checkpoint).targetFiles;
  if (ASSETS.some(name => !owned(restored[name], checkpoint.expected.targetFiles[name]))) throw new InstallRefusal("rollback readback mismatch");
  journal(checkpoint, "rolled-back"); return restored;
}
export function install(backup: string, anchor: string, hooks: Hooks = {}): Observation["targetFiles"] {
  const checkpoint = loadCheckpoint(backup, anchor);
  const observed = observe(checkpoint.request);
  if (!equal(observed.sourceDirectory, checkpoint.expected.sourceDirectory) || !equal(observed.sourceFiles, checkpoint.expected.sourceFiles)) throw new InstallRefusal("source revision changed");
  const initial = checkedTarget(checkpoint);
  if (ASSETS.every(name => owned(initial.targetFiles[name], afterState(checkpoint, name)))) return initial.targetFiles;
  if (!equal(initial.targetFiles, checkpoint.expected.targetFiles)) throw new InstallRefusal("stale assets or interrupted install; reobserve or rollback");
  hooks.signal?.throwIfAborted(); journal(checkpoint, "install-started");
  const replaced = new Set<Asset>();
  try {
    for (const name of ASSETS) {
      hooks.signal?.throwIfAborted(); loadCheckpoint(backup, anchor);
      const source = inspect(checkpoint.request);
      if (!equal(source.sourceFiles, checkpoint.expected.sourceFiles) || !equal(source.sourceDirectory, checkpoint.expected.sourceDirectory)) throw new InstallRefusal("source revision changed during install");
      const current = checkedTarget(checkpoint);
      if (ASSETS.some(member => replaced.has(member) ? !owned(current.targetFiles[member], afterState(checkpoint, member)) : !equal(current.targetFiles[member], checkpoint.expected.targetFiles[member]))) throw new InstallRefusal("asset revision changed during install");
      replace(checkpoint, name, current.targetFiles[name], readMember(resolve(backup, `after-${name}`), true).bytes);
      replaced.add(name); journal(checkpoint, "installed", name); hooks.afterReplace?.(name);
    }
    const installed = checkedTarget(checkpoint).targetFiles;
    if (ASSETS.some(name => !owned(installed[name], afterState(checkpoint, name)))) throw new InstallRefusal("installed readback mismatch");
    journal(checkpoint, "installed-all"); return installed;
  } catch (error) {
    try { rollback(backup, anchor); }
    catch (recoveryError) { throw new InstallFailure(message(error), false, message(recoveryError)); }
    throw new InstallFailure(message(error), true, null);
  }
}
function main(args: readonly string[]): void {
  const [command, path, anchor] = args;
  if (!path) throw new InstallRefusal("observe|prepare REQUEST.json or install|rollback BACKUP SHA256 required");
  switch (command) {
    case "observe": case "prepare": {
      if (args.length !== 2) throw new InstallRefusal("unexpected arguments");
      const request = parseRequest(JSON.parse(readMember(resolve(path)).bytes.toString("utf8")));
      console.log(JSON.stringify(command === "observe" ? { observation: observe(request) } : prepare(request))); return;
    }
    case "install": case "rollback":
      if (args.length !== 3 || !anchor) throw new InstallRefusal("backup and trusted anchor required");
      console.log(JSON.stringify({ operation: command, assets: command === "install" ? install(path, anchor) : rollback(path, anchor), settingsWritten: false })); return;
    default: throw new InstallRefusal("unknown command");
  }
}
if (import.meta.main) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(JSON.stringify({ error: message(error), ...(error instanceof InstallFailure ? { rolledBack: error.rolledBack, recoveryFailure: error.recoveryFailure } : {}) }));
    process.exitCode = 1;
  }
}
