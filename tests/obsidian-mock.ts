/* global Bun -- the bun test runtime */
import { mock } from "bun:test";

// The Obsidian runtime, which bun does not have. bunfig.toml preloads this once, before any test file loads:
// bun shares one module registry across test files and fixes a module's export names at its first import,
// so a per-file "obsidian" mock only works if that file happens to load first. The arrays are what the tests read back.
export const modals: unknown[] = [];
export const notices: string[] = [];
export const rendered: string[] = [];
await mock.module("obsidian", () => ({
  ItemView: class {
    app = { workspace: { requestSaveLayout: () => undefined } };
    getState() { return {}; }
    setState() { return Promise.resolve(); }
    onClose() { return Promise.resolve(); }
    registerInterval() { return 0; }
  },
  Modal: class { constructor(public app: unknown) { /* stub */ } open() { modals.push(this); } close() { /* stub */ } setTitle() { /* stub */ } },
  Component: class {},
  AbstractInputSuggest: class {},
  FuzzySuggestModal: class { constructor(public app: unknown) { /* stub */ } setPlaceholder() { /* stub */ } open() { modals.push(this); } },
  TFile: class {},
  TFolder: class {},
  Menu: class {},
  Setting: class {},
  SuggestModal: class {},
  Notice: class { constructor(text: string) { notices.push(text); } },
  setIcon: () => undefined,
  setTooltip: () => undefined,
  parseYaml: Bun.YAML.parse,
  MarkdownRenderer: { render: (_app: unknown, _md: string, _el: unknown, sourcePath: string) => void rendered.push(sourcePath) },
}));
