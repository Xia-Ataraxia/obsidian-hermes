import { MarkdownRenderer, Notice, SuggestModal, setTooltip, type App, type ItemView } from "obsidian";
import type { CronJob, Profile, ProfileDoc, Skill } from "./data";
import { absolute, avatar, type HermesHost, icon, iconButton, relative, stat } from "./ui";

type Tab = "skills" | "cron" | "soul" | "user" | "memory" | "activity";

const TABS: readonly [Tab, string, string][] = [
  ["skills", "sparkles", "Skills"],
  ["cron", "alarm-clock", "Cron"],
  ["soul", "heart", "Soul"],
  ["user", "user", "User"],
  ["memory", "brain", "Memory"],
  ["activity", "activity", "Activity"],
];
const DOCS: Partial<Record<Tab, ProfileDoc>> = { soul: "SOUL.md", user: "memories/USER.md", memory: "memories/MEMORY.md" };

type Pair = [model: string, provider: string];

/** Substring filter over [model, provider]; a typed id that matches no model is offered as custom on the current provider. */
class ModelPicker extends SuggestModal<Pair> {
  constructor(app: App, readonly pairs: Pair[], private readonly current: Pair, private readonly pick: (pair: Pair) => void) {
    super(app);
    this.setPlaceholder("Default model");
  }

  getSuggestions(query: string): Pair[] {
    const q = query.trim();
    const hits = this.pairs.filter(pair => pair.join(" ").toLowerCase().includes(q.toLowerCase()));
    return q && !hits.some(([model]) => model === q) ? [...hits, [q, this.current[1]]] : hits;
  }

  renderSuggestion(pair: Pair, el: HTMLElement): void {
    const [model, provider] = pair;
    el.addClass("mod-complex");
    const content = el.createDiv("suggestion-content");
    content.createDiv({ cls: "suggestion-title", text: model });
    content.createDiv({ cls: "suggestion-note", text: this.pairs.includes(pair) ? provider : ["custom", provider].filter(Boolean).join(" · ") });
    if (model === this.current[0] && provider === this.current[1]) icon(el.createDiv("suggestion-aux"), "check");
  }

  onChooseSuggestion(pair: Pair): void { this.pick(pair); }
}

/** Right-hand drawer for one profile: icon tabs, markdown documents with in-place editing. */
export class Inspector {
  alias = "";
  profileId = "";
  editing = false;
  private profile!: Profile;
  private now = 0;
  private tab: Tab = "skills";
  private query = "";
  private readonly root: HTMLElement;
  private readonly head: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly pane: HTMLElement;
  private readonly docs = new Map<string, string>();

  constructor(
    private readonly view: ItemView, container: HTMLElement, private readonly host: HermesHost, private readonly onClose: () => void,
    private readonly peers: () => readonly Profile[], private readonly refresh: () => void,
  ) {
    this.root = container.createDiv("hm-drawer");
    this.head = this.root.createDiv("hm-drawer-head");
    this.tabs = this.root.createDiv("hm-tabs");
    this.pane = this.root.createDiv("hm-pane");
    this.root.addEventListener("keydown", event => { if (event.key === "Escape" && !this.editing) this.close(); });
  }

  show(alias: string, profile: Profile, now: number): void {
    if (alias !== this.alias || profile.id !== this.profileId) { this.docs.clear(); this.editing = false; this.query = ""; }
    this.alias = alias;
    this.update(profile, now);
    requestAnimationFrame(() => this.root.addClass("is-open"));
  }

  /** Fresh data from a poll; never interrupts an edit. */
  update(profile: Profile, now: number): void {
    this.profile = profile;
    this.profileId = profile.id;
    this.now = now;
    if (this.editing) return;
    this.renderHead();
    this.renderTabs();
    this.renderPane();
  }

  close(): void {
    this.root.removeClass("is-open");
    window.setTimeout(() => this.root.remove(), 200);
    this.onClose();
  }

  private renderHead(): void {
    const { head, profile } = this;
    head.empty();
    head.style.setProperty("--hue", "");
    avatar(head, profile.id, "hm-avatar is-large");
    const title = head.createDiv("hm-drawer-title");
    title.createDiv({ cls: "hm-drawer-name", text: profile.id });
    const meta = title.createDiv("hm-drawer-meta");
    stat(meta, "cpu", profile.model || "—", [profile.provider, "Change default model"].filter(Boolean).join(" · "), "is-action", "button")
      .addEventListener("click", () => this.pickModel());
    for (const [platform, state] of Object.entries(profile.gateway?.platforms ?? {})) {
      stat(meta, state === "connected" ? "wifi" : "wifi-off", platform, `${platform} · ${state}`, state === "connected" ? "is-good" : "is-muted");
    }
    iconButton(head, "x", "Close", () => this.close(), "hm-push");
    if (profile.description) head.createDiv({ cls: "hm-drawer-desc", text: profile.description });
  }

  /** Models in use on this host first, then the cached catalog as it arrives; the write is `hermes config set`, then a refresh. */
  private pickModel(): void {
    const { alias, profile } = this;
    const pairs: Pair[] = [];
    const add = (pair: Pair): void => { if (pair[0] && !pairs.some(([m, p]) => m === pair[0] && p === pair[1])) pairs.push(pair); };
    for (const peer of [profile, ...this.peers()]) add([peer.model, peer.provider]);
    const picker = new ModelPicker(this.view.app, pairs, [profile.model, profile.provider], async ([model, provider]) => {
      // A poll re-renders the head while the picker is open, so spin the stat that is there now.
      const el = this.head.querySelector(".hm-stat.is-action");
      el?.addClass("is-spinning");
      try {
        const outcome = await this.host.client.setModel(alias, profile.id, model, provider);
        if (!outcome.ok) return void new Notice(outcome.message);
        this.refresh();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
      } finally {
        el?.removeClass("is-spinning");
      }
    });
    picker.open();
    void this.host.client.models(alias, profile.id).then(catalog => {
      catalog.forEach(add);
      picker.inputEl.dispatchEvent(new Event("input"));
    }).catch(error => new Notice(error instanceof Error ? error.message : String(error)));
  }

  private renderTabs(): void {
    this.tabs.empty();
    const counts: Partial<Record<Tab, number>> = { skills: this.profile.skills.length, cron: this.profile.jobs.length };
    for (const [tab, name, label] of TABS) {
      const button = this.tabs.createEl("button", { cls: `hm-tab${tab === this.tab ? " is-active" : ""}`, attr: { "aria-label": label } });
      icon(button, name);
      if (counts[tab]) button.createSpan({ cls: "hm-tab-count", text: String(counts[tab]) });
      setTooltip(button, label);
      button.addEventListener("click", () => { if (this.editing) return; this.tab = tab; this.renderTabs(); this.renderPane(); });
    }
  }

  private renderPane(): void {
    this.pane.empty();
    this.pane.scrollTop = 0;
    const doc = DOCS[this.tab];
    if (doc) return void this.renderDoc(doc);
    if (this.tab === "skills") this.renderSkills();
    else if (this.tab === "cron") this.renderCron();
    else this.renderActivity();
  }

  /* ───────────── skills ───────────── */

  private renderSkills(): void {
    const search = this.pane.createDiv("hm-search");
    icon(search, "search");
    const input = search.createEl("input", { type: "search", attr: { placeholder: "Filter" }, value: this.query });
    const list = this.pane.createDiv();
    const draw = (): void => {
      list.empty();
      const q = this.query.toLowerCase();
      const groups = new Map<string, Skill[]>();
      for (const skill of this.profile.skills) {
        if (q && !`${skill.name} ${skill.category} ${skill.description}`.toLowerCase().includes(q)) continue;
        const key = skill.category || "other";
        groups.set(key, [...(groups.get(key) ?? []), skill]);
      }
      if (groups.size === 0) return void list.createDiv({ cls: "hm-muted hm-pad", text: "—" });
      for (const [category, skills] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
        const group = list.createEl("details", { cls: "hm-group" });
        group.open = groups.size <= 4 || q !== "";
        const summary = group.createEl("summary");
        summary.createSpan({ text: category });
        summary.createSpan({ cls: "hm-count", text: String(skills.length) });
        for (const skill of skills.sort((a, b) => a.name.localeCompare(b.name))) {
          const row = group.createDiv("hm-skill");
          row.createDiv({ cls: "hm-skill-name", text: skill.name });
          if (skill.description) row.createDiv({ cls: "hm-skill-desc", text: skill.description });
        }
      }
    };
    input.addEventListener("input", () => { this.query = input.value; draw(); });
    draw();
  }

  /* ───────────── cron ───────────── */

  private renderCron(): void {
    const jobs = [...this.profile.jobs].sort((a, b) => Number(b.enabled) - Number(a.enabled) || String(a.next ?? "~").localeCompare(String(b.next ?? "~")));
    if (jobs.length === 0) return void this.pane.createDiv({ cls: "hm-muted hm-pad", text: "No cron jobs" });
    for (const job of jobs) this.job(job);
  }

  private job(job: CronJob): void {
    const failed = !!job.error || (job.status !== null && !["ok", "success"].includes(job.status));
    const card = this.pane.createDiv(`hm-job${job.enabled ? "" : " is-off"}${failed ? " is-failed" : ""}`);
    const top = card.createDiv("hm-job-top");
    const dot = top.createSpan("hm-job-dot");
    setTooltip(dot, job.enabled ? (failed ? `Last run: ${job.status ?? "error"}` : `Last run: ${job.status ?? "—"}`) : "Paused");
    top.createDiv({ cls: "hm-job-name", text: job.name || job.id });
    const schedule = top.createSpan({ cls: "hm-code", text: job.schedule });
    setTooltip(schedule, "Schedule");

    const meta = card.createDiv("hm-job-meta");
    if (job.enabled && job.next) setTooltip(stat(meta, "timer", relative(job.next, this.now), "Next"), `Next · ${absolute(job.next)}`);
    if (job.last) setTooltip(stat(meta, "history", relative(job.last, this.now), "Last"), `Last · ${absolute(job.last)}`);
    if (job.deliver) stat(meta, "send", job.deliver, "Delivers to");
    if (job.skills.length) stat(meta, "sparkles", job.skills.join(", "), "Skills");

    if (job.error) card.createDiv({ cls: "hm-error", text: job.error });
    if (job.prompt) {
      const prompt = card.createEl("details", { cls: "hm-prompt" });
      const summary = prompt.createEl("summary");
      icon(summary, "message-square");
      summary.createSpan({ text: job.prompt.split("\n")[0]!.slice(0, 90) });
      prompt.createEl("pre", { text: job.prompt });
    }
  }

  /* ───────────── documents ───────────── */

  private async renderDoc(doc: ProfileDoc): Promise<void> {
    const key = `${this.profileId}/${doc}`;
    const pane = this.pane;
    const bar = pane.createDiv("hm-doc-bar");
    bar.createSpan({ cls: "hm-muted", text: doc.replace("memories/", "") });
    const body = pane.createDiv("hm-doc markdown-rendered");
    let text = this.docs.get(key);
    if (text === undefined) {
      body.createDiv({ cls: "hm-muted", text: "…" });
      const fetched = await this.host.client.document(this.alias, this.profileId, doc);
      if (pane !== this.pane || !pane.isConnected) return;
      if (fetched === null) return void body.setText("Could not read file");
      text = fetched;
      this.docs.set(key, text);
    }
    const original = text;
    const reread = iconButton(bar, "refresh-cw", "Reload", () => { this.docs.delete(key); this.renderPane(); }, "hm-push");
    const edit = iconButton(bar, "pencil", "Edit", () => startEdit());
    const draw = async (): Promise<void> => {
      body.empty();
      if (!original.trim()) return void body.createDiv({ cls: "hm-muted", text: "Empty" });
      await MarkdownRenderer.render(this.view.app, original, body, "", this.view);
    };
    const startEdit = (): void => {
      this.editing = true;
      reread.hide(); edit.hide();
      body.empty();
      body.removeClass("markdown-rendered");
      const area = body.createEl("textarea", { cls: "hm-editor", text: original });
      const actions = bar.createDiv("hm-doc-actions");
      const stop = (): void => { this.editing = false; this.renderTabs(); this.renderPane(); };
      iconButton(actions, "x", "Cancel", stop);
      const save = iconButton(actions, "check", "Save (⌘↵)", async () => {
        save.disabled = true;
        const outcome = await this.host.client.saveDocument(this.alias, this.profileId, doc, original, area.value);
        save.disabled = false;
        if (!outcome.ok) return void new Notice(outcome.message);
        this.docs.set(key, area.value);
        stop();
      }, "mod-cta");
      area.addEventListener("keydown", event => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) save.click();
        if (event.key === "Escape") { event.stopPropagation(); stop(); }
      });
      area.focus();
    };
    await draw();
  }

  /* ───────────── activity ───────────── */

  private renderActivity(): void {
    const usage = this.profile.usage;
    if (!usage) return void this.pane.createDiv({ cls: "hm-muted hm-pad", text: "No sessions" });
    const tiles = this.pane.createDiv("hm-tiles");
    const tile = (name: string, value: string, label: string): void => {
      const el = tiles.createDiv("hm-tile");
      icon(el, name);
      el.createDiv({ cls: "hm-tile-value", text: value });
      el.createDiv({ cls: "hm-tile-label", text: label });
    };
    tile("message-circle", String(usage.sessions7d), "sessions");
    tile("messages-square", String(usage.messages7d), "messages");
    tile("coins", Intl.NumberFormat("en", { notation: "compact" }).format(usage.tokens7d), "tokens");
    tile("dollar-sign", usage.cost7d.toFixed(2), "cost");

    const sources = Object.entries(usage.sources).sort(([, a], [, b]) => b - a);
    const total = sources.reduce((sum, [, n]) => sum + n, 0);
    if (total > 0) {
      const bar = this.pane.createDiv("hm-sources");
      const legend = this.pane.createDiv("hm-sources-legend");
      sources.forEach(([source, n], index) => {
        const color = `hsl(${(index * 67 + 200) % 360} 60% 58%)`;
        const seg = bar.createDiv({ cls: "hm-source" });
        seg.style.flex = String(n);
        seg.style.background = color;
        setTooltip(seg, `${source} · ${n}`);
        const item = legend.createSpan();
        item.createSpan({ cls: "hm-swatch" }).style.background = color;
        item.createSpan({ text: `${source} ${n}` });
      });
    }

    const list = this.pane.createDiv("hm-recent");
    for (const [title, source, at] of usage.recent) {
      const row = list.createDiv("hm-recent-row");
      row.createDiv({ cls: "hm-recent-title", text: title });
      if (source) row.createSpan({ cls: "hm-tag", text: source });
      const when = row.createSpan({ cls: "hm-muted", text: relative(at, this.now) });
      setTooltip(when, absolute(at));
    }
  }
}
