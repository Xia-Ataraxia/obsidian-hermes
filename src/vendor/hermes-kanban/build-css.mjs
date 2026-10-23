import postcss from "postcss";
import selectors from "postcss-selector-parser";
import { compile, __unstable__loadDesignSystem } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

export const SCOPE = ".hcv-kanban-root";
const externalVariables = new Set(["--font-interface", "--font-monospace"]);
export const namespaceVariables = (text) => text.replace(/(?<![\w-])--[a-zA-Z][\w-]*/g, (name) => externalVariables.has(name) ? name : `--hcv-kanban-${name.slice(2)}`);

function flattenNativeLayers(ast) {
  const allowed = new Set(["properties", "theme", "base", "components", "utilities"]);
  const layers = new Map();
  ast.walkAtRules("layer", (rule) => {
    if (rule.parent !== ast) throw new Error("Nested Kanban cascade layer");
    const names = rule.params.split(",").map((name) => name.trim());
    if (names.some((name) => !allowed.has(name)) || (rule.nodes && names.length !== 1)) {
      throw new Error("Unsupported Kanban cascade layer");
    }
  });
  ast.walkAtRules("layer", (rule) => {
    const names = rule.params.split(",").map((name) => name.trim());
    for (const name of names) if (!layers.has(name)) layers.set(name, []);
    if (rule.nodes) layers.get(names[0]).push(...rule.nodes.map((node) => node.clone()));
    rule.remove();
  });
  // Obsidian's unlayered rules outrank every named layer. Preserve native layer
  // order before its unlayered overrides, then compete through the scoped selectors.
  ast.prepend([...layers.values()].flat());
}

export function scopeCss(css) {
  const ast = postcss.parse(css);
  const animations = new Map();
  ast.walkAtRules("keyframes", (rule) => {
    animations.set(rule.params, `hcv-kanban-${rule.params}`);
    rule.params = `hcv-kanban-${rule.params}`;
  });
  ast.walkAtRules("view-transition", (rule) => rule.remove());
  flattenNativeLayers(ast);
  // The repeated scope also outranks host control states such as
  // button:not(.clickable-icon):hover without overriding native utility states.
  ast.walkRules((rule) => {
    if (rule.selector.includes("view-transition")) { rule.remove(); return; }
    for (let parent = rule.parent; parent; parent = parent.parent) {
      if (parent.type === "rule" || (parent.type === "atrule" && /keyframes$/.test(parent.name))) return;
    }
    rule.selector = selectors((tree) => {
      tree.each((selector) => {
        let replaced = false;
        selector.walk((node) => {
          if ((node.type === "pseudo" && [":root", ":host"].includes(node.value)) ||
              (node.type === "tag" && ["html", "body"].includes(node.value)) ||
              (node.type === "id" && node.value === "root") ||
              (node.type === "class" && node.value === "hcv-kanban-root")) {
            node.replaceWith(selectors.className({ value: "hcv-kanban-root" }), selectors.className({ value: "hcv-kanban-root" }));
            replaced = true;
          }
        });
        if (!replaced) {
          selector.prepend(selectors.combinator({ value: " " }));
          selector.prepend(selectors.className({ value: "hcv-kanban-root" }));
          selector.prepend(selectors.className({ value: "hcv-kanban-root" }));
        }
      });
    }).processSync(rule.selector);
  });
  ast.walkDecls((decl) => {
    if (/^animation(?:-name)?$/.test(decl.prop) || decl.prop.startsWith("--animate-")) {
      decl.value = decl.value.replace(/[a-zA-Z][\w-]*/g, (word) => animations.get(word) ?? word);
    }
  });
  const result = namespaceVariables(ast.toString());
  if (/@(?:import|font-face|source|theme|utility)\b/.test(result)) throw new Error("Unresolved Kanban style directive");
  for (const match of result.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    if (!match[2].startsWith("data:")) throw new Error("Nonlocal Kanban asset URL");
  }
  return result;
}

export function verifyStyleCoverage(css, requiredUtilities) {
  const classes = new Set();
  postcss.parse(css).walkRules((rule) => {
    selectors((tree) => tree.walkClasses((node) => classes.add(node.value))).processSync(rule.selector);
  });
  for (const candidate of requiredUtilities) {
    if (!classes.has(candidate)) throw new Error(`Missing Kanban style: ${candidate}`);
  }
}

export async function buildCss(files, sourceContents, base) {
  const host = postcss.parse(files["upstream-host.css"]);
  host.walkAtRules((rule) => { if (["import", "source", "font-face"].includes(rule.name)) rule.remove(); });
  const input = `@import "tailwindcss" source(none);\n@import "@nous-research/ui/styles/globals.css";\n${host}\n${files["upstream.css"]}\n@layer base {\n  button, input, select, textarea { box-shadow: none; }\n  input[type="checkbox"] {\n    appearance: auto;\n    color-scheme: normal;\n    background-color: transparent;\n    border: 0 none currentColor;\n    outline: revert;\n  }\n  input[type="checkbox"]::after { content: none; }\n}\n.hermes-kanban-card[draggable="true"] { touch-action: pan-y pinch-zoom; }\n${SCOPE} {
    --font-sans: var(--font-interface, system-ui);
    --theme-font-sans: var(--font-interface, system-ui);
    --font-mono: var(--font-monospace, monospace);
    --theme-font-mono: var(--font-monospace, monospace);
    --font-rules-compressed: var(--font-interface, system-ui);
    --font-rules-expanded: var(--font-interface, system-ui);
    --font-mondwest: var(--font-interface, system-ui);
  }`;
  const options = { base, onDependency() {} };
  const candidates = new Scanner({}).scanFiles(sourceContents.map((content) => ({ content, extension: "js" }))).sort();
  const compiler = await compile(input, options);
  const design = await __unstable__loadDesignSystem(input, { base });
  const requiredUtilities = candidates.filter((candidate) => design.candidatesToCss([candidate])[0] !== null).map(namespaceVariables);
  const css = scopeCss(compiler.build(candidates));
  verifyStyleCoverage(css, requiredUtilities);
  return { css, requiredUtilities };
}
