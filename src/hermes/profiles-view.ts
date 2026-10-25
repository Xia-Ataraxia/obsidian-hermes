import { Notice, setTooltip, type WorkspaceLeaf } from "obsidian";
import { keepProfiles } from "./cache";
import type { Edge, Profile, ProfilesSnapshot } from "./data";
import { ring, tidy, type Gap, type Guide, type Rect } from "./geometry";
import { Inspector } from "./inspector";
import { HermesView, iconButton, type HermesHost } from "./ui";
import { EDGE_MODES, CARD_W, plural, svg } from "./profiles-common";
import { renderCard, sparkline, drawEdges, drawGuides, drawLegend } from "./profiles-draw";
import { bindGestures } from "./profiles-gestures";

export const PROFILES_VIEW = "hermes-profiles";
let instances = 0;
/**
 * Profiles as cards on a pannable canvas. One edge per pair counts 30-day interactions of the
 * chosen kind (`EDGE_MODES`): thickness and opacity scale with volume, the gradient runs between
 * the two hues and the curve bows around the cards in between. Edges redraw whenever the canvas
 * or a card changes size, so a view rendered while hidden lays out once it is shown.
 * Dragging a card snaps it to the other cards' edges, centers and equal gaps with thin guides.
 * Shift-click or a marquee picks cards: picks move together, and Tidy up straightens them (or all).
 */
export class ProfilesView extends HermesView {
  snapshot: ProfilesSnapshot | null = null;
  loadedAlias = "";
  positions = new Map<string, [number, number]>();
  camera = { x: 0, y: 0, k: 1 };
  fitted = false;
  dragging = false;
  canvas!: HTMLElement;
  world!: HTMLElement;
  edgeLayer!: SVGSVGElement;
  guideLayer!: SVGSVGElement;
  zoomLabel!: HTMLElement;
  legend: HTMLElement | null = null;
  readonly cards = new Map<string, HTMLElement>();
  /** Last bow per pair, tried first so an edge keeps its side while cards move. */
  readonly bows = new Map<string, number>();
  readonly uid = `hm${++instances}`;
  inspector: Inspector | null = null;
  observer: ResizeObserver | null = null;
  picks = new Set<string>();
  /** Space is held: a left drag pans, even over a card. */
  space = false;
  /** A pointer is down on the canvas: a re-render would drop the drag it may become. */
  pressed = false;
  /** Lands the glide in flight on its targets and saves, unless a host switch swapped the layout meanwhile. */
  land: (() => void) | null = null;
  tidyButton!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, host: HermesHost) {
    super(leaf, host, 60_000);
  }

  get mode(): (typeof EDGE_MODES)[number] {
    return EDGE_MODES.find(([mode]) => mode === this.host.edgeMode()) ?? EDGE_MODES[0]!;
  }

  weight(edge: Edge): number {
    const [mode] = this.mode;
    return mode === "all" ? edge.handoffs + edge.comments + edge.links : edge[mode];
  }

  getViewType(): string { return PROFILES_VIEW; }
  getDisplayText(): string { return "Hermes profiles"; }
  override getIcon(): string { return "network"; }

  protected override busy(): boolean {
    return this.pressed || this.dragging || (this.inspector?.editing ?? false);
  }

  protected override cacheKey(): string { return "profiles"; }

  protected override cacheData(): unknown { return this.snapshot && keepProfiles(this.snapshot); }

  protected override cacheRestore(saved: unknown): boolean {
    this.snapshot = null;
    const copy = saved as Partial<ProfilesSnapshot> | null;
    if (!copy || typeof copy.now !== "number" || !Array.isArray(copy.profiles) || !Array.isArray(copy.edges)) return false;
    this.adopt(this.alias, copy as ProfilesSnapshot);
    return true;
  }

  /** A host change closes the inspector and drops the picks at once; the base then empties `snapshot` (cacheRestore(null)). */
  protected override leaveHost(): void {
    this.picks.clear();
    this.inspector?.close();
  }

  protected async pull(alias: string): Promise<string | null> {
    const result = await this.host.client.profiles(alias);
    if (typeof result === "string" || alias !== this.alias) return typeof result === "string" ? result : null;
    this.adopt(alias, result);
    return null;
  }

  /** Takes a snapshot of `alias`, saved or live; the first one of a host also loads its layout and drops the last host's picks. */
  adopt(alias: string, snapshot: ProfilesSnapshot): void {
    if (alias !== this.loadedAlias) {
      this.loadedAlias = alias;
      this.positions = new Map(Object.entries(this.host.layout(alias)));
      this.fitted = false;
      this.picks.clear();
      this.inspector?.close();
    }
    this.snapshot = snapshot;
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

  /** The edge mode changed: new lines and legend only; the cards and the profile popup stay as they are. */
  redrawEdges(): void {
    if (!this.legend) return;
    this.drawEdges();
    this.drawLegend();
  }

  /* ───────────── cards ───────────── */

  card(profile: Profile, now: number): HTMLElement { return renderCard.call(this, profile, now); }

  sparkline(parent: HTMLElement, values: readonly number[]): void { return sparkline.call(this, parent, values); }

  /* ───────────── geometry ───────────── */

  rect(id: string): Rect {
    const [x, y] = this.positions.get(id) ?? [0, 0];
    const el = this.cards.get(id);
    return { x, y, w: el?.offsetWidth || CARD_W, h: el?.offsetHeight || 200 };
  }

  place(id: string): void {
    const [x, y] = this.positions.get(id) ?? [0, 0];
    const el = this.cards.get(id);
    el?.setCssProps({ "--card-x": `${x}px`, "--card-y": `${y}px` });
  }

  apply(): void {
    const { x, y, k } = this.camera;
    this.canvas.setCssProps({ "--grid": `${22 * k}px`, "--k": String(k), "--world-x": `${x}px`, "--world-y": `${y}px` });
    this.zoomLabel?.setText(`${Math.round(k * 100)}%`);
  }

  fit(): void {
    const rects = [...this.cards.keys()].map(id => this.rect(id));
    if (rects.length === 0) return;
    const left = Math.min(...rects.map(r => r.x)), top = Math.min(...rects.map(r => r.y));
    const right = Math.max(...rects.map(r => r.x + r.w)), bottom = Math.max(...rects.map(r => r.y + r.h));
    const { clientWidth: width, clientHeight: height } = this.canvas;
    const k = Math.max(0.3, Math.min(1, (width - 120) / (right - left), (height - 140) / (bottom - top)));
    this.camera = { k, x: width / 2 - ((left + right) / 2) * k, y: height / 2 - ((top + bottom) / 2) * k + 16 };
    this.apply();
  }

  zoom(factor: number, clientX?: number, clientY?: number): void {
    const box = this.canvas.getBoundingClientRect();
    const px = (clientX ?? box.left + box.width / 2) - box.left, py = (clientY ?? box.top + box.height / 2) - box.top;
    const k = Math.min(2, Math.max(0.25, this.camera.k * factor));
    this.camera = { k, x: px - (px - this.camera.x) * (k / this.camera.k), y: py - (py - this.camera.y) * (k / this.camera.k) };
    this.apply();
  }

  /* ───────────── edges & guides ───────────── */

  drawEdges(): void { return drawEdges.call(this); }

  /**
   * 1-screen-px lines (solid: edges, dashed: centers) with × where they meet the aligned cards, and
   * |—| spans across equal gaps; old lines fade out.
   */
  drawGuides(guides: readonly Guide[], targets: readonly string[] = [], gaps: readonly Gap[] = []): void { return drawGuides.call(this, guides, targets, gaps); }

  /** Hovering a card lights its edges and partners and fades the rest. */
  focus(id: string | null): void {
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

  bind(): void { return bindGestures.call(this); }

  controls(): void {
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

  drawLegend(): void { return drawLegend.call(this); }

  /** Under the host the positions came from: `alias` switches before its pull lands. */
  saveLayout(): void {
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

  pick(ids: Iterable<string>): void {
    this.picks = new Set([...ids].filter(id => this.cards.has(id)));
    for (const [id, el] of this.cards) el.toggleClass("is-picked", this.picks.has(id));
    const label = this.picks.size >= 2 ? "Tidy up selection" : "Tidy up";
    if (this.tidyButton.getAttr("aria-label") === label) return;
    this.tidyButton.setAttr("aria-label", label);
    setTooltip(this.tidyButton, label);
  }

  tidyUp(): void {
    if (this.dragging) return;
    const ids = this.picks.size >= 2 ? [...this.picks] : [...this.cards.keys()];
    const moved = tidy(new Map([...this.cards.keys()].map(id => [id, this.rect(id)])), ids);
    if (moved.size === 0) { new Notice("Already tidy"); return; }
    const before = new Map<string, [number, number]>([...moved.keys()].map(id => [id, this.positions.get(id) ?? [0, 0]]));
    this.move(moved);
    this.undoable(`Tidied ${plural(moved.size, "card")}`, before);
  }

  /** Glide cards to `to` (instant under reduced motion), then save; a new move first lands the one in flight. */
  move(to: ReadonlyMap<string, readonly [number, number]>): void {
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
  undoable(text: string, before: ReadonlyMap<string, readonly [number, number]>): void {
    const alias = this.alias;
    const notice = new Notice(createFragment(fragment => {
      fragment.appendText(`${text} `);
      fragment.createEl("button", { text: "Undo" }).addEventListener("click", () => {
        notice.hide();
        if (this.alias === alias) this.move(before);
      });
    }), 6000);
  }

  inspect(id: string): void {
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
    await super.onClose();
    this.land?.();
    this.dragging = false;
    this.observer?.disconnect();
    this.inspector?.close();
  }
}
