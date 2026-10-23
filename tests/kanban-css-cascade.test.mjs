import { describe, expect, test } from "bun:test";
import postcss from "postcss";
import { scopeCss } from "../src/vendor/hermes-kanban/build-css.mjs";

describe("native Kanban host cascade boundary", () => {
  test("honors declared layer order and keeps unlayered overrides last", () => {
    const css = scopeCss(`@layer base, utilities;
      @layer utilities { .control { color: cream; } }
      .control { color: teal; }
      @layer base { button { color: black; } }
      @layer base { input { color: white; } }`);
    const values = [];
    postcss.parse(css).walkDecls("color", declaration => { values.push(declaration.value); });
    expect(values).toEqual(["black", "white", "cream", "teal"]);
    expect(css).not.toContain("@layer");
    postcss.parse(css).walkRules(rule => {
      expect(rule.selector.startsWith(".hcv-kanban-root.hcv-kanban-root ")).toBe(true);
    });
  });

  test.each([
    "@layer unknown { button {color:red} }",
    "@layer base { @layer utilities {button {color:red}} }",
    "@media (width > 1px) { @layer utilities {button {color:red}} }",
    "@layer {button {color:red}}",
  ])("rejects unsupported layer structures rather than changing their cascade: %s", css => {
    expect(() => scopeCss(css)).toThrow(/Kanban cascade layer/);
  });

  test("refuses malformed CSS and nonlocal assets without evaluating untrusted text", () => {
    expect(() => scopeCss("button {")).toThrow();
    expect(() => scopeCss('button {background:url(https://invalid.example/image)}')).toThrow(/Nonlocal Kanban asset/);
    expect(() => scopeCss('@import "https://invalid.example/css";')).toThrow(/Unresolved/);
  });

  test("preserves state selectors, scoped tokens and keyframes without new importance", () => {
    const css = scopeCss(`@layer utilities {
      .control:hover { color: var(--cream); }
      .control:focus-visible { box-shadow: 0 0 0 2px var(--cream); }
      .control:disabled { opacity: .5; }
      input[type="checkbox"]:checked::after { content: none; }
    }
    :root { --cream: #ffe6cb; }
    @keyframes pulse { to { opacity: 1; } }
    .control { animation: pulse 1s; }`);
    expect(css).toContain(".hcv-kanban-root.hcv-kanban-root .control:hover");
    expect(css).toContain(".hcv-kanban-root.hcv-kanban-root .control:focus-visible");
    expect(css).toContain(".hcv-kanban-root.hcv-kanban-root .control:disabled");
    expect(css).toContain('.hcv-kanban-root.hcv-kanban-root input[type="checkbox"]:checked::after');
    expect(css).toContain("--hcv-kanban-cream");
    expect(css).toContain("hcv-kanban-pulse");
    expect(css).not.toContain("!important");
  });
});
