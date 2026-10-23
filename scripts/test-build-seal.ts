import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";

export function buildSeal(root: string): string {
  const paths = ["esbuild.config.mjs", "bun.lock", "package.json", "manifest.json", "main.js", "styles.css"];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = resolve(path, entry.name);
      if (entry.isSymbolicLink()) throw new TypeError("Build source symlink refused");
      if (entry.isDirectory()) walk(full);
      else paths.push(relative(root, full));
    }
  };
  walk(resolve(root, "src"));
  const hash = createHash("sha256");
  for (const path of paths.sort()) hash.update(path).update("\0").update(readFileSync(resolve(root, path))).update("\0");
  return hash.digest("hex");
}
if (import.meta.main) {
  mkdirSync(".omo/test", { recursive: true });
  writeFileSync(".omo/test/build.sha256", buildSeal(process.cwd()) + "\n");
  console.log("Fresh build sealed for isolated regression tests");
}
