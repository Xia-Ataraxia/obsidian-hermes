import { setTooltip, type WorkspaceLeaf } from "obsidian";
import type { Profile, ProfilesSnapshot } from "./data";
import { curve, hue, ring, snap, type Guide, type Rect } from "./geometry";
import { Inspector } from "./inspector";
import { avatar, compact, HermesView, icon, iconButton, relative, stat, type HermesHost } from "./ui";

export const PROFILES_VIEW = "hermes-profiles";

const CARD_W = 280;
const SVG = "http://www.w3.org/2000/svg";
let instances = 0;

const LOAD: readonly [keyof Profile["load"], string, string][] = [
  ["running", "play", "Running"],
  ["ready", "circle-dot", "Ready"],
  ["todo", "circle-dashed", "Todo"],
  ["review", "eye", "Review"],
  ["blocked", "ban", "Blocked"],
  ["done7d", "check", "Done · 7d"],
];

function svg<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  parent.appendChild(el);
  return el;
}

const color = (id: string, alpha = 1): string => `hsl(${Math.round(hue(id))} 68% 58% / ${alpha})`;
const shortModel = (model: string): string => model.split("/").pop() ?? model;

/**
 * Profiles as cards on a pannable canvas. Edges are 30-day task handoffs (creator → assignee):
 * thickness and opacity scale with volume, the gradient runs from sender to receiver.
 * Dragging a card snaps it to the other cards' edges and centers with thin guides.
 */
export class ProfilesView extends HermesView {
  private snapshot: ProfilesSnapshot | null = null;
  private loadedAlias = "";
  private positions = new Map<string, [number, number]>();
  private camera = { x: 0, y: 0, k: 1 };
  private fitted = false;
  private dragging = false;
  private canvas!: HTMLElement;
  private world!: HTMLElement;
  private edgeLayer!: SVGSVGElement;
  private guideLayer!: SVGSVGElement;
  private zoomLabel!: HTMLElement;
  private readonly cards = new Map<string, HTMLElement>();
  private readonly uid = `hm${++instances}`;
  private inspector: Inspector | null = null;

  constructor(leaf: WorkspaceLeaf, host: HermesHost) {
    super(leaf, host, 60_000);
  }

  getViewType(): string { return PROFILES_VIEW; }
  getDisplayText(): string { return "Hermes profiles"; }
  override getIcon(): string { return "network"; }

  protected override busy(): boolean {
    return this.dragging || (this.inspector?.editing ?? false);
  }

  protected async pull(alias: string): Promise<string | null> {
    const result = await this.host.client.profiles(alias);
    if (typeof result === "string" || alias !== this.alias) return typeof result === "string" ? result : null;
    if (alias !== this.loadedAlias) {
      this.loadedAlias = alias;
      this.positions = new Map(Object.entries(this.host.layout(alias)));
      this.fitted = false;
      this.inspector?.close();
    }
    this.snapshot = result;
    return null;
  }

  protected render(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    this.contentEl.addClass("hm-profiles");
    this.body.empty();
    this.cards.clear();
    this.canvas = this.body.createDiv("hm-canvas");
    this.world = this.canvas.createDiv("hm-world");
    this.edgeLayer = svg(this.world, "svg", { class: "hm-edges" });
    this.guideLayer = svg(this.world, "svg", { class: "hm-guides" });

    for (const profile of snapshot.profiles) this.cards.set(profile.id, this.card(profile, snapshot.now));
    const missing = snapshot.profiles.filter(profile => !this.positions.has(profile.id));
    if (missing.length > 0) {
      const weight = (id: string): number => snapshot.edges.reduce((sum, edge) => sum + (edge.from === id || edge.to === id ? edge.weight : 0), 0);
      const placed = ring(snapshot.profiles.map(profile => profile.id), weight, { w: CARD_W, h: 240 });
      for (const profile of missing) this.positions.set(profile.id, placed.get(profile.id) ?? [0, 0]);
    }
    for (const id of this.cards.keys()) this.place(id);

    this.controls();
    this.bind();
    requestAnimationFrame(() => {
      if (!this.fitted) { this.fit(); this.fitted = true; } else this.apply();
      this.drawEdges();
    });
    const selected = this.inspector?.profileId;
    const profile = snapshot.profiles.find(candidate => candidate.id === selected);
    if (profile) { this.inspector?.update(profile, snapshot.now); this.cards.get(profile.id)?.addClass("is-selected"); }
  }

  /* ───────────── cards ───────────── */

  private card(profile: Profile, now: number): HTMLElement {
    const el = this.world.createDiv({ cls: "hm-card", attr: { "data-id": profile.id, tabindex: "0" } });
    el.style.setProperty("--hue", String(Math.round(hue(profile.id))));

    const head = el.createDiv("hm-card-head");
    avatar(head, profile.id);
    const title = head.createDiv("hm-card-title");
    title.createDiv({ cls: "hm-card-name", text: profile.id });
    if (profile.model) {
      const model = title.createDiv("hm-card-model");
      icon(model, "cpu");
      model.createSpan({ text: shortModel(profile.model) });
      setTooltip(model, [profile.provider, profile.model].filter(Boolean).join(" · "));
    }
    const gateway = profile.gateway;
    const dot = head.createSpan(`hm-gw ${gateway?.alive ? "is-live" : gateway ? "is-down" : "is-none"}`);
    const platforms = Object.entries(gateway?.platforms ?? {}).map(([name, state]) => `${name} ${state === "connected" ? "●" : "○"}`).join("  ");
    setTooltip(dot, gateway ? `Gateway ${gateway.alive ? "live" : "down"}${platforms ? `\n${platforms}` : ""}` : "No gateway");

    if (profile.description) el.createDiv({ cls: "hm-card-desc", text: profile.description });

    const usage = profile.usage;
    const activity = el.createDiv("hm-card-activity");
    this.sparkline(activity, usage?.daily ?? []);
    const numbers = activity.createDiv("hm-card-numbers");
    stat(numbers, "message-circle", usage?.sessions7d ?? 0, "Sessions · 7d");
    stat(numbers, "coins", compact(usage?.tokens7d ?? 0), "Tokens · 7d");
    if ((usage?.cost7d ?? 0) > 0) stat(numbers, "dollar-sign", usage!.cost7d.toFixed(usage!.cost7d < 10 ? 2 : 0), "Cost · 7d");

    const load = el.createDiv("hm-card-load");
    for (const [key, name, label] of LOAD) {
      const count = profile.load[key];
      if (count > 0) stat(load, name, count, label, `hm-chip is-${key}`);
    }

    const foot = el.createDiv("hm-card-foot");
    stat(foot, "sparkles", profile.skills.length, "Skills");
    const enabled = profile.jobs.filter(job => job.enabled);
    if (profile.jobs.length > 0) stat(foot, "alarm-clock", enabled.length, `Cron jobs · ${enabled.length}/${profile.jobs.length} on`);
    const next = enabled.filter(job => job.next).sort((a, b) => String(a.next).localeCompare(String(b.next)))[0];
    if (next) stat(foot, "timer", relative(next.next, now), `Next · ${next.name}`);
    const failing = profile.jobs.filter(job => job.enabled && job.status && job.status !== "ok" && job.status !== "success").length;
    if (failing > 0) stat(foot, "triangle-alert", failing, "Failing cron jobs", "is-bad");
    stat(foot, "activity", relative(usage?.last ?? null, now), "Last active", "hm-push");

    el.addEventListener("mouseenter", () => this.focus(profile.id));
    el.addEventListener("mouseleave", () => this.focus(null));
    el.addEventListener("keydown", event => { if (event.key === "Enter") this.inspect(profile.id); });
    return el;
  }

  private sparkline(parent: HTMLElement, values: readonly number[]): void {
    const width = 120, height = 30;
    const box = parent.createDiv("hm-spark");
    setTooltip(box, `Sessions · 14d\n${values.join(" ")}`);
    const root = svg(box, "svg", { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none" });
    if (values.length < 2) return;
    const max = Math.max(1, ...values);
    const points = values.map((value, index) => [index * (width / (values.length - 1)), height - 2 - (value / max) * (height - 6)] as const);
    const line = points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
    svg(root, "path", { d: `${line}L${width},${height}L0,${height}Z`, class: "hm-spark-area" });
    svg(root, "path", { d: line, class: "hm-spark-line" });
    const [lx, ly] = points[points.length - 1]!;
    svg(root, "circle", { cx: lx, cy: ly, r: 2.2, class: "hm-spark-dot" });
  }

  /* ───────────── geometry ───────────── */

  private rect(id: string): Rect {
    const [x, y] = this.positions.get(id) ?? [0, 0];
    const el = this.cards.get(id);
    return { x, y, w: el?.offsetWidth || CARD_W, h: el?.offsetHeight || 200 };
  }

  private place(id: string): void {
    const [x, y] = this.positions.get(id) ?? [0, 0];
    const el = this.cards.get(id);
    if (el) el.style.transform = `translate(${x}px, ${y}px)`;
  }

  private apply(): void {
    const { x, y, k } = this.camera;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    this.canvas.style.setProperty("--grid", `${22 * k}px`);
    this.canvas.style.backgroundPosition = `${x}px ${y}px`;
    this.zoomLabel?.setText(`${Math.round(k * 100)}%`);
  }

  private fit(): void {
    const rects = [...this.cards.keys()].map(id => this.rect(id));
    if (rects.length === 0) return;
    const left = Math.min(...rects.map(r => r.x)), top = Math.min(...rects.map(r => r.y));
    const right = Math.max(...rects.map(r => r.x + r.w)), bottom = Math.max(...rects.map(r => r.y + r.h));
    const { clientWidth: width, clientHeight: height } = this.canvas;
    const k = Math.max(0.3, Math.min(1, (width - 120) / (right - left), (height - 140) / (bottom - top)));
    this.camera = { k, x: width / 2 - ((left + right) / 2) * k, y: height / 2 - ((top + bottom) / 2) * k + 16 };
    this.apply();
  }

  private zoom(factor: number, clientX?: number, clientY?: number): void {
    const box = this.canvas.getBoundingClientRect();
    const px = (clientX ?? box.left + box.width / 2) - box.left, py = (clientY ?? box.top + box.height / 2) - box.top;
    const k = Math.min(2, Math.max(0.25, this.camera.k * factor));
    this.camera = { k, x: px - (px - this.camera.x) * (k / this.camera.k), y: py - (py - this.camera.y) * (k / this.camera.k) };
    this.apply();
  }

  /* ───────────── edges & guides ───────────── */

  private drawEdges(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    this.edgeLayer.replaceChildren();
    const defs = svg(this.edgeLayer, "defs");
    const max = Math.max(1, ...snapshot.edges.map(edge => edge.weight));
    for (const edge of [...snapshot.edges].sort((a, b) => a.weight - b.weight)) {
      if (!this.cards.has(edge.from) || !this.cards.has(edge.to)) continue;
      const t = Math.sqrt(edge.weight / max);
      const width = 1.25 + 6.75 * t;
      const shape = curve(this.rect(edge.from), this.rect(edge.to), 5 + width * 1.15);
      const id = `${this.uid}-${edge.from}-${edge.to}`;
      const gradient = svg(defs, "linearGradient", { id, gradientUnits: "userSpaceOnUse", x1: shape.start[0], y1: shape.start[1], x2: shape.end[0], y2: shape.end[1] });
      svg(gradient, "stop", { offset: 0, "stop-color": color(edge.from, 0.25 + 0.45 * t) });
      svg(gradient, "stop", { offset: 1, "stop-color": color(edge.to, 0.55 + 0.45 * t) });

      const group = svg(this.edgeLayer, "g", { class: "hm-edge", "data-from": edge.from, "data-to": edge.to });
      group.style.setProperty("--t", t.toFixed(3));
      svg(group, "title").textContent = `${edge.from} → ${edge.to} · ${edge.weight} tasks · 30d`;
      svg(group, "path", { d: shape.d, class: "hm-edge-hit" });
      svg(group, "path", { d: shape.d, class: "hm-edge-line", stroke: `url(#${id})`, "stroke-width": width.toFixed(2) });
      if (t >= 0.3) svg(group, "path", { d: shape.d, class: "hm-edge-flow", "stroke-width": Math.max(1, width * 0.35).toFixed(2) });
      svg(group, "polygon", { points: shape.head, class: "hm-edge-head", fill: color(edge.to, 0.55 + 0.45 * t) });
    }
  }

  private drawGuides(guides: readonly Guide[]): void {
    this.guideLayer.replaceChildren();
    for (const guide of guides) {
      const pad = 18;
      const [x1, y1, x2, y2] = guide.axis === "x" ? [guide.at, guide.from - pad, guide.at, guide.to + pad] : [guide.from - pad, guide.at, guide.to + pad, guide.at];
      svg(this.guideLayer, "line", { x1, y1, x2, y2, "stroke-width": 1 / this.camera.k });
      for (const [cx, cy] of [[x1, y1], [x2, y2]]) svg(this.guideLayer, "circle", { cx: cx!, cy: cy!, r: 2.5 / this.camera.k });
    }
  }

  /** Hovering a card lights its edges and partners and fades the rest. */
  private focus(id: string | null): void {
    if (this.dragging) return;
    this.canvas.toggleClass("is-focusing", id !== null);
    const partners = new Set<string>();
    for (const edge of Array.from(this.edgeLayer.querySelectorAll<SVGGElement>(".hm-edge"))) {
      const lit = id !== null && (edge.dataset.from === id || edge.dataset.to === id);
      edge.classList.toggle("is-lit", lit);
      if (lit) { partners.add(edge.dataset.from!); partners.add(edge.dataset.to!); }
    }
    for (const [cardId, el] of this.cards) el.toggleClass("is-near", partners.has(cardId) || cardId === id);
  }

  /* ───────────── interaction ───────────── */

  private bind(): void {
    const canvas = this.canvas;
    canvas.addEventListener("wheel", event => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) this.zoom(Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
      else { this.camera.x -= event.deltaX; this.camera.y -= event.deltaY; this.apply(); }
    }, { passive: false });

    canvas.addEventListener("pointerdown", event => {
      const target = event.target as HTMLElement;
      if (event.button !== 0 || target.closest("button, input, select, .hm-controls")) return;
      const card = target.closest<HTMLElement>(".hm-card");
      const startX = event.clientX, startY = event.clientY;
      let moved = false;
      canvas.setPointerCapture(event.pointerId);

      let onMove: (e: PointerEvent) => void;
      let onUp: () => void;
      if (card) {
        const id = card.dataset.id!;
        const origin = this.rect(id);
        const others = [...this.cards.keys()].filter(other => other !== id).map(other => this.rect(other));
        onMove = e => {
          if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 3) return;
          if (!moved) { moved = true; this.dragging = true; this.focus(null); card.addClass("is-dragging"); }
          const free = { ...origin, x: origin.x + (e.clientX - startX) / this.camera.k, y: origin.y + (e.clientY - startY) / this.camera.k };
          // Alt drags freely, like PowerPoint.
          const snapped = e.altKey ? { x: free.x, y: free.y, guides: [] } : snap(free, others, 6 / this.camera.k);
          this.positions.set(id, [Math.round(snapped.x), Math.round(snapped.y)]);
          this.place(id);
          this.drawGuides(snapped.guides);
          this.drawEdges();
        };
        onUp = () => {
          card.removeClass("is-dragging");
          this.drawGuides([]);
          this.dragging = false;
          if (moved) this.saveLayout(); else this.inspect(id);
        };
      } else {
        const camera = { ...this.camera };
        canvas.addClass("is-panning");
        onMove = e => {
          moved = moved || Math.hypot(e.clientX - startX, e.clientY - startY) >= 3;
          this.camera.x = camera.x + e.clientX - startX;
          this.camera.y = camera.y + e.clientY - startY;
          this.apply();
        };
        onUp = () => { canvas.removeClass("is-panning"); if (!moved) this.inspector?.close(); };
      }
      const up = (): void => {
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerup", up);
        canvas.removeEventListener("pointercancel", up);
        onUp();
      };
      canvas.addEventListener("pointermove", onMove);
      canvas.addEventListener("pointerup", up);
      canvas.addEventListener("pointercancel", up);
    });
  }

  private controls(): void {
    const bar = this.canvas.createDiv("hm-controls");
    iconButton(bar, "minus", "Zoom out", () => this.zoom(1 / 1.2));
    this.zoomLabel = bar.createEl("button", { cls: "hm-zoom", text: "100%" });
    setTooltip(this.zoomLabel, "Reset zoom");
    this.zoomLabel.addEventListener("click", () => this.zoom(1 / this.camera.k));
    iconButton(bar, "plus", "Zoom in", () => this.zoom(1.2));
    bar.createDiv("hm-sep");
    iconButton(bar, "scan", "Fit", () => this.fit());
    iconButton(bar, "layout-grid", "Auto layout", () => {
      this.positions.clear();
      this.render();
      requestAnimationFrame(() => { this.fit(); this.saveLayout(); });
    });

    const legend = this.canvas.createDiv("hm-legend");
    setTooltip(legend, "Task handoffs · 30d");
    icon(legend, "git-fork");
    const sample = svg(legend, "svg", { viewBox: "0 0 64 12", width: 64, height: 12 });
    [1.2, 3, 5.5].forEach((width, index) => svg(sample, "line", { x1: 2 + index * 21, y1: 6, x2: 18 + index * 21, y2: 6, "stroke-width": width, stroke: "currentColor", "stroke-linecap": "round", opacity: 0.4 + index * 0.3 }));
    const max = Math.max(0, ...(this.snapshot?.edges ?? []).map(edge => edge.weight));
    legend.createSpan({ text: `1–${max}` });
  }

  private saveLayout(): void {
    this.host.saveLayout(this.alias, Object.fromEntries(this.positions));
  }

  private inspect(id: string): void {
    const profile = this.snapshot?.profiles.find(candidate => candidate.id === id);
    if (!profile) return;
    for (const [cardId, el] of this.cards) el.toggleClass("is-selected", cardId === id);
    this.inspector ??= new Inspector(this, this.contentEl, this.host, () => {
      for (const el of this.cards.values()) el.removeClass("is-selected");
      this.inspector = null;
    });
    this.inspector.show(this.alias, profile, this.snapshot!.now);
  }

  override async onClose(): Promise<void> {
    this.inspector?.close();
  }
}
