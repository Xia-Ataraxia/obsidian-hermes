import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { build } from "esbuild";
import { SOURCE_PINS, PRIMITIVES, factorySource, sha256 } from "./build-factory.mjs";
import { buildCss, namespaceVariables } from "./build-css.mjs";

export const nativeTokenPlugin = {
  name: "kanban-inline-tokens",
  setup(builder) {
    builder.onResolve({ filter: /^(three|gsap|leva)$/ }, ({ path }) => ({ path, external: true, sideEffects: false }));
    builder.onLoad({ filter: /[/\\]@nous-research[/\\]ui[/\\].*\.js$/ }, async ({ path }) => ({
      contents: namespaceVariables((await readFile(path, "utf8")).replace(/\/\/# sourceMappingURL=.*$/gm, "")), loader: "js",
    }));
  },
};

export async function prepareKanban(root = process.cwd()) {
  const vendor = resolve(root, "src/vendor/hermes-kanban");
  const generated = resolve(vendor, "generated");
  // Remove old outputs first so a rejected input cannot leave an apparently valid build.
  await rm(generated, { recursive: true, force: true });
  await rm(resolve(vendor, "factory.js"), { force: true });
  const manifest = JSON.parse(await readFile(resolve(vendor, "provenance.json"), "utf8"));
  const files = Object.fromEntries(await Promise.all(Object.keys(SOURCE_PINS).map(async (name) => [name, await readFile(resolve(vendor, name), "utf8")])));
  const factory = factorySource(files, manifest);
  const uiManifest = JSON.parse(await readFile(resolve(root, "node_modules/@nous-research/ui/package.json"), "utf8"));
  if (uiManifest.version !== "0.18.2" || uiManifest.license !== "MIT") throw new Error("Unsupported license/version: @nous-research/ui");
  const bundled = await build({ entryPoints: [resolve(vendor, "primitives.ts")], bundle: true, platform: "browser", format: "esm", target: "es2022", write: false, metafile: true, minify: true, legalComments: "inline", define: { "process.env.NODE_ENV": '"production"' }, plugins: [nativeTokenPlugin] });
  const runtime = bundled.outputFiles[0].text;
  const emitted = Object.values(bundled.metafile.outputs)[0];
  if (emitted.imports.length) throw new Error(`Unpackaged Kanban dependency: ${emitted.imports.map((item) => item.path).join(", ")}`);
  const usedInputs = Object.entries(emitted.inputs).filter(([, value]) => value.bytesInOutput > 0).map(([path]) => path);
  const uiInputs = usedInputs.filter((path) => path.includes("@nous-research/ui/")).sort();
  const sourceContents = [files["upstream.js"], ...await Promise.all(uiInputs.map((path) => readFile(resolve(root, path), "utf8")))];
  const { css, requiredUtilities } = await buildCss(files, sourceContents, root);
  const packages = new Map();
  for (const input of usedInputs) {
    let directory = dirname(resolve(root, input));
    while (directory.startsWith(resolve(root, "node_modules"))) {
      try {
        const data = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
        if (data.name && data.version) { packages.set(data.name, { directory, data }); break; }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      directory = dirname(directory);
    }
  }
  const tailwindDirectory = resolve(root, "node_modules/tailwindcss");
  packages.set("tailwindcss", { directory: tailwindDirectory, data: JSON.parse(await readFile(resolve(tailwindDirectory, "package.json"), "utf8")) });
  const inventory = [];
  const notices = [files.LICENSE];
  for (const [name, { directory, data }] of [...packages].sort()) {
    if (!["MIT", "Apache-2.0", "ISC", "0BSD", "BSD-2-Clause", "BSD-3-Clause"].includes(data.license)) throw new Error(`Missing allowed license: ${name}`);
    const licenseFiles = (await readdir(directory)).filter((name) => /^(license|notice|copying|copyrightnotice)(\.|$)/i.test(name));
    const licenseText = await Promise.all(licenseFiles.map((name) => readFile(resolve(directory, name), "utf8")));
    if (name === "react-remove-scroll-bar" && data.version === "2.3.8" && licenseFiles.length === 0) {
      const notice = await readFile(resolve(vendor, "notices/react-remove-scroll-bar.LICENSE"), "utf8");
      if (sha256(notice) !== "a79aae0c0f21990d9d963bb3c5a79cdcea9a46f8523ba55c58d7fe776b6ebc84") throw new Error("License notice hash mismatch: react-remove-scroll-bar");
      licenseFiles.push("notices/react-remove-scroll-bar.LICENSE");
      licenseText.push(notice);
    }
    if (licenseFiles.length === 0 && name !== "@nous-research/ui") throw new Error(`Missing license notice: ${name}`);
    inventory.push({ name, version: data.version, license: data.license, licenseFiles, source: name === "@nous-research/ui" ? manifest.uiPackage.registry : `https://registry.npmjs.org/${name}/${data.version}`, manifestSha256: sha256(JSON.stringify(data)) });
    notices.push(`${name}@${data.version} (${data.license})\n${licenseText.join("\n") || "Published package declares MIT; copyright holder Nous Research. Font binaries excluded. See provenance.json for registry integrity."}`);
  }
  await mkdir(generated, { recursive: true });
  await writeFile(resolve(vendor, "factory.js"), factory);
  await writeFile(resolve(generated, "primitives.mjs"), runtime);
  await writeFile(resolve(generated, "kanban.css"), css);
  await writeFile(resolve(generated, "license-inventory.json"), JSON.stringify(inventory, null, 2));
  await writeFile(resolve(generated, "THIRD-PARTY-NOTICES.txt"), notices.join("\n\n"));
  const receipt = { schemaVersion: 1, sourcePins: SOURCE_PINS, primitives: PRIMITIVES, requiredUtilities, primitiveSourceFiles: uiInputs, outputHashes: { "factory.js": sha256(factory), "primitives.mjs": sha256(runtime), "kanban.css": sha256(css) }, fonts: manifest.fonts, react: inventory.filter((item) => ["react", "react-dom"].includes(item.name)), assets: [] };
  await writeFile(resolve(generated, "receipt.json"), JSON.stringify(receipt, null, 2));
  return receipt;
}
