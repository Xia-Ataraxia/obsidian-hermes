import { Notice, Scope, setTooltip } from "obsidian";
import { byLeastRecent, EDIT_CAP, type SkillInfo } from "./inspect";
import { renderSafe } from "./markdown";
import { absolute, icon, iconButton, relative } from "./ui";
import { FILTERS, FRONTMATTER, type FileRead, SORTS, SOURCES, choose, fail, hint, message, shows, skeleton, sourceLabel } from "./inspector-common";
import type { ProfileModal } from "./inspector";

export function renderSkills(this: ProfileModal, el: HTMLElement): void {
  const { detail } = this;
  if (!detail) { this.pending(el); return; }
  const open = this.skill === null ? undefined : detail.skills.find(skill => skill.path === this.skill);
  if (open) { this.renderFile(el, open.path, open); return; }
  this.skill = null;
  const tools = el.createDiv("hm-pane-tools");
  const search = tools.createDiv("hm-search");
  icon(search, "search");
  const input = search.createEl("input", { type: "search", placeholder: "Filter skills…", value: this.query });
  const sort: HTMLButtonElement = iconButton(tools, "arrow-up-down", "Sort", () => choose(sort, SORTS, this.sort, value => { this.sort = value; this.renderPane(true); }));
  const filter: HTMLButtonElement = iconButton(tools, "filter", "Filter", () => choose(filter, FILTERS, this.filter, value => { this.filter = value; this.renderPane(true); }), this.filter === "all" ? "" : "is-active");
  const list = el.createDiv("hm-list");
  const draw = (): void => {
    list.empty();
    const q = this.query.toLowerCase();
    const shown = detail.skills.filter(skill => shows(skill, this.filter) && (!q || `${skill.name} ${skill.category} ${skill.description}`.toLowerCase().includes(q)));
    if (!shown.length) { list.createDiv({ cls: "hm-muted hm-pad", text: "No matching skills" }); return; }
    if (this.sort !== "category") {
      const order = this.sort === "name" ? (a: SkillInfo, b: SkillInfo) => a.name.localeCompare(b.name)
        : this.sort === "lru" ? byLeastRecent : (a: SkillInfo, b: SkillInfo) => byLeastRecent(b, a);
      for (const skill of [...shown].sort(order)) this.skillRow(list, skill);
      return;
    }
    const groups = new Map<string, SkillInfo[]>();
    for (const skill of shown) groups.set(skill.category || "other", [...(groups.get(skill.category || "other") ?? []), skill]);
    for (const [cat, members] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      this.fold(list, `group:${cat}${q ? "?" : ""}`, "hm-group", groups.size <= 4 || q !== "", summary => {
        summary.createSpan({ text: cat });
        summary.createSpan({ cls: "hm-count", text: String(members.length) });
      }, body => { for (const skill of members.sort((a, b) => a.name.localeCompare(b.name))) this.skillRow(body, skill); });
    }
  };
  input.addEventListener("input", () => { this.query = input.value; draw(); });
  draw();
}

export function skillRow(this: ProfileModal, parent: HTMLElement, skill: SkillInfo): void {
  const key = `skill:${skill.path}`;
  const on = this.state(key, skill.enabled);
  const row = parent.createDiv({ cls: `hm-row${on ? "" : " is-off"}`, attr: { tabindex: "0" } });
  const openFile = (): void => { this.skill = skill.path; this.renderPane(); };
  row.addEventListener("click", openFile);
  row.addEventListener("keydown", event => { if (event.key === "Enter" && event.target === row) openFile(); });
  const top = row.createDiv("hm-row-top");
  top.createSpan({ cls: "hm-row-name", text: skill.name });
  setTooltip(icon(top, SOURCES[skill.source][0], "hm-icon hm-src"), sourceLabel(skill));
  if (skill.verdict && /caution|danger/i.test(skill.verdict)) setTooltip(icon(top, "alert-triangle", "hm-icon hm-warn"), `Hub scan: ${skill.verdict}`);
  for (const platform of skill.platformOff) setTooltip(top.createSpan({ cls: "hm-tag", text: `${platform} off` }), `Disabled on ${platform}; the global switch can't override it`);
  const used = top.createSpan({ cls: "hm-muted hm-push", text: skill.lastUsed === null ? "never" : relative(skill.lastUsed, this.now) });
  setTooltip(used, skill.lastUsed === null ? "Never used" : `${absolute(skill.lastUsed)} · ${skill.uses} uses`);
  this.toggle(top, on, skill.readOnly, value => {
    this.overrides.set(key, value);
    row.toggleClass("is-off", !value);
    const { alias, profileId } = this;
    void this.host.inspect.toggleSkill(alias, profileId, skill, value).catch(fail).then(outcome => {
      if (!outcome.ok) new Notice(outcome.message);
      if (!this.opened || alias !== this.alias || profileId !== this.profileId) return;
      if (!outcome.ok) this.overrides.delete(key);
      this.detail = this.host.inspect.cached(alias, profileId) ?? this.detail;
      this.renderRail();
      if (!this.editor && this.skill === null) this.renderPane(true);
    });
  }, "Takes effect at the next prompt build");
  if (skill.description) row.createDiv({ cls: "hm-row-desc", text: skill.description });
}

/** A markdown file of the profile, rendered, with an in-place editor; `skill` adds the way back and what editing it means. */
export function renderFile(this: ProfileModal, el: HTMLElement, path: string, skill?: SkillInfo): void {
  const { alias, profileId } = this;
  const bar = el.createDiv("hm-doc-bar");
  if (skill) {
    iconButton(bar, "chevron-left", "Back to skills", () => this.guard(() => { this.skill = null; this.renderPane(); }));
    bar.createSpan({ cls: "hm-doc-title", text: skill.name });
  } else bar.createSpan({ cls: "hm-muted", text: path.replace("memories/", "") });
  let loaded: FileRead | null = null;
  const reload = iconButton(bar, "refresh-cw", "Reload", () => { this.files.delete(path); this.renderPane(true); }, "hm-push");
  const edit = iconButton(bar, "pencil", "Edit", () => { if (loaded) startEdit(loaded); });
  edit.disabled = true;
  if (skill) {
    const src = el.createDiv("hm-skill-src hm-muted");
    icon(src, SOURCES[skill.source][0]);
    src.createSpan({ text: `${sourceLabel(skill)} · ${this.detail ? path.replace(this.detail.home, "~") : path}` });
    const note = hint(skill);
    if (note) el.createDiv({ cls: "hm-hint", text: note });
  }
  const body = el.createDiv("hm-doc markdown-rendered");
  skeleton(body, 3);

  const startEdit = (file: FileRead): void => {
    reload.hide(); edit.hide();
    body.empty(); body.removeClass("markdown-rendered");
    const area = body.createEl("textarea", { cls: "hm-editor", text: file.text });
    const error = body.createDiv("hm-error");
    error.hide();
    this.editor = { path, original: file.text, area };
    const actions = bar.createDiv("hm-doc-actions");
    const cancel = iconButton(actions, "x", "Cancel", () => this.guard(() => this.renderPane(true)));
    const save = iconButton(actions, "check", "Save (⌘↵)", () => void doSave(), "mod-cta");
    const doSave = async (): Promise<void> => {
      if (area.value === file.text) { this.editor = null; this.renderPane(true); return; }
      save.disabled = true;
      const outcome = await this.host.inspect.save(alias, profileId, path, file.sum, area.value).catch(fail);
      save.disabled = false;
      if (!outcome.ok) { error.setText(outcome.message); error.show(); return; }
      this.files.delete(path);
      if (this.editor?.area === area) this.editor = null;
      if (!this.opened || alias !== this.alias || profileId !== this.profileId) return;
      if (skill) void this.load(true);
      if (!this.editor) this.renderPane(true);
    };
    area.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save.click(); }
    });
    // Obsidian's keymap runs in the capture phase, so the modal's Escape (close) fires before any textarea listener.
    // A child scope on top takes Escape first: false stops it there; undefined during IME lets it reach the textarea.
    this.editScope = new Scope(this.scope);
    this.editScope.register([], "Escape", event => { if (event.isComposing) return; cancel.click(); return false; });
    this.app.keymap.pushScope(this.editScope);
    this.modalEl.doc.addEventListener("focusin", this.keepFocus, true);
    area.focus();
  };

  let read = this.files.get(path);
  if (!read) { read = this.host.inspect.read(alias, profileId, path).catch(message); this.files.set(path, read); }
  void read.then(file => {
    if (!body.isConnected) return;
    body.empty();
    if (typeof file === "string") {
      this.files.delete(path);
      const box = body.createDiv({ cls: "hm-error", text: file });
      box.createEl("button", { text: "Retry" }).addEventListener("click", () => this.renderPane(true));
      return;
    }
    const lock = skill && (skill.source === "omh" || skill.source === "plugin") ? hint(skill)
      : new TextEncoder().encode(file.text).length > EDIT_CAP ? "Too large to edit here (> 64 KB)" : null;
    edit.disabled = lock !== null;
    if (lock) setTooltip(edit, lock);
    loaded = file;
    const text = skill ? file.text.replace(FRONTMATTER, "") : file.text;
    if (text.trim()) void renderSafe(this.app, text, body, this.owner); else body.createDiv({ cls: "hm-muted", text: "Empty" });
  });
}
