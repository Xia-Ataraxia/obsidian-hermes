import { parseScopedIdentity, serializeScopedKey } from "../domain/control-center-validation";
import type { ProfileKey } from "../types/control-center";
import type { ProfileInspection, ProfileInspectorHandle, ProfileInspectorServices } from "../types/profile-inspector";
import type { ControlCenterLeaf } from "./control-center-leaf";
import { InspectorCronPane } from "./profile-inspector-cron";
import { readProfileInspection } from "./profile-inspector-data";
import { InspectorDocuments } from "./profile-inspector-documents";
import { inspectorButton, placeInspector } from "./profile-inspector-dom";
import { InspectorSkills } from "./profile-inspector-skills";

const TABS = ["Skills", "Cron", "SOUL", "USER"] as const;
type InspectorTab = typeof TABS[number];

export function mountProfileInspector(container: HTMLElement, services: ProfileInspectorServices): ProfileInspectorHandle {
  return new ProfileInspector(container, services);
}

class ProfileInspector implements ProfileInspectorHandle {
  private readonly card: HTMLElement;
  private readonly title: HTMLElement;
  private readonly status: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tabs = new Map<InspectorTab, HTMLButtonElement>();
  private readonly panes = new Map<InspectorTab, HTMLElement>();
  private readonly observer: ResizeObserver | null;
  private leaf: ControlCenterLeaf<ProfileInspection> | null = null;
  private unsubscribe: (() => void) | null = null;
  private skills: InspectorSkills | null = null;
  private cron: InspectorCronPane | null = null;
  private documents: InspectorDocuments | null = null;
  private selected: ProfileKey | null = null;
  private data: ProfileInspection | null = null;
  private anchor: HTMLElement | undefined;
  private tab: InspectorTab = "Skills";
  private visible = true;
  private disposed = false;
  private transition = 0;
  constructor(private readonly container: HTMLElement, private readonly services: ProfileInspectorServices) {
    this.card = container.createEl("section", { cls: "hcv-profile-inspector", attr: { role: "dialog", "aria-label": "Profile inspector" } });
    this.card.hidden = true;
    const header = this.card.createDiv({ cls: "hcv-inspector-header" });
    this.title = header.createEl("h2");
    inspectorButton(header, "Close", () => void this.close());
    this.status = this.card.createEl("p", { cls: "hcv-inspector-status", attr: { role: "status" } });
    const tabs = this.card.createDiv({ cls: "hcv-inspector-tabs", attr: { role: "tablist", "aria-label": "Profile details" } });
    for (const name of TABS) {
      const button = inspectorButton(tabs, name, () => this.showTab(name));
      button.setAttribute("role", "tab");
      button.addEventListener("keydown", event => {
        const index = TABS.indexOf(name);
        const next = event.key === "ArrowRight" ? TABS[(index + 1) % TABS.length]
          : event.key === "ArrowLeft" ? TABS[(index + TABS.length - 1) % TABS.length]
          : event.key === "Home" ? TABS[0] : event.key === "End" ? TABS.at(-1) : undefined;
        if (next !== undefined) { event.preventDefault(); this.showTab(next); this.tabs.get(next)?.focus(); }
      });
      this.tabs.set(name, button);
    }
    this.body = this.card.createDiv({ cls: "hcv-inspector-body" });
    this.card.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); void this.close(); }
    });
    const Resize = container.ownerDocument.defaultView?.ResizeObserver;
    this.observer = Resize === undefined ? null : new Resize(() => this.place());
    this.observer?.observe(container);
    this.observer?.observe(this.card);
  }
  async select(profile: ProfileKey, focusReturn?: HTMLElement): Promise<boolean> {
    const parsed = parseScopedIdentity(profile);
    if (this.disposed || !parsed.ok || parsed.value.kind !== "profile" || profile.connection !== this.services.connection || profile.connection !== this.services.state.connection || profile.profile === "all") return false;
    const transition = ++this.transition;
    if (this.selected !== null && serializeScopedKey(this.selected) === serializeScopedKey(profile)) {
      this.anchor = focusReturn ?? this.anchor;
      this.card.hidden = !this.visible;
      this.place();
      return true;
    }
    if (this.documents !== null && !await this.documents.requestClose()) return false;
    if (this.disposed || transition !== this.transition) return false;
    this.clearSelection();
    this.selected = profile;
    this.anchor = focusReturn;
    this.title.textContent = `${profile.profile} · ${profile.connection}`;
    this.card.hidden = !this.visible;
    const skills = this.body.createDiv();
    const cron = this.body.createDiv();
    const docs = this.body.createDiv();
    this.panes.set("Skills", skills); this.panes.set("Cron", cron);
    this.panes.set("SOUL", docs); this.panes.set("USER", docs);
    this.skills = new InspectorSkills(skills);
    this.cron = new InspectorCronPane(cron, this.services.adapter);
    this.documents = new InspectorDocuments(docs, this.services.app, this.services.documents, () => void this.close());
    const leaf = this.services.state.createLeaf<ProfileInspection>();
    this.leaf = leaf;
    this.unsubscribe = leaf.subscribe(() => this.update());
    leaf.setVisible(this.visible);
    this.showTab("Skills");
    this.tabs.get("Skills")?.focus();
    const catalog = leaf.catalog;
    if (catalog === null) { this.status.textContent = "Profile catalog is unavailable."; return true; }
    await leaf.select({ entity: profile, channel: "profile-inspector", load: context => readProfileInspection(catalog, this.services.adapter, profile, context), revision: value => JSON.stringify([value.catalog.freshness, value.cron]), freshness: value => value.catalog.freshness });
    return !this.disposed && transition === this.transition;
  }
  private showTab(tab: InspectorTab): void {
    this.tab = tab;
    for (const [name, button] of this.tabs) { button.setAttribute("aria-selected", String(name === tab)); button.tabIndex = name === tab ? 0 : -1; }
    for (const [name, pane] of this.panes) if (name !== "USER") pane.hidden = name === "SOUL" ? tab !== "SOUL" && tab !== "USER" : name !== tab;
    if (tab === "SOUL" || tab === "USER") this.documents?.show(tab === "SOUL" ? "SOUL.md" : "USER.md", this.data?.ref ?? null);
    this.place();
  }
  private update(): void {
    if (this.disposed || this.leaf === null) return;
    const snapshot = this.leaf.snapshot;
    const time = snapshot.freshness.lastSuccessAt;
    this.status.textContent = `${snapshot.loading ? "Refreshing · " : ""}${snapshot.freshness.kind}${time === null ? "" : ` · Last received ${new Date(time).toLocaleTimeString()}`}${snapshot.failure === null ? "" : " · Read unavailable"}`;
    const data = snapshot.value;
    if (data !== null && data !== this.data) {
      this.data = data;
      this.skills?.update(data.catalog);
      this.cron?.update(data.cron, data.ref);
      if (this.tab === "SOUL" || this.tab === "USER") this.showTab(this.tab);
      void this.documents?.refresh();
    }
    this.place();
  }
  private place(): void { if (!this.card.hidden) placeInspector(this.card, this.container, this.anchor); }
  async refresh(): Promise<void> { await this.leaf?.refresh(); }
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.card.hidden = !visible || this.selected === null;
    this.leaf?.setVisible(visible);
    this.place();
  }
  async close(): Promise<boolean> {
    const transition = ++this.transition;
    if (this.documents !== null && !await this.documents.requestClose()) return false;
    if (this.disposed || transition !== this.transition) return false;
    const anchor = this.anchor;
    this.clearSelection();
    if (anchor?.isConnected) anchor.focus();
    this.services.onClose?.();
    return true;
  }
  private clearSelection(): void {
    this.unsubscribe?.(); this.unsubscribe = null;
    this.leaf?.dispose(); this.leaf = null;
    this.documents?.dispose(); this.documents = null;
    this.cron?.dispose(); this.cron = null;
    this.skills?.dispose(); this.skills = null;
    this.selected = null; this.data = null; this.anchor = undefined;
    this.panes.clear(); this.body.empty(); this.card.hidden = true;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ++this.transition;
    this.clearSelection();
    this.observer?.disconnect();
    this.card.remove();
  }
}
