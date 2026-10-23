import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { arch, hostname, userInfo } from "node:os";
import { ownedFixturePath, ownedPath, verifyFixtureHost, verifyIdentity, type HostIdentity } from "../qa/fixture-guard";

export const ASSETS = ["main.js", "manifest.json", "styles.css"] as const;
export type Asset = typeof ASSETS[number];
export class InstallRefusal extends Error {
  override readonly name = "InstallRefusal";
  constructor(readonly reason: string) { super(reason); }
}
export type FileState = Readonly<{ sha256: string; bytes: number; mode: number; uid: number; gid: number; revision: string }>;
export type DirectoryState = Readonly<{ mode: number; uid: number; gid: number; revision: string }>;
export type AssetStates = Readonly<Record<Asset, FileState>>;
export type Observation = Readonly<{ sourceDirectory: DirectoryState; targetDirectory: DirectoryState; sourceFiles: AssetStates; targetFiles: AssetStates; settings: FileState | null }>;
export type Request = Readonly<{ mode: "live-m3" | "fixture-m1" | "fixture-ci"; host: HostIdentity; source: string; target: string; backup: string; expected?: Observation }>;
export const digest = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InstallRefusal("object required");
  return Object.fromEntries(Object.entries(value));
}
export function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new InstallRefusal("invalid membership");
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new InstallRefusal("nonempty string required");
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new InstallRefusal("nonnegative integer required");
  return value;
}
function directoryState(value: unknown): DirectoryState {
  const item = record(value); keys(item, ["mode", "uid", "gid", "revision"]);
  return { mode: integer(item.mode), uid: integer(item.uid), gid: integer(item.gid), revision: text(item.revision) };
}
function fileState(value: unknown): FileState {
  const item = record(value); keys(item, ["sha256", "bytes", "mode", "uid", "gid", "revision"]);
  const sha256 = text(item.sha256);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new InstallRefusal("SHA256 required");
  return { sha256, bytes: integer(item.bytes), mode: integer(item.mode), uid: integer(item.uid), gid: integer(item.gid), revision: text(item.revision) };
}
function assetStates(value: unknown): AssetStates {
  const item = record(value); keys(item, ASSETS);
  return { "main.js": fileState(item["main.js"]), "manifest.json": fileState(item["manifest.json"]), "styles.css": fileState(item["styles.css"]) };
}
function observation(value: unknown): Observation {
  const item = record(value); keys(item, ["sourceDirectory", "targetDirectory", "sourceFiles", "targetFiles", "settings"]);
  return { sourceDirectory: directoryState(item.sourceDirectory), targetDirectory: directoryState(item.targetDirectory), sourceFiles: assetStates(item.sourceFiles), targetFiles: assetStates(item.targetFiles), settings: item.settings === null ? null : fileState(item.settings) };
}
export function parseRequest(value: unknown): Request {
  const item = record(value); keys(item, ["mode", "host", "source", "target", "backup"], ["expected"]);
  if (item.mode !== "live-m3" && item.mode !== "fixture-m1" && item.mode !== "fixture-ci") throw new InstallRefusal("explicit deployment mode required");
  const host = record(item.host); keys(host, ["platform", "hardware", "user", "hostname"]);
  return { mode: item.mode, host: { platform: text(host.platform), hardware: text(host.hardware), user: text(host.user), hostname: text(host.hostname) },
    source: text(item.source), target: text(item.target), backup: text(item.backup), ...(item.expected === undefined ? {} : { expected: observation(item.expected) }) };
}
export function readHost(): HostIdentity {
  const run = (binary: string, args: string[]) => execFileSync(binary, args, { encoding: "utf8", timeout: 5000, maxBuffer: 4096 }).trim();
  if (process.platform === "linux") {
    verifyFixtureHost();
    return { platform: "linux", hardware: arch(), user: userInfo().username, hostname: hostname() };
  }
  if (process.platform !== "darwin") throw new InstallRefusal("macOS host required");
  return { platform: process.platform, hardware: run("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"]), user: run("/usr/bin/id", ["-un"]), hostname: run("/bin/hostname", []) };
}
function unknownMode(mode: never): never { throw new InstallRefusal(`unsupported deployment mode: ${String(mode)}`); }
export function verifyDeploymentIdentity(mode: Request["mode"], actual: HostIdentity, ci: boolean): void {
  switch (mode) {
    case "live-m3":
      if (actual.platform !== "darwin" || actual.hardware !== "Apple M3 Max" || actual.user !== "beomsu" || actual.hostname !== "Beomsuui-MacBookPro.local") throw new InstallRefusal("authorized M3 identity required");
      return;
    case "fixture-m1": verifyIdentity(actual); return;
    case "fixture-ci":
      if (actual.platform !== "linux" || !ci || !actual.hardware || !actual.user || !actual.hostname) throw new InstallRefusal("explicit Linux CI identity required");
      return;
    default: return unknownMode(mode);
  }
}
export function verifyAuthority(request: Request, actual: HostIdentity): void {
  verifyDeploymentIdentity(request.mode, actual, process.env.CI === "true");
  switch (request.mode) {
    case "live-m3":
      if (request.target !== "/Users/beomsu/Documents/Obsidian/Ataraxia/.obsidian/plugins/hermes-cron-viewer") throw new InstallRefusal("authorized M3 target required");
      if (beneath(request.source, "/Users/beomsu/Documents/Obsidian/Ataraxia") || beneath(request.backup, "/Users/beomsu/Documents/Obsidian/Ataraxia")) throw new InstallRefusal("staging and recovery must be outside the vault");
      break;
    case "fixture-m1":
      [request.target, request.source, request.backup].forEach(ownedPath);
      if (!request.target.endsWith("/.obsidian/plugins/hermes-cron-viewer")) throw new InstallRefusal("fixture plugin target required");
      break;
    case "fixture-ci":
      if (verifyFixtureHost().platform !== "linux") throw new InstallRefusal("CI fixture unavailable on this host");
      [request.target, request.source, request.backup].forEach(ownedFixturePath);
      if (!request.target.endsWith("/.obsidian/plugins/hermes-cron-viewer")) throw new InstallRefusal("fixture plugin target required");
      break;
    default: return unknownMode(request.mode);
  }
  if (Object.keys(actual).some(key => record(actual)[key] !== record(request.host)[key])) throw new InstallRefusal("host differs from observed authorization");
}
export function canonical(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new InstallRefusal("canonical absolute path required");
  for (let ancestor = path; ancestor !== dirname(ancestor); ancestor = dirname(ancestor)) {
    const info = lstatSync(ancestor, { throwIfNoEntry: false });
    if (info && (info.isSymbolicLink() || realpathSync(ancestor) !== ancestor)) throw new InstallRefusal("symlink path refused");
  }
}
function beneath(path: string, parent: string): boolean {
  const child = relative(parent, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
export function directory(path: string, privateOnly = false): DirectoryState {
  canonical(path);
  const info = lstatSync(path, { bigint: true });
  const mode = Number(info.mode & 0o7777n);
  if (!info.isDirectory() || Number(info.uid) !== process.getuid?.() || (privateOnly ? mode !== 0o700 : mode & 0o7022)) throw new InstallRefusal("directory ownership or mode refused");
  return { mode, uid: Number(info.uid), gid: Number(info.gid), revision: `${info.dev}:${info.ino}` };
}
export function readMember(path: string, privateOnly = false): { readonly bytes: Buffer; readonly state: FileState } {
  canonical(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    const revision = `${before.dev}:${before.ino}:${before.mtimeNs}:${before.ctimeNs}`;
    const mode = Number(before.mode & 0o7777n);
    if (!before.isFile() || before.nlink !== 1n || Number(before.uid) !== process.getuid?.() || mode & (privateOnly ? 0o7177 : 0o7111 | 0o022) || before.size > 64n * 1024n * 1024n) throw new InstallRefusal("file ownership, mode, size or hardlink refused");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const bytes = buffer.subarray(0, offset);
    const after = lstatSync(path, { bigint: true });
    if (revision !== `${after.dev}:${after.ino}:${after.mtimeNs}:${after.ctimeNs}` || bytes.length !== Number(before.size)) throw new InstallRefusal("member changed while reading");
    return { bytes, state: { sha256: digest(bytes), bytes: bytes.length, mode, uid: Number(before.uid), gid: Number(before.gid), revision } };
  } finally { closeSync(fd); }
}
export function membership(path: string, names: readonly string[]): void {
  const actual = readdirSync(path).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...names].sort())) throw new InstallRefusal("directory membership changed");
}
export function targetState(request: Request): Pick<Observation, "targetDirectory" | "targetFiles" | "settings"> {
  const targetDirectory = directory(request.target);
  const data = resolve(request.target, "data.json"); canonical(data);
  const settings = lstatSync(data, { throwIfNoEntry: false }) ? readMember(data).state : null;
  membership(request.target, [...ASSETS, ...(settings ? ["data.json"] : [])]);
  const targetFiles = readAssets(request.target);
  return { targetDirectory, targetFiles, settings };
}
function readAssets(path: string): AssetStates {
  return { "main.js": readMember(resolve(path, "main.js")).state, "manifest.json": readMember(resolve(path, "manifest.json")).state, "styles.css": readMember(resolve(path, "styles.css")).state };
}
export function inspect(request: Request): Observation {
  guardPaths(request);
  const sourceDirectory = directory(request.source); membership(request.source, ASSETS);
  const sourceFiles = readAssets(request.source);
  const manifest = record(JSON.parse(readMember(resolve(request.source, "manifest.json")).bytes.toString("utf8")));
  if (manifest.id !== "hermes-cron-viewer") throw new InstallRefusal("wrong plugin manifest");
  return { sourceDirectory, sourceFiles, ...targetState(request) };
}
export function guardPaths(request: Request): void {
  const paths = [request.source, request.target, request.backup]; paths.forEach(canonical);
  if (paths.some((path, index) => paths.some((other, otherIndex) => index !== otherIndex && beneath(path, other)))) throw new InstallRefusal("overlapping paths refused");
  directory(dirname(request.backup), true);
  directory(dirname(request.target)); directory(dirname(dirname(request.target)));
}
export function equal(left: unknown, right: unknown): boolean { return isDeepStrictEqual(left, right); }
export function owned(current: FileState, expected: FileState): boolean {
  return current.sha256 === expected.sha256 && current.bytes === expected.bytes && current.mode === expected.mode && current.uid === expected.uid && current.gid === expected.gid;
}
