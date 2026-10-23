import { dirname, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { ownedFixturePath } from "../scripts/qa/fixture-guard";

export function requireTestPath(name: "HERMES_TEST_ROOT" | "HERMES_TEST_PYTHON" | "HERMES_CONTRACT_SOURCE"): string {
  const raw = process.env[name];
  if (!raw) throw new TypeError(`${name} is required; run the isolated runner after bootstrap`);
  if (!isAbsolute(raw)) throw new TypeError(`${name} must be absolute`);
  const path = name === "HERMES_TEST_PYTHON" ? (ownedFixturePath(dirname(raw)), raw) : ownedFixturePath(raw);
  if (!existsSync(path)) throw new TypeError(`${name} prerequisite is missing`);
  return path;
}
export function testPython(): string { return requireTestPath("HERMES_TEST_PYTHON"); }
