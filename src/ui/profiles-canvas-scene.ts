import { serializeScopedKey } from "../domain/control-center-validation";
import type { ProfileKey } from "../types/control-center";
import type { ActivityEdge } from "../types/task-activity";
import type { TaskActivityProjection } from "../types/task-activity-projection";
import type { ConfiguredOrchestrator } from "../types/profiles-canvas";
import { canvasButton, canvasElement } from "./profiles-canvas-dom";
import { CANVAS_GEOMETRY, edgeKey, edgeOpacity, peerLabel, sketchOutline, sketchPath } from "./profiles-canvas-model";
import type { ProfilesCanvasLayout } from "./profiles-canvas-model";

type Node = { readonly root: HTMLButtonElement; readonly label: HTMLElement; readonly state: HTMLElement; readonly fact: HTMLElement; readonly profile: ProfileKey };
type Edge = { readonly path: SVGPathElement; readonly hit: SVGPathElement; readonly button: HTMLButtonElement; value: ActivityEdge };
export class ProfilesCanvasScene {
  readonly world: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly nodes = new Map<string, Node>();
  private readonly edges = new Map<string, Edge>();
  private projection: TaskActivityProjection | null = null;
  query = "";
  selected: string | null = null;
  constructor(stage: HTMLElement, readonly layout: ProfilesCanvasLayout, select: (profile: ProfileKey, anchor: HTMLElement) => void, private readonly selectEdge: (edge: ActivityEdge, anchor: HTMLElement) => void, private readonly save: () => void) {
    this.world = canvasElement(stage, "div", "hpc-world");
    this.svg = stage.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.classList.add("hpc-lines");
    this.svg.setAttribute("aria-hidden", "true");
    this.world.append(this.svg);
    this.world.addEventListener("click", event => {
      if (!(event.target instanceof Element)) return;
      const key = event.target.closest<HTMLElement>(".hpc-node")?.dataset.profileKey;
      const node = key ? this.nodes.get(key) : undefined;
      if (node) select(node.profile, node.root);
    });
    this.world.addEventListener("keydown", event => {
      if (!(event.target instanceof Element)) return;
      const profile = this.profileFor(event.target);
      if (!profile) return;
      const delta = event.shiftKey ? 40 : 10;
      const point = layout.point(profile);
      const movements: Readonly<Record<string, readonly [number, number]>> = { ArrowLeft: [-delta, 0], ArrowRight: [delta, 0], ArrowUp: [0, -delta], ArrowDown: [0, delta] };
      const movement = movements[event.key];
      if (!movement) return;
      event.preventDefault(); event.stopPropagation();
      layout.move(profile, { x: point.x + movement[0], y: point.y + movement[1] });
      this.position(); save();
    });
  }
  profileFor(element: Element): ProfileKey | null {
    const key = element.closest<HTMLElement>(".hpc-node")?.dataset.profileKey;
    return key ? this.nodes.get(key)?.profile ?? null : null;
  }
  update(projection: TaskActivityProjection, orchestrator: ConfiguredOrchestrator, dragging: ProfileKey | null): void {
    this.projection = projection;
    const current = new Set(projection.nodes.map(node => serializeScopedKey(node.profile)));
    for (const [key, node] of this.nodes) if (!current.has(key) && node.profile.profile !== dragging?.profile) { node.root.remove(); this.nodes.delete(key); }
    for (const value of projection.nodes) {
      const key = serializeScopedKey(value.profile);
      let node = this.nodes.get(key);
      if (!node) {
        const root = canvasButton(this.world, "", () => undefined, "hpc-node");
        root.dataset.profileKey = key;
        const outline = root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
        outline.setAttribute("viewBox", "0 0 176 112");
        outline.setAttribute("preserveAspectRatio", "none");
        outline.setAttribute("aria-hidden", "true");
        outline.classList.add("hpc-node-outline");
        const path = root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", sketchOutline(key));
        outline.append(path); root.append(outline);
        node = { root, label: canvasElement(root, "strong", ""), state: canvasElement(root, "span", "hpc-node-state"), fact: canvasElement(root, "small", "hpc-node-fact"), profile: value.profile };
        this.nodes.set(key, node);
      }
      node.label.textContent = value.profile.profile;
      node.state.textContent = peerLabel(value);
      node.fact.textContent = orchestrator.kind === "configured" && serializeScopedKey(orchestrator.profile) === key ? "설정된 오케스트레이터" : "";
      node.root.setAttribute("aria-pressed", String(this.selected === key));
      node.root.hidden = !value.profile.profile.toLocaleLowerCase().includes(this.query.toLocaleLowerCase()) && value.profile.profile !== dragging?.profile;
    }
    const keys = new Set(projection.edges.map(edgeKey));
    for (const [key, edge] of this.edges) if (!keys.has(key)) { edge.path.remove(); edge.hit.remove(); edge.button.remove(); this.edges.delete(key); }
    for (const value of projection.edges) {
      const key = edgeKey(value);
      let edge = this.edges.get(key);
      if (!edge) {
        const path = this.svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
        this.svg.append(path);
        const button = canvasButton(this.world, "", () => { const current = this.edges.get(key); if (current) this.selectEdge(current.value, current.button); }, "hpc-edge-label");
        const hit = this.svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
        hit.classList.add("hpc-edge-hit");
        hit.addEventListener("pointerdown", event => event.stopPropagation());
        hit.addEventListener("click", () => button.click());
        this.svg.append(hit);
        edge = { path, hit, button, value };
        this.edges.set(key, edge);
      }
      edge.value = value;
      edge.path.style.opacity = String(edgeOpacity(value.distinctTaskCount));
      edge.button.textContent = `${value.distinctTaskCount}개 작업`;
      edge.button.setAttribute("aria-label", `${value.profiles[0].profile} — ${value.profiles[1].profile}, ${value.distinctTaskCount}개 작업, 기록 보기`);
    }
    this.position();
  }
  position(): void {
    const viewport = this.layout.viewport;
    this.world.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;
    for (const node of this.nodes.values()) {
      const point = this.layout.point(node.profile);
      node.root.style.transform = `translate(${point.x}px, ${point.y}px)`;
    }
    for (const [key, edge] of this.edges) {
      const from = this.layout.point(edge.value.profiles[0]), to = this.layout.point(edge.value.profiles[1]);
      const a = { x: from.x + CANVAS_GEOMETRY.width / 2, y: from.y + CANVAS_GEOMETRY.height / 2 };
      const b = { x: to.x + CANVAS_GEOMETRY.width / 2, y: to.y + CANVAS_GEOMETRY.height / 2 };
      edge.path.setAttribute("d", sketchPath(key, a, b));
      edge.hit.setAttribute("d", sketchPath(key, a, b));
      edge.button.style.transform = `translate(${(a.x + b.x) / 2}px, ${(a.y + b.y) / 2}px) translate(-50%, -50%)`;
      const visible = edge.value.profiles.every(profile => this.nodes.get(serializeScopedKey(profile))?.root.hidden === false);
      edge.path.style.display = visible ? "" : "none";
      edge.hit.style.display = visible ? "" : "none";
      edge.button.hidden = !visible;
    }
  }
  get profiles(): readonly ProfileKey[] { return this.projection?.nodes.map(node => node.profile) ?? []; }
  dispose(): void { this.nodes.clear(); this.edges.clear(); this.projection = null; this.world.remove(); }
}
