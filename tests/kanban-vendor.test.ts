import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const setup = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SOURCE_PINS, PRIMITIVES, factorySource, verifySources, sha256 } from './src/vendor/hermes-kanban/build-factory.mjs';
const vendor = path.resolve('src/vendor/hermes-kanban');
const manifest = JSON.parse(fs.readFileSync(path.join(vendor,'provenance.json'),'utf8'));
const files = Object.fromEntries(Object.keys(SOURCE_PINS).map(name => [name,fs.readFileSync(path.join(vendor,name),'utf8')]));
`;

function execute(source: string): void {
  const result = spawnSync(process.execPath, ["--eval", setup + source], {
    cwd: root, encoding: "utf8", timeout: 30000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

describe("native Kanban vendoring boundary", () => {
  test.each(["cancel-confirm", "cancel-summary", "blank", "valid", "mixed", "selection", "board", "unmount", "overlap", "response-stale", "transport-error"])("collects and binds bulk completion summary: %s", scenario => {
    execute(`const { bulkProbe } = await import('./tests/kanban-bulk-probe.mjs'); await bulkProbe(${JSON.stringify(scenario)});`);
  });

  test.each(["mount", "loading", "read-only", "defaults", "failed-read", "malformed", "malformed-roster", "stale", "unmount"])("retains the read-only orchestration surface: %s", scenario => {
    execute(`const { orchestrationProbe } = await import('./tests/kanban-orchestration-probe.mjs'); await orchestrationProbe(${JSON.stringify(scenario)});`);
  });

  test("denies every native orchestration write at the SDK boundary", () => {
    execute(`
      const { nativeSdkRequest } = await import('./src/ui/kanban-sdk-routes.ts');
      for (const [method, path] of [['PUT','/orchestration'], ['PATCH','/profiles/planner'], ['POST','/profiles/planner/describe-auto']]) {
        assert.throws(() => nativeSdkRequest('/api/plugins/kanban'+path, {method, body:'{}'}), /unsupported-operation/);
      }
    `);
  });

  test("exports an inert page when supplied a local SDK without browser globals", () => {
    execute(`
      const before = new Set(Reflect.ownKeys(globalThis));
      assert.equal(typeof globalThis.window, 'undefined');
      const { createNativeKanban } = await import('./src/vendor/hermes-kanban/factory.js');
      const Native = await import('./src/vendor/hermes-kanban/generated/primitives.mjs');
      let effects = 0;
      const effect = () => { effects++; throw Error('Unexpected effect'); };
      const host = Object.fromEntries(['window','document','navigator','WebSocket','URL','setTimeout','clearTimeout','requestAnimationFrame','console'].map(key => [key,effect]));
      const sdk = { React: Native.React, hooks: Native.React, components: Native, utils: { cn: Native.cn, timeAgo: () => 'now' }, fetchJSON: effect, authedFetch: effect, buildWsUrl: effect };
      const component = createNativeKanban(sdk, host);
      assert.equal(typeof component,'function');
      assert.equal(component.name,'KanbanPage');
      assert.equal(Native.React.version,'19.2.7');
      assert.equal(typeof Native.createRoot,'function');
      assert.equal(effects,0);
      assert.deepEqual(Reflect.ownKeys(globalThis).filter(key => !before.has(key)),[]);
    `);
  });

  test("names a missing SDK primitive before any native effects", () => {
    execute(`
      const { createNativeKanban } = await import('./src/vendor/hermes-kanban/factory.js');
      for (const missing of PRIMITIVES) {
        const components = Object.fromEntries(PRIMITIVES.filter(name => name !== missing).map(name => [name,()=>null]));
        assert.throws(() => createNativeKanban({components},{}), new RegExp('Missing Kanban primitive: '+missing));
      }
    `);
  });

  test("rejects tampered executable source without evaluating it", () => {
    execute(`
      const poison = 'globalThis.__vendorPoison = true;';
      assert.throws(() => factorySource({...files,'upstream.js':poison},manifest), /Source hash mismatch: upstream.js/);
      assert.equal(globalThis.__vendorPoison,undefined);
    `);
  });

  test("rejects malformed manifests and unreviewed source hashes", () => {
    execute(`
      for (const candidate of [null,{}, {...manifest,schemaVersion:2}]) {
        assert.throws(() => verifySources(files,candidate), /schemaVersion/);
      }
      for (const name of Object.keys(SOURCE_PINS)) {
        assert.throws(() => verifySources(files,{...manifest,sourcePins:{...manifest.sourcePins,[name]:'0'.repeat(64)}}),new RegExp('Source manifest pin mismatch: '+name.replaceAll('.','\\.')));
      }
      assert.throws(() => verifySources(files,{...manifest,requiredPrimitives:[]}),/requiredPrimitives/);
    `);
  });

  test("rejects a missing stylesheet with its source name", () => {
    execute(`assert.throws(() => verifySources({...files,'upstream.css':''},manifest),/Source hash mismatch: upstream.css/);`);
  });

  test("produces every source-derived utility and detects a removed rule", () => {
    execute(`
      const { verifyStyleCoverage } = await import('./src/vendor/hermes-kanban/build-css.mjs');
      const receipt = JSON.parse(fs.readFileSync(path.join(vendor,'generated/receipt.json'),'utf8'));
      const css = fs.readFileSync(path.join(vendor,'generated/kanban.css'),'utf8');
      assert.ok(receipt.requiredUtilities.length > 100);
      verifyStyleCoverage(css,receipt.requiredUtilities);
      assert.throws(() => verifyStyleCoverage(css,['hcv-required-missing-style']),/Missing Kanban style: hcv-required-missing-style/);
    `);
  });

  test("scopes all outer selectors, resets, keyframes and property registrations", () => {
    execute(`
      const {default:postcss} = await import('postcss');
      const css = fs.readFileSync(path.join(vendor,'generated/kanban.css'),'utf8');
      const ast=postcss.parse(css);
      ast.walkRules(rule => {
        for(let p=rule.parent;p;p=p.parent) if(p.type==='rule'||p.name==='keyframes') return;
        for(const selector of rule.selectors) assert.ok(selector.trim().startsWith('.hcv-kanban-root'),selector);
      });
      ast.walkAtRules(rule => {
        if(['keyframes','property'].includes(rule.name)) assert.match(rule.params,/^(--)?hcv-kanban-/);
        assert.ok(!['import','font-face','source','view-transition'].includes(rule.name),rule.name);
      });
      assert.ok(css.includes('var(--font-interface, system-ui)'));
      assert.ok(css.includes('var(--font-monospace, monospace)'));
      assert.ok(!css.includes('url('));
      assert.ok(css.includes('.hermes-kanban-card--selected'));
    `);
  });

  test("ships self-contained primitives and exact receipt hashes without dynamic code execution", () => {
    execute(`
      const receipt=JSON.parse(fs.readFileSync(path.join(vendor,'generated/receipt.json'),'utf8'));
      for(const [name,expected] of Object.entries(receipt.outputHashes)) {
        const file=path.join(vendor,name==='factory.js'?name:'generated/'+name);
        assert.equal(sha256(fs.readFileSync(file)),expected,name);
      }
      const runtime=fs.readFileSync(path.join(vendor,'generated/primitives.mjs'),'utf8');
      const ts=await import('typescript');
      const tree=ts.createSourceFile('primitives.mjs',runtime,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
      function inspect(node) {
        assert.ok(!ts.isImportDeclaration(node));
        assert.ok(!(ts.isExportDeclaration(node)&&node.moduleSpecifier));
        if(ts.isCallExpression(node)) {
          assert.notEqual(node.expression.kind,ts.SyntaxKind.ImportKeyword);
          assert.notEqual(node.expression.getText(tree),'eval');
          assert.notEqual(node.expression.getText(tree),'Function');
        }
        if(ts.isNewExpression(node)) assert.notEqual(node.expression.getText(tree),'Function');
        ts.forEachChild(node,inspect);
      }
      inspect(tree);
      const inventory=JSON.parse(fs.readFileSync(path.join(vendor,'generated/license-inventory.json'),'utf8'));
      assert.equal(inventory.find(x=>x.name==='@nous-research/ui').version,'0.18.2');
      assert.equal(inventory.filter(x=>x.name==='react').length,1);
      assert.equal(inventory.filter(x=>x.name==='react-dom').length,1);
      assert.ok(fs.statSync(path.join(vendor,'generated/THIRD-PARTY-NOTICES.txt')).size>1000);
    `);
  });

  test("removes stale output on rejected fixture source while preserving other files", () => {
    execute(`
      const os=await import('node:os');
      const {prepareKanban}=await import('./src/vendor/hermes-kanban/build.mjs');
      const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'kanban-vendor-'));
      try {
        const target=path.join(tmp,'src/vendor/hermes-kanban');
        fs.mkdirSync(path.dirname(target),{recursive:true});
        fs.cpSync(vendor,target,{recursive:true});
        fs.writeFileSync(path.join(tmp,'unrelated.txt'),'keep');
        fs.writeFileSync(path.join(target,'upstream.js'),'globalThis.__vendorPoison=true');
        await assert.rejects(prepareKanban(tmp),/Source hash mismatch: upstream.js/);
        assert.equal(fs.existsSync(path.join(target,'factory.js')),false);
        assert.equal(fs.existsSync(path.join(target,'generated')),false);
        assert.equal(fs.readFileSync(path.join(tmp,'unrelated.txt'),'utf8'),'keep');
      } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
    `);
  });

  test("rebuilds deterministically from pinned inputs", () => {
    execute(`
      const {prepareKanban}=await import('./src/vendor/hermes-kanban/build.mjs');
      const before=fs.readFileSync(path.join(vendor,'generated/receipt.json'),'utf8');
      await prepareKanban();
      assert.equal(fs.readFileSync(path.join(vendor,'generated/receipt.json'),'utf8'),before);
    `);
  });

  test("preserves the upstream copies after every build", () => {
    const js = readFileSync(resolve(root, "src/vendor/hermes-kanban/upstream.js"), "utf8");
    expect(js.length).toBeGreaterThan(100000);
    execute("verifySources(files,manifest);");
  });
});
