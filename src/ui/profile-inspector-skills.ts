import type { ProfileSkillCatalog, SkillInspection } from "../types/profile-catalog";

type SkillRow = { readonly root: HTMLDetailsElement; readonly title: HTMLElement; readonly facts: HTMLElement };

export class InspectorSkills {
  private readonly status: HTMLElement;
  private readonly visible: HTMLElement;
  private readonly list: HTMLElement;
  private readonly rows = new Map<string, SkillRow>();
  constructor(container: HTMLElement) {
    this.status = container.createEl("p", { attr: { role: "status" } });
    container.createEl("p", { cls: "hcv-inspector-muted", text: "Configured selection and native visible catalog are separate. Effective session skills: unknown (no observed session/platform snapshot)." });
    this.visible = container.createEl("p", { cls: "hcv-inspector-muted" });
    this.list = container.createDiv();
  }
  update(catalog: ProfileSkillCatalog): void {
    this.status.textContent = catalog.visibleCoverage.kind !== "complete" ? "Native skill catalog unavailable; an empty skill set is not established."
      : catalog.visible.length === 0 ? "Native visible catalog: 0 skills." : `Native visible catalog: ${catalog.visible.length} skills.`;
    this.visible.textContent = `Visible load names: ${catalog.visible.map(row => row.name).join(", ") || (catalog.visibleCoverage.kind === "complete" ? "none" : "unknown")}. Metadata: ${catalog.coverage.kind}. Requested platform: ${catalog.platform ?? "unspecified"}; host OS: ${catalog.metadata?.hostPlatform ?? "unknown"}.`;
    if (catalog.metadata === null) this.status.textContent += " Configuration and source metadata unavailable.";
    const retained = new Set(catalog.skills.map(skill => skill.identity));
    for (const [id, row] of this.rows) if (!retained.has(id)) { row.root.remove(); this.rows.delete(id); }
    for (const skill of catalog.skills) {
      let row = this.rows.get(skill.identity);
      if (row === undefined) {
        const root = this.list.createEl("details", { cls: "hcv-inspector-skill" });
        row = { root, title: root.createEl("summary"), facts: root.createEl("pre", { cls: "hcv-inspector-facts" }) };
        this.rows.set(skill.identity, row);
      }
      row.title.textContent = `${skill.name ?? skill.relativePath} · ${skill.source} · ${skill.configuredGlobal}`;
      row.facts.textContent = skillFacts(skill, catalog);
    }
  }
  dispose(): void { this.rows.clear(); }
}

function skillFacts(skill: SkillInspection, catalog: ProfileSkillCatalog): string {
  const loadable = skill.loadName !== null && catalog.visibleCoverage.kind === "complete"
    ? catalog.visible.some(row => row.name === skill.loadName) ? "Visible by load name; canonical source resolution remains separate" : "Not in native visible catalog"
    : "Unknown";
  return [
    `Source: ${skill.source} (${skill.nameSetProvenance})`, `Path: ${skill.path}`, `Canonical path: ${skill.canonicalPath}`,
    `Configured global: ${skill.configuredGlobal}`, `Configured platform: ${skill.configuredPlatform}`,
    `Resolution: ${skill.resolution}`, `Loadability: ${loadable}`, `OS compatibility: ${skill.osCompatibility}`,
    `Restrictions: ${JSON.stringify(skill.restrictions)}`, "Effective session: unknown",
  ].join("\n");
}
