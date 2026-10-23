import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const M1_BASE = "/private/tmp/hermes-control-center-m1-01a161c0";
export const CI_BASE = "/tmp/hermes-control-center-ci";
export class FixtureRefusal extends Error {
  constructor(readonly reason: string) { super(reason); this.name = "FixtureRefusal"; }
}
export type HostIdentity = { readonly platform: string; readonly hardware: string; readonly user: string; readonly hostname: string };
export function verifyIdentity(host: HostIdentity): void {
  if (host.platform !== "darwin" || host.hardware !== "Apple M1 Pro" || host.user !== "beomsu" || host.hostname !== "xia.local") {
    throw new FixtureRefusal("verified M1 Pro / beomsu / xia.local required");
  }
}
export function verifyHost(): HostIdentity {
  if (process.platform !== "darwin") throw new FixtureRefusal("verified M1 Pro host required");
  const host = { platform: process.platform,
    hardware: execFileSync("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).trim(),
    user: execFileSync("/usr/bin/id", ["-un"], { encoding: "utf8" }).trim(),
    hostname: execFileSync("/bin/hostname", [], { encoding: "utf8" }).trim() };
  verifyIdentity(host);
  return host;
}
export function verifyFixtureHost(): HostIdentity | { readonly platform: "linux"; readonly ci: true } {
  if (process.platform === "linux" && process.env.CI === "true") return { platform: "linux", ci: true };
  return verifyHost();
}
export function fixtureBase(): string {
  return verifyFixtureHost().platform === "linux" ? CI_BASE : M1_BASE;
}
export function ownedFixturePath(raw: string): string {
  if (!isAbsolute(raw) || resolve(raw) !== raw) throw new FixtureRefusal("fixture path must be absolute and canonical");
  return pathBeneath(raw, fixtureBase());
}
export function ownedPath(raw: string): string {
  return pathBeneath(raw, M1_BASE);
}
function pathBeneath(raw: string, base: string): string {
  const path = resolve(raw);
  const child = relative(base, path);
  if (!child || child.startsWith(`..${sep}`) || child === ".." || isAbsolute(child)) throw new FixtureRefusal("path outside owned fixture namespace");
  if (path.split(sep).some(part => [".hermes", "Obsidian", "Library", "Dropbox", "OneDrive", "iCloud"].includes(part))) throw new FixtureRefusal("live or synced path refused");
  for (let ancestor = path; ancestor !== dirname(ancestor); ancestor = dirname(ancestor)) {
    const stat = lstatSync(ancestor, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || realpathSync(ancestor) !== ancestor)) throw new FixtureRefusal("symlink path refused");
  }
  return path;
}
export function verifyVault(path: string): void {
  verifyVaultWithPath(path, ownedPath);
}
export function verifyFixtureVault(path: string): void {
  verifyVaultWithPath(path, ownedFixturePath);
}
function verifyVaultWithPath(path: string, checkPath: (raw: string) => string): void {
  checkPath(path);
  const config = resolve(path, ".obsidian");
  checkPath(config);
  const corePath = resolve(config, "core-plugins.json");
  checkPath(corePath);
  if (existsSync(corePath)) {
    const core: unknown = JSON.parse(readFileSync(corePath, "utf8"));
    if (Array.isArray(core) ? core.includes("sync") : isRecord(core) && core.sync === true) throw new FixtureRefusal("sync-enabled vault refused");
  }
  if (existsSync(resolve(config, "sync.json"))) throw new FixtureRefusal("sync configuration refused");
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
