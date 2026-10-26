import { expect, test } from "bun:test";
import { TFile, TFolder, type App } from "obsidian";
import { VaultFilePicker } from "../src/hermes/vault-picker";
import { modals } from "./obsidian-mock";

const node = <T extends object>(Kind: new () => T, path: string, parent: TFolder | null, children: unknown[] = []): T =>
  Object.assign(new Kind(), { path, name: path.split("/").pop() || "/", parent, children, isRoot: () => parent === null });

test("the attach picker lists one folder at a time plus open and recent files, never the whole vault", () => {
  const root = node(TFolder, "/", null), sub = node(TFolder, "sub", root);
  const top = node(TFile, "b.md", root), deep = node(TFile, "sub/deep.md", sub);
  root.children = [top, sub]; sub.children = [deep];
  const files = new Map([["sub/deep.md", deep], ["b.md", top]]);
  const app = {
    vault: { getFileByPath: (p: string) => files.get(p) ?? null },
    workspace: { getActiveFile: () => top, getLastOpenFiles: () => ["sub/deep.md", "b.md", "gone.md"] },
  } as unknown as App;
  const picked: TFile[] = [];
  const picker = new VaultFilePicker(app, root, f => picked.push(f));
  const rootItems = picker.getItems();
  expect(rootItems.map(e => [picker.getItemText(e), e.tag])).toEqual([
    ["b.md", "Open"], ["sub/deep.md", "Recent"], ["sub/", undefined], ["b.md", undefined],
  ]);

  picker.onChooseItem(rootItems[2]!);
  const inner = modals.at(-1) as VaultFilePicker;
  expect(inner.getItems().map(e => inner.getItemText(e))).toEqual(["..", "deep.md"]);
  inner.onChooseItem(inner.getItems()[1]!);
  expect(picked).toEqual([deep]);
});
