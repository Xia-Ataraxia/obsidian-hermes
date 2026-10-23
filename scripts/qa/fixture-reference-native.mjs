import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import postcss from 'postcss';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
const sha256 = value => createHash('sha256').update(value).digest('hex');
export async function nativeReferenceAssets(root) {
  const vendor=resolve(root,'src/vendor/hermes-kanban');
  const provenance=JSON.parse(await readFile(resolve(vendor,'provenance.json'),'utf8'));
  const files={};
  for(const name of ['upstream.js','upstream.css','upstream-host.css']){
    files[name]=await readFile(resolve(vendor,name),'utf8');
    if(sha256(files[name])!==provenance.sourcePins[name])throw Error('Native reference source mismatch: '+name);
  }
  const packageRoot=resolve(root,'node_modules/@nous-research/ui');
  const pkg=JSON.parse(await readFile(resolve(packageRoot,'package.json'),'utf8'));
  if(pkg.version!=='0.18.2'||pkg.license!=='MIT')throw Error('Native SDK pin mismatch');
  const bundled=await build({entryPoints:[resolve(root,'scripts/qa/fixture-reference-primitives.ts')],absWorkingDir:root,bundle:true,write:false,metafile:true,platform:'browser',format:'esm',target:'es2022',minify:true,legalComments:'inline',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'unused-optional-native-peers',setup(b){b.onResolve({filter:/^(three|gsap|leva)$/},({path})=>({path,external:true,sideEffects:false}));}}]});
  const output=Object.values(bundled.metafile.outputs)[0];
  if(output.imports.length)throw Error('Unpackaged native SDK dependency');
  const sources=[];
  async function visit(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=resolve(dir,entry.name);if(entry.isDirectory())await visit(path);else if(entry.name.endsWith('.js'))sources.push({path,content:await readFile(path,'utf8')});}}
  await visit(resolve(packageRoot,'dist'));
  sources.sort((a,b)=>a.path.localeCompare(b.path));
  const host=postcss.parse(files['upstream-host.css']);
  host.walkAtRules(rule=>{if(['import','source','font-face'].includes(rule.name))rule.remove();});
  // Only the approved exclusion of unlicensed font binaries changes the native stylesheet.
  // Native layers, variables, utility names, control preflight and portal selectors remain untouched.
  const input='@import "tailwindcss" source(none);\n@import "@nous-research/ui/styles/globals.css";\n'+host+'\n'+files['upstream.css']+'\n:root { --font-sans: system-ui; --theme-font-sans: system-ui; --font-mono: ui-monospace, monospace; --theme-font-mono: ui-monospace, monospace; --font-rules-compressed: system-ui; --font-rules-expanded: system-ui; --font-mondwest: system-ui; }';
  const dependencies=[];
  const compiler=await compile(input,{base:root,onDependency(path){dependencies.push(path);}});
  const candidates=new Scanner({}).scanFiles([{content:files['upstream.js'],extension:'js'},...sources.map(s=>({content:s.content,extension:'js'}))]).sort();
  const css=compiler.build(candidates);
  if(/@(?:import|font-face|source|theme|utility)\b/.test(css))throw Error('Unresolved native CSS directive');
  for(const match of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi))if(!match[2].startsWith('data:'))throw Error('Nonlocal native asset URL');
  const runtime=bundled.outputFiles[0].contents;
  const inputs={};
  for(const path of [...new Set([...Object.keys(bundled.metafile.inputs).filter(p=>!p.startsWith("(disabled):")).map(p=>resolve(root,p)),...dependencies,...sources.map(s=>s.path),resolve(root,'bun.lock')])].sort())inputs[relative(root,path)]=sha256(await readFile(path));
  return {css,runtime,receipt:{schemaVersion:1,authority:'Independent pinned native compilation; no adapted port CSS/reset/namespace transform',sourcePins:provenance.sourcePins,uiVersion:pkg.version,virtualInputs:Object.keys(bundled.metafile.inputs).filter(p=>p.startsWith("(disabled):")),inputs,candidateCount:candidates.length,outputs:{css:sha256(css),primitives:sha256(runtime)},fontAdaptation:'Font binaries excluded; system-ui/ui-monospace fallback only',transformations:['omit font imports and font-face declarations','explicit system font fallback'],portAssetsConsumed:[]}};
}
