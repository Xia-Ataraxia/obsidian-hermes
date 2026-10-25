import { build, context } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

const prod = process.argv[2] === "production";
const styles = ["src/ui/viewer.css", "src/hermes/hermes.css"];

/** Obsidian supplies these at runtime; bundling them would break the plugin. */
const external = [
  "obsidian",
  "electron",
  "node:child_process",
  "node:os",
  "node:path",
  "node:fs",
  "node:fs/promises",
];

async function copyStatic() {
  await mkdir("dist", { recursive: true });
  await copyFile("manifest.json", "dist/manifest.json");
  const css = await Promise.all(styles.map(path => readFile(path, "utf8")));
  await writeFile("dist/styles.css", css.join("\n"));
}

const options = {
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  minify: prod,
  treeShaking: true,
  external,
  plugins: [{ name: "copy-static", setup: b => b.onEnd(copyStatic) }],
};

if (prod) {
  await build(options);
} else {
  const ctx = await context(options);
  await ctx.watch();
}
