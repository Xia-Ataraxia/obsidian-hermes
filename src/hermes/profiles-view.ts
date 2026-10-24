import { Notice, setTooltip, type WorkspaceLeaf } from "obsidian";
import type { EdgeMode } from "../types/snapshot";
import type { Edge, Profile, ProfilesSnapshot } from "./data";
import { curve, hue, overlap, ring, snap, tidy, type Gap, type Guide, type Rect } from "./geometry";
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

/** What an edge counts, for the legend switch and the settings dropdown: mode, icon, label, unit, meaning. */
export const EDGE_MODES: readonly (readonly [EdgeMode, string, string, string, string])[] = [
  ["handoffs", "arrow-right-left", "Handoffs", "handoff", "tasks one profile created for the other"],
  ["comments", "message-square", "Comments", "comment", "comments on tasks assigned to the other"],
  ["links", "link", "Dependencies", "link", "parent/child task links between them"],
  ["all", "layers", "All", "interaction", "handoffs + comments + dependencies"],
];

function svg<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  parent.appendChild(el);
  return el;
}

const color = (id: string): string => `hsl(${Math.round(hue(id))} 68% 58%)`;
const shortModel = (model: string): string => model.split("/").pop() ?? model;
const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;

/**
 * Profiles as cards on a pannable canvas. One edge per pair counts 30-day interactions of the
 * chosen kind (`EDGE_MODES`): thickness and opacity scale with volume, the gradient runs between
 * the two hues and the curve bows around the cards in between. Edges redraw whenever the canvas
 * or a card changes size, so a view rendered while hidden lays out once it is shown.
 * Dragging a card snaps it to the other cards' edges, centers and equal gaps with thin guides.
 * Shift-click or a marquee picks cards: picks move together, and Tidy up straightens them (or all).
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
  private legend: HTMLElement | null = null;
  private readonly cards = new Map<string, HTMLElement>();
  /** Last bow per pair, tried first so an edge keeps its side while cards move. */
  private readonly bows = new Map<string, number>();
  private readonly uid = `hm${++instances}`;
  private inspector: Inspector | null = null;
  private observer: ResizeObserver | null = null;
  private picks = new Set<string>();
  /** Space is held: a left drag pans, even over a card. */
  private space = false;
  /** A pointer is down on the canvas: a re-render would drop the drag it may become. */
  private pressed = false;
  /** Lands the glide in flight on its targets and saves, unless a host switch swapped the layout meanwhile. */
  private land: (() => void) | null = null;
  private tidyButton!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, host: HermesHost) {
    super(leaf, host, 60_000);
  }

  private get mode(): (typeof EDGE_MODES)[number] {
    return EDGE_MODES.find(([mode]) => mode === this.host.edgeMode()) ?? EDGE_MODES[0]!;
  }

  private weight(edge: Edge): number {
    const [mode] = this.mode;
    return mode === "all" ? edge.handoffs + edge.comments + edge.links : edge[mode];
  }

  getViewType(): string { return PROFILES_VIEW; }
  getDisplayText(): string { return "Hermes profiles"; }
  override getIcon(): string { return "network"; }

  protected override busy(): boolean {
    return this.pressed || this.dragging || (this.inspector?.editing ?? false);
  }

  protected async pull(alias: string): Promise<string | null> {
    const result = await this.host.client.profiles(alias);
    if (typeof result === "string" || alias !== this.alias) return typeof result === "string" ? result : null;
    if (alias !== this.loadedAlias) {
      this.loadedAlias = alias;
      this.positions = new Map(Object.entries(this.host.layout(alias)));
      this.fitted = false;
      this.picks.clear();
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
      const weight = (id: string): number => snapshot.edges.reduce((sum, edge) => sum + (edge.a === id || edge.b === id ? this.weight(edge) : 0), 0);
      const placed = ring(snapshot.profiles.map(profile => profile.id), weight, { w: CARD_W, h: 240 });
      for (const profile of missing) this.positions.set(profile.id, placed.get(profile.id) ?? [0, 0]);
    }
    for (const id of this.cards.keys()) this.place(id);

    this.controls();
    this.bind();
    // Layout reads wait for real sizes: none while hidden, and again whenever a card or the canvas resizes.
    this.observer ??= new ResizeObserver(() => {
      if (!this.canvas.clientWidth) return;
      if (!this.fitted && this.cards.size) { this.fit(); this.fitted = true; } else this.apply();
      this.drawEdges();
    });
    this.observer.disconnect();
    for (const el of [this.canvas, ...this.cards.values()]) this.observer.observe(el);
    const selected = this.inspector?.profileId;
    const profile = snapshot.profiles.find(candidate => candidate.id === selected);
    if (profile) { this.inspector?.update(profile, snapshot.now); this.cards.get(profile.id)?.addClass("is-selected"); } else this.inspector?.close();
  }

  /** The edge mode changed: new lines and legend only, so an open edit in the drawer survives. */
  redrawEdges(): void {
    if (!this.legend) return;
    this.drawEdges();
    this.drawLegend();
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
    if ((usage?.busy ?? 0) > 0) stat(load, "zap", usage!.busy, `Running now${usage!.recent[0] ? `\n${usage!.recent[0][0]}` : ""}`, "hm-chip is-busy");
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
    this.canvas.style.setProperty("--k", String(k));
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
    const [, , , unit] = this.mode;
    const edges = snapshot.edges.map(edge => [edge, this.weight(edge)] as const)
      .filter(([edge, n]) => n > 0 && this.cards.has(edge.a) && this.cards.has(edge.b)).sort((x, y) => x[1] - y[1]);
    const max = Math.max(1, ...edges.map(([, n]) => n));
    const rects = new Map([...this.cards.keys()].map(id => [id, this.rect(id)]));
    for (const [index, [{ a, b }, n]] of edges.entries()) {
      const t = Math.sqrt(n / max);
      const shape = curve(rects.get(a)!, rects.get(b)!, [...rects].filter(([id]) => id !== a && id !== b).map(([, rect]) => rect), this.bows.get(`${a} ${b}`));
      this.bows.set(`${a} ${b}`, shape.bow);
      const id = `${this.uid}-${index}`;
      const gradient = svg(defs, "linearGradient", { id, gradientUnits: "userSpaceOnUse", x1: shape.start[0], y1: shape.start[1], x2: shape.end[0], y2: shape.end[1] });
      svg(gradient, "stop", { offset: 0, "stop-color": color(a) });
      svg(gradient, "stop", { offset: 1, "stop-color": color(b) });

      const group = svg(this.edgeLayer, "g", { class: "hm-edge", "data-a": a, "data-b": b });
      group.style.setProperty("--t", t.toFixed(3));
      svg(group, "title").textContent = `${a} ↔ ${b} · ${plural(n, unit)}`;
      svg(group, "path", { d: shape.d, class: "hm-edge-hit" });
      svg(group, "path", { d: shape.d, class: "hm-edge-line", stroke: `url(#${id})`, "stroke-width": (1.25 + 6.75 * t).toFixed(2) });
    }
  }

  /**
   * 1-screen-px lines (solid: edges, dashed: centers) with × where they meet the aligned cards, and
   * |—| spans across equal gaps; old lines fade out.
   */
  private drawGuides(guides: readonly Guide[], targets: readonly string[] = [], gaps: readonly Gap[] = []): void {
    for (const [id, el] of this.cards) el.toggleClass("is-snap-target", targets.includes(id));
    this.guideLayer.classList.toggle("is-on", guides.length + gaps.length > 0);
    if (guides.length + gaps.length === 0) return;
    const k = this.camera.k, over = 8 / k, size = 3 / k;
    this.guideLayer.replaceChildren();
    this.guideLayer.setAttribute("stroke-width", String(1 / k));
    for (const guide of guides) {
      const point = (along: number): [number, number] => guide.axis === "x" ? [guide.at, along] : [along, guide.at];
      const [x1, y1] = point(Math.min(...guide.marks) - over), [x2, y2] = point(Math.max(...guide.marks) + over);
      svg(this.guideLayer, "line", { x1, y1, x2, y2, "stroke-dasharray": guide.center ? `${4 / k} ${3 / k}` : "none" });
      svg(this.guideLayer, "path", { d: guide.marks.map(mark => { const [x, y] = point(mark); return `M${x - size},${y - size}L${x + size},${y + size}M${x - size},${y + size}L${x + size},${y - size}`; }).join("") });
    }
    for (const gap of gaps) {
      const point = (along: number, across: number): [number, number] => gap.axis === "x" ? [along, across] : [across, along];
      const line = ([x1, y1]: [number, number], [x2, y2]: [number, number]): SVGLineElement => svg(this.guideLayer, "line", { x1, y1, x2, y2 });
      line(point(gap.from, gap.at), point(gap.to, gap.at));
      for (const end of [gap.from, gap.to]) line(point(end, gap.at - size), point(end, gap.at + size));
    }
  }

  /** Hovering a card lights its edges and partners and fades the rest. */
  private focus(id: string | null): void {
    if (this.dragging) return;
    this.canvas.toggleClass("is-focusing", id !== null);
    const partners = new Set<string>();
    for (const edge of Array.from(this.edgeLayer.querySelectorAll<SVGGElement>(".hm-edge"))) {
      const lit = id !== null && (edge.dataset.a === id || edge.dataset.b === id);
      edge.classList.toggle("is-lit", lit);
      if (lit) { partners.add(edge.dataset.a!); partners.add(edge.dataset.b!); }
    }
    for (const [cardId, el] of this.cards) el.toggleClass("is-near", partners.has(cardId) || cardId === id);
  }

  /* ───────────── interaction ───────────── */

  private bind(): void {
    const canvas = this.canvas;
    this.pick(this.picks);
    canvas.addEventListener("wheel", event => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) this.zoom(Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
      else { this.camera.x -= event.deltaX; this.camera.y -= event.deltaY; this.apply(); }
    }, { passive: false });

    canvas.addEventListener("pointerdown", event => {
      const target = event.target as HTMLElement;
      if (target.closest("button, input, select, .hm-controls, .hm-legend")) return;
      const card = target.closest<HTMLElement>(".hm-card");
      // Space or the middle button pans from anywhere, a finger from empty canvas; a plain drag there draws a marquee.
      const pan = event.button === 1 || (event.button === 0 && (this.space || (event.pointerType === "touch" && !card)));
      if (!pan && event.button !== 0) return;
      if (event.button === 1) event.preventDefault(); // or Chromium on Windows starts autoscroll
      this.pressed = true;
      const startX = event.clientX, startY = event.clientY;
      let moved = false;
      try { canvas.setPointerCapture(event.pointerId); } catch { /* a synthetic pointer has nothing to capture */ }

      let onMove: (e: PointerEvent) => void;
      let onUp: () => void;
      if (card && !pan) {
        const id = card.dataset.id!;
        const was = this.picks.has(id);
        // Picks change on press, like Figma: Shift adds the card, a plain press on an unpicked one starts over.
        if (!was) this.pick(event.shiftKey ? [...this.picks, id] : []);
        const group = this.picks.has(id) && this.picks.size >= 2 ? [...this.picks] : [id];
        const origins = new Map(group.map(member => [member, this.rect(member)] as const));
        const rects = [...origins.values()];
        const left = Math.min(...rects.map(r => r.x)), top = Math.min(...rects.map(r => r.y));
        const box = { x: left, y: top, w: Math.max(...rects.map(r => r.x + r.w)) - left, h: Math.max(...rects.map(r => r.y + r.h)) - top };
        const ids = [...this.cards.keys()].filter(other => !origins.has(other));
        const others = ids.map(other => this.rect(other));
        onMove = e => {
          if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 3) return;
          if (!moved) { moved = true; this.dragging = true; this.focus(null); for (const member of group) this.cards.get(member)?.addClass("is-dragging"); }
          const free = { ...box, x: box.x + (e.clientX - startX) / this.camera.k, y: box.y + (e.clientY - startY) / this.camera.k };
          // Alt drags freely, like PowerPoint.
          const snapped = e.altKey ? { x: free.x, y: free.y, guides: [], gaps: [], targets: [] } : snap(free, others, 6 / this.camera.k);
          for (const [member, origin] of origins) {
            this.positions.set(member, [Math.round(origin.x + snapped.x - box.x), Math.round(origin.y + snapped.y - box.y)]);
            this.place(member);
          }
          this.drawGuides(snapped.guides, snapped.targets.map(index => ids[index]!), snapped.gaps);
          this.drawEdges();
        };
        onUp = () => {
          for (const member of group) this.cards.get(member)?.removeClass("is-dragging");
          this.drawGuides([]);
          this.dragging = false;
          if (moved) this.saveLayout();
          else if (event.shiftKey) { if (was) this.pick([...this.picks].filter(other => other !== id)); }
          else { this.pick([]); this.inspect(id); }
        };
      } else if (pan) {
        const camera = { ...this.camera };
        canvas.addClass("is-panning");
        onMove = e => {
          this.camera.x = camera.x + e.clientX - startX;
          this.camera.y = camera.y + e.clientY - startY;
          this.apply();
        };
        onUp = () => canvas.removeClass("is-panning");
      } else {
        const base = event.shiftKey ? [...this.picks] : [];
        const rects = [...this.cards.keys()].map(other => [other, this.rect(other)] as const);
        const bounds = canvas.getBoundingClientRect();
        let marquee: HTMLElement | null = null;
        onMove = e => {
          if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 3) return;
          moved = true;
          this.dragging = true;
          const el = (marquee ??= canvas.createDiv("hm-marquee"));
          const x = Math.min(startX, e.clientX) - bounds.left, y = Math.min(startY, e.clientY) - bounds.top;
          const w = Math.abs(e.clientX - startX), h = Math.abs(e.clientY - startY);
          el.style.transform = `translate(${x}px, ${y}px)`;
          el.style.width = `${w}px`;
          el.style.height = `${h}px`;
          const { x: cx, y: cy, k } = this.camera;
          const area = { x: (x - cx) / k, y: (y - cy) / k, w: w / k, h: h / k };
          this.pick([...base, ...rects.filter(([, r]) => overlap(area, r) > 0).map(([other]) => other)]);
        };
        onUp = () => {
          marquee?.remove();
          this.dragging = false;
          if (!moved) { if (!event.shiftKey) this.pick([]); this.inspector?.close(); }
        };
      }
      const up = (): void => {
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerup", up);
        canvas.removeEventListener("pointercancel", up);
        this.pressed = false;
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
    this.tidyButton = iconButton(bar, "layout-grid", "Tidy up", () => this.tidyUp());
    iconButton(bar, "rotate-ccw", "Reset layout", () => {
      if (this.dragging) return;
      const before = new Map(this.positions);
      this.positions.clear();
      this.bows.clear();
      this.fitted = false;
      this.render();
      this.saveLayout();
      this.undoable("Layout reset", before);
    });
    this.legend = this.canvas.createDiv("hm-legend");
    this.drawLegend();
  }

  private drawLegend(): void {
    const legend = this.legend!;
    legend.empty();
    const [current, , , unit, meaning] = this.mode;
    const modes = legend.createDiv("hm-segment");
    for (const [mode, name, label, , what] of EDGE_MODES) {
      iconButton(modes, name, `${label} · ${what}`, () => this.host.setEdgeMode(mode)).setAttr("aria-pressed", String(mode === current));
    }
    const scale = legend.createDiv("hm-legend-scale");
    setTooltip(scale, `Thickness · ${meaning} · 30d`);
    const sample = svg(scale, "svg", { viewBox: "0 0 64 12", width: 64, height: 12 });
    [1.2, 3, 5.5].forEach((width, index) => svg(sample, "line", { x1: 2 + index * 21, y1: 6, x2: 18 + index * 21, y2: 6, "stroke-width": width, stroke: "currentColor", "stroke-linecap": "round", opacity: 0.4 + index * 0.3 }));
    const max = Math.max(0, ...(this.snapshot?.edges ?? []).map(edge => this.weight(edge)));
    scale.createSpan({ text: `${max > 1 ? "1–" : ""}${plural(max, unit)}` });
  }

  /** Under the host the positions came from: `alias` switches before its pull lands. */
  private saveLayout(): void {
    this.host.saveLayout(this.loadedAlias, Object.fromEntries(this.positions));
  }

  /** Space-to-pan and Esc, for keys aimed at this view: not other leaves, modals or the drawer. */
  override async onOpen(): Promise<void> {
    await super.onOpen();
    const ours = (event: KeyboardEvent): boolean => {
      const target = event.target as HTMLElement;
      return !event.defaultPrevented && this.app.workspace.getActiveViewOfType(ProfilesView) === this
        && (target.contains(this.contentEl) || (this.contentEl.contains(target) && !target.closest(".hm-drawer")));
    };
    const hold = (on: boolean): void => { this.space = on; this.contentEl.toggleClass("is-space", on); };
    this.registerDomEvent(this.contentEl.doc, "keydown", event => {
      if (!ours(event)) return;
      if (event.key === "Escape" && this.picks.size > 0) this.pick([]);
      // A clicked button keeps focus; only a keyboard-focused one keeps Space for itself.
      if (event.key === " " && !(event.target as HTMLElement).closest("input, textarea, select, button:focus-visible, [contenteditable]")) {
        event.preventDefault();
        hold(true);
      }
    });
    this.registerDomEvent(this.contentEl.doc, "keyup", event => { if (event.key === " ") hold(false); });
    this.registerDomEvent(this.contentEl.win, "blur", () => hold(false));
  }

  private pick(ids: Iterable<string>): void {
    this.picks = new Set([...ids].filter(id => this.cards.has(id)));
    for (const [id, el] of this.cards) el.toggleClass("is-picked", this.picks.has(id));
    const label = this.picks.size >= 2 ? "Tidy up selection" : "Tidy up";
    if (this.tidyButton.getAttr("aria-label") === label) return;
    this.tidyButton.setAttr("aria-label", label);
    setTooltip(this.tidyButton, label);
  }

  private tidyUp(): void {
    if (this.dragging) return;
    const ids = this.picks.size >= 2 ? [...this.picks] : [...this.cards.keys()];
    const moved = tidy(new Map([...this.cards.keys()].map(id => [id, this.rect(id)])), ids);
    if (moved.size === 0) { new Notice("Already tidy"); return; }
    const before = new Map<string, [number, number]>([...moved.keys()].map(id => [id, this.positions.get(id) ?? [0, 0]]));
    this.move(moved);
    this.undoable(`Tidied ${plural(moved.size, "card")}`, before);
  }

  /** Glide cards to `to` (instant under reduced motion), then save; a new move first lands the one in flight. */
  private move(to: ReadonlyMap<string, readonly [number, number]>): void {
    this.land?.();
    const win = this.contentEl.win, map = this.positions;
    const from = new Map<string, [number, number]>([...to.keys()].map(id => [id, map.get(id) ?? [0, 0]]));
    const ms = win.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180;
    let start: number | undefined, tween = 0;
    this.dragging = true;
    const land = (): void => {
      win.cancelAnimationFrame(tween);
      this.land = null;
      this.dragging = false;
      if (this.positions !== map) return;
      for (const [id, [x, y]] of to) { map.set(id, [x, y]); this.place(id); }
      this.drawEdges();
      this.saveLayout();
    };
    const frame = (now: number): void => {
      start ??= now;
      const t = ms === 0 ? 1 : Math.min(1, (now - start) / ms), ease = 1 - (1 - t) ** 3;
      if (t === 1 || this.positions !== map) { land(); return; }
      for (const [id, [x, y]] of to) {
        const [fx, fy] = from.get(id)!;
        map.set(id, [Math.round(fx + (x - fx) * ease), Math.round(fy + (y - fy) * ease)]);
        this.place(id);
      }
      this.drawEdges();
      tween = win.requestAnimationFrame(frame);
    };
    this.land = land;
    tween = win.requestAnimationFrame(frame);
  }

  /** A notice with an Undo button that glides the cards back, unless the host changed meanwhile. */
  private undoable(text: string, before: ReadonlyMap<string, readonly [number, number]>): void {
    const alias = this.alias;
    const notice = new Notice(createFragment(fragment => {
      fragment.appendText(`${text} `);
      fragment.createEl("button", { text: "Undo" }).addEventListener("click", () => {
        notice.hide();
        if (this.alias === alias) this.move(before);
      });
    }), 6000);
  }

  private inspect(id: string): void {
    const profile = this.snapshot?.profiles.find(candidate => candidate.id === id);
    if (!profile) return;
    for (const [cardId, el] of this.cards) el.toggleClass("is-selected", cardId === id);
    this.inspector ??= new Inspector(this, this.contentEl, this.host, () => {
      for (const el of this.cards.values()) el.removeClass("is-selected");
      this.inspector = null;
    }, () => this.snapshot?.profiles ?? [], () => void this.reload());
    this.inspector.show(this.alias, profile, this.snapshot!.now);
  }

  override async onClose(): Promise<void> {
    this.land?.();
    this.dragging = false;
    this.observer?.disconnect();
    this.inspector?.close();
  }
}
