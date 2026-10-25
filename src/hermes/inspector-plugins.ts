import { Notice, setTooltip } from "obsidian";
import { pluginLastUsed, type PluginInfo } from "./inspect";
import { confirmed } from "./kanban-drawer";
import { SAFE_TOKEN } from "./remote";
import { absolute, icon, iconButton, relative } from "./ui";
import { PLUGIN_SORTS, choose, fail } from "./inspector-common";
import type { ProfileModal } from "./inspector";

export function renderPlugins(this: ProfileModal, el: HTMLElement): void {
  const { detail, alias, profileId } = this;
  if (!detail) { this.pending(el); return; }
  if (this.use === undefined) {
    this.use = null;
    void this.host.inspect.tools(alias, profileId).then(use => {
      if (alias !== this.alias || profileId !== this.profileId) return;
      this.use = use ?? false;
      if (this.opened && this.tab === "plugins" && !this.editor) this.renderPane(true);
    });
  }
  const tools = el.createDiv("hm-pane-tools");
  const sort: HTMLButtonElement = iconButton(tools, "arrow-up-down", "Sort", () => choose(sort, PLUGIN_SORTS, this.pluginSort, value => { this.pluginSort = value; this.renderPane(true); }), "hm-push");
  if (!detail.plugins.length) { el.createDiv({ cls: "hm-muted hm-pad", text: "No plugins" }); return; }
  const use = this.use;
  const last = (plugin: PluginInfo): number | null => use ? pluginLastUsed(plugin, use, detail.skills) : null;
  const order = this.pluginSort === "lru"
    ? (a: PluginInfo, b: PluginInfo) => (last(a) ?? -Infinity) - (last(b) ?? -Infinity) || a.name.localeCompare(b.name)
    : (a: PluginInfo, b: PluginInfo) => a.name.localeCompare(b.name);
  for (const plugin of [...detail.plugins].sort(order)) this.pluginRow(el, plugin, last(plugin));
}

export function pluginRow(this: ProfileModal, parent: HTMLElement, plugin: PluginInfo, last: number | null): void {
  const provider = plugin.status === "provider" || !!plugin.readOnly?.includes("memory.provider");
  const on = this.state(`plugin:${plugin.key}`, plugin.status === "enabled" || provider);
  this.fold(parent, `plugin:${plugin.key}`, `hm-row hm-plugin${on ? "" : " is-off"}`, false, summary => {
    const top = summary.createDiv("hm-row-top");
    setTooltip(icon(top, provider ? "brain" : "puzzle", "hm-icon hm-src"), provider ? "Memory provider" : "Plugin");
    top.createSpan({ cls: "hm-row-name", text: plugin.name });
    if (plugin.version) top.createSpan({ cls: "hm-muted", text: plugin.version });
    if (provider) top.createSpan({ cls: "hm-tag", text: "Provider" });
    const hookOnly = plugin.hooks.length > 0 && !plugin.tools.length && !plugin.skills;
    const [text, tip] = this.use === false ? ["Usage unavailable", ""] : !this.use ? ["…", ""]
      : last !== null ? [relative(last, this.now), `Last used · ${absolute(last)}`]
      : hookOnly ? ["—", "Hooks leave no usage record"] : ["30d+", "No use in the last 30 days"];
    const used = top.createSpan({ cls: "hm-muted hm-push", text });
    if (tip) setTooltip(used, tip);
    this.toggle(top, on, plugin.readOnly, value => this.confirmPlugin(plugin, value, last), "Applies to new sessions");
    if (plugin.description) summary.createDiv({ cls: "hm-row-desc", text: plugin.description });
  }, body => {
    const kv = body.createDiv("hm-kv");
    const pair = (label: string, value: string): void => { if (value) { kv.createDiv({ cls: "hm-muted", text: label }); kv.createDiv({ text: value }); } };
    pair("Provides", [plugin.tools.join(", "), plugin.hooks.length ? `${plugin.hooks.length} hooks` : "", plugin.skills ? `${plugin.skills} skills` : ""].filter(Boolean).join(" · "));
    pair("Settings", plugin.settings.map(([k, v]) => `${k}  ${v}`).join("\n"));
    pair("Env", plugin.env.map(name => `${name} (in .env)`).join("\n"));
    pair("Source", plugin.source ?? "");
    pair("Kind", `${plugin.kind} · ${plugin.origin}`);
    body.createDiv({ cls: "hm-foot hm-muted", text: "Settings are read-only here. Edit them in config.yaml or the Hermes dashboard." });
  });
}

/** Plugin switches reload the shared gateway, so they ask first; no puts the switch back. */
export function confirmPlugin(this: ProfileModal, plugin: PluginInfo, on: boolean, last: number | null): void {
  const key = `plugin:${plugin.key}`;
  const rel = last === null ? null : relative(last, this.now);
  const text = "Hermes reloads the running gateway, which serves all profiles. Applies to new sessions."
    + (rel ? ` Last used ${rel === "now" ? "just now" : `${rel} ago`}.` : "");
  void confirmed(this.app, `${on ? "Enable" : "Disable"} ${plugin.name}?`, text, on ? "Enable" : "Disable").then(ok => {
    if (!ok) { if (this.opened) this.renderPane(true); return; }
    this.overrides.set(key, on);
    const { alias, profileId } = this;
    void this.host.inspect.togglePlugin(alias, profileId, plugin, on).catch(fail).then(outcome => {
      if (!outcome.ok) new Notice(outcome.message);
      else if ("ungranted" in outcome) new Notice(`${plugin.name} is on, but its capabilities stay off until granted. Grant them once in a terminal${SAFE_TOKEN.test(plugin.key) ? `: hermes -p ${profileId} plugins enable ${plugin.key}` : " with hermes plugins enable."}`, 10_000);
      if (!this.opened || alias !== this.alias || profileId !== this.profileId) return;
      if (!outcome.ok) this.overrides.delete(key);
      this.detail = this.host.inspect.cached(alias, profileId) ?? this.detail;
      this.renderRail();
      if (!this.editor) this.renderPane(true);
    });
  });
}
