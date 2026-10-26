import { FuzzySuggestModal, TFile, TFolder, type App, type FuzzyMatch, type TAbstractFile } from "obsidian";

type Entry = { readonly item: TAbstractFile; readonly tag?: "Up" | "Open" | "Recent" };

/** Browse one folder at a time, never the whole vault; the root also offers the open and recent files. */
export class VaultFilePicker extends FuzzySuggestModal<Entry> {
  constructor(app: App, private readonly folder: TFolder, private readonly pick: (file: TFile) => void) {
    super(app);
    this.setPlaceholder(folder.isRoot() ? "Attach a vault file…" : `Attach from ${folder.path}/…`);
  }

  getItems(): Entry[] {
    const { folder, app } = this, entries: Entry[] = [];
    if (folder.parent) entries.push({ item: folder.parent, tag: "Up" });
    if (folder.isRoot()) {
      const active = app.workspace.getActiveFile(), seen = new Set<string>();
      if (active) { entries.push({ item: active, tag: "Open" }); seen.add(active.path); }
      for (const path of app.workspace.getLastOpenFiles()) {
        const file = app.vault.getFileByPath(path);
        if (file && !seen.has(path)) { entries.push({ item: file, tag: "Recent" }); seen.add(path); }
      }
    }
    const children = [...folder.children].sort((a, b) =>
      Number(b instanceof TFolder) - Number(a instanceof TFolder) || a.name.localeCompare(b.name));
    for (const item of children) entries.push({ item });
    return entries;
  }

  getItemText({ item, tag }: Entry): string {
    if (tag === "Up") return "..";
    if (tag) return item.path;
    return item instanceof TFolder ? `${item.name}/` : item.name;
  }

  override renderSuggestion(match: FuzzyMatch<Entry>, el: HTMLElement): void {
    super.renderSuggestion(match, el);
    const { tag } = match.item;
    if (tag && tag !== "Up") el.createSpan({ cls: "hm-picker-tag", text: tag });
  }

  onChooseItem({ item }: Entry): void {
    if (item instanceof TFolder) new VaultFilePicker(this.app, item, this.pick).open();
    else if (item instanceof TFile) this.pick(item);
  }
}
