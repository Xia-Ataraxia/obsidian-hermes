import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { build, stop } from "esbuild";
import { nativeReferenceAssets } from "./fixture-reference-native.mjs";
import { FixtureRefusal } from "./fixture-guard";

export async function referenceAssets() {
  const vendor = resolve(import.meta.dir, "../../src/vendor/hermes-kanban");
  const upstream = readFileSync(resolve(vendor, "upstream.js"));
  if (createHash("sha256").update(upstream).digest("hex") !== "c316f2e7155b288de8dd709fd8975e9dbc3af6d59a255c74039ce401fd121a3a") throw new FixtureRefusal("upstream reference hash mismatch");
  const native = await nativeReferenceAssets(resolve(import.meta.dir, "../.."));
  const sdk = await build({ entryPoints: [resolve(import.meta.dir, "fixture-reference-entry.ts")], bundle: true, write: false, platform: "browser", format: "esm", target: "es2022", logLevel: "silent", plugins: [{ name: "pinned-sdk", setup(builder) { builder.onResolve({ filter: /fixture-reference-primitives$/ }, () => ({ path: "/reference/primitives.mjs", external: true })); } }] });
  const script = sdk.outputFiles[0];
  stop();
  if (!script) throw new FixtureRefusal("reference SDK build absent");
  const styles = Buffer.from(native.css);
  const assets = new Map([
    ["/reference", { type: "text/html", bytes: Buffer.from('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/reference/styles.css"></head><body><div id="reference" class="hcv-kanban-root"></div><script type="module" src="/reference/sdk.js"></script></body></html>') }],
    ["/reference/upstream.js", { type: "text/javascript", bytes: upstream }],
    ["/reference/sdk.js", { type: "text/javascript", bytes: Buffer.from(script.contents) }],
    ["/reference/primitives.mjs", { type: "text/javascript", bytes: Buffer.from(native.runtime) }],
    ["/reference/provenance.json", { type: "application/json", bytes: Buffer.from(JSON.stringify(native.receipt)) }],
    ["/reference/styles.css", { type: "text/css", bytes: styles }],
  ]);
  return (path: string) => {
    const asset = assets.get(path);
    return asset ? new Response(asset.bytes, { headers: { "content-type": asset.type, "cache-control": "no-store" } }) : undefined;
  };
}
