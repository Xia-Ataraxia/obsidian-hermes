import { serializeScopedKey } from "../domain/control-center-validation";
import type { ProfileKey } from "../types/control-center";
import type { ActivityEdge } from "../types/task-activity";
import type { CanvasInspector, ProfilesCanvasServices } from "../types/profiles-canvas";
import { canvasButton, canvasElement } from "./profiles-canvas-dom";
import { ProfilesCanvasControls } from "./profiles-canvas-controls";
import { ProfilesCanvasEdgeDetail } from "./profiles-canvas-edge-detail";
import { ProfilesCanvasGestures } from "./profiles-canvas-gestures";
import { ProfilesCanvasLayout } from "./profiles-canvas-model";
import { ProfilesCanvasScene } from "./profiles-canvas-scene";
import { ProfilesCanvasSource } from "./profiles-canvas-source";

export class ProfilesCanvas {
  private readonly root: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly status: HTMLElement;
  private readonly scope: HTMLElement;
  private readonly zoomLabel: HTMLElement;
  private readonly controls: ProfilesCanvasControls;
  private readonly layout: ProfilesCanvasLayout;
  private readonly scene: ProfilesCanvasScene;
  private readonly source: ProfilesCanvasSource;
  private readonly gestures: ProfilesCanvasGestures;
  private readonly inspector: CanvasInspector;
  private readonly edgeDetail: ProfilesCanvasEdgeDetail;
  private readonly unsubscribe: () => void;
  private disposed = false;
  private selectionGeneration = 0;
  private saveTail = Promise.resolve();
  constructor(container: HTMLElement, private readonly services: ProfilesCanvasServices) {
    this.root = canvasElement(container, "div", "hpc-root");
    const header = canvasElement(this.root, "header", "hpc-header");
    canvasElement(header, "h2", "", "프로파일 맵");
    canvasElement(header, "span", "hpc-muted", services.state.connection);
    this.layout = new ProfilesCanvasLayout(services.preferences);
    this.source = new ProfilesCanvasSource(services);
    this.controls = new ProfilesCanvasControls(this.root, () => this.source.filters, query => this.search(query), filters => { this.edgeDetail.close(false); this.source.setFilters(filters); this.save(); }, () => { void this.refresh(); });
    this.scope = canvasElement(this.root, "div", "hpc-scope");
    this.status = canvasElement(this.root, "div", "hpc-status");
    this.status.setAttribute("role", "status");
    this.stage = canvasElement(this.root, "div", "hpc-stage");
    this.stage.tabIndex = 0;
    this.stage.setAttribute("aria-label", "프로파일 캔버스. 빈 공간 끌기로 이동, 노드 방향키로 위치 조정, Enter로 상세 열기");
    this.scene = new ProfilesCanvasScene(this.stage, this.layout, (profile, anchor) => { void this.select(profile, anchor); }, (edge, anchor) => { void this.selectEdge(edge, anchor); }, () => this.save());
    const overlay = canvasElement(this.stage, "div", "hpc-overlay");
    this.inspector = services.mountInspector(overlay, () => { this.scene.selected = null; this.render(); });
    this.edgeDetail = new ProfilesCanvasEdgeDetail(overlay, task => services.openTask(task), error => this.report(error));
    const tools = canvasElement(this.stage, "div", "hpc-tools");
    canvasButton(tools, "−", () => this.zoom(.8)).setAttribute("aria-label", "축소");
    this.zoomLabel = canvasElement(tools, "output", "", "100%");
    canvasButton(tools, "+", () => this.zoom(1.25)).setAttribute("aria-label", "확대");
    canvasButton(tools, "화면 초기화", () => { this.layout.reset(); this.controls.search.value = ""; this.scene.query = ""; this.render(); this.save(); });
    this.gestures = new ProfilesCanvasGestures(this.stage, this.layout, element => this.scene.profileFor(element), () => this.position(), () => this.save());
    this.stage.addEventListener("keydown", event => {
      if (event.target !== this.stage) return;
      if (event.key === "Escape") { void this.closeInspector(); this.edgeDetail.close(); }
      const shifts: Readonly<Record<string, readonly [number, number]>> = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] };
      const shift = shifts[event.key];
      if (shift) { event.preventDefault(); this.layout.pan({ x: this.layout.viewport.x + shift[0], y: this.layout.viewport.y + shift[1] }); this.position(); this.save(); }
    });
    this.root.addEventListener("keydown", event => { if (event.key === "Escape" && event.target instanceof Element && event.target.closest(".hpc-node")) { event.preventDefault(); void this.closeInspector(); } });
    this.unsubscribe = this.source.subscribe(() => this.render());
    this.render();
  }
  async start(): Promise<void> { if (!this.disposed) await this.source.start(); }
  private async select(profile: ProfileKey, anchor: HTMLElement): Promise<void> {
    const generation = ++this.selectionGeneration;
    try {
      if (await this.inspector.select(profile, anchor) && generation === this.selectionGeneration && !this.disposed) { this.edgeDetail.close(false); this.scene.selected = serializeScopedKey(profile); this.render(); }
    } catch (error) { if (!(error instanceof Error)) throw error; this.report(error); }
  }
  private async selectEdge(edge: ActivityEdge, anchor: HTMLElement): Promise<void> {
    const generation = ++this.selectionGeneration;
    if (!await this.inspector.close() || generation !== this.selectionGeneration || this.disposed) return;
    this.scene.selected = null;
    const coverage = this.source.projection.coverage;
    this.edgeDetail.show(edge, anchor, this.source.scopeLabel, !coverage.complete || !coverage.fresh || !coverage.attributionComplete);
    this.render();
  }
  private async closeInspector(): Promise<void> { ++this.selectionGeneration; if (await this.inspector.close() && !this.disposed) { this.scene.selected = null; this.render(); } }
  private zoom(factor: number): void { this.layout.zoom(factor, { x: this.stage.clientWidth / 2, y: this.stage.clientHeight / 2 }); this.position(); this.save(); }
  private search(query: string): void {
    this.scene.query = query;
    const match = query ? this.scene.profiles.find(profile => profile.profile.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : null;
    if (match) {
      const point = this.layout.point(match);
      this.layout.pan({ x: 64 - point.x * this.layout.viewport.zoom, y: 64 - point.y * this.layout.viewport.zoom });
    }
    this.render();
  }
  private position(): void { this.scene.position(); this.zoomLabel.textContent = `${Math.round(this.layout.viewport.zoom * 100)}%`; }
  private render(): void {
    if (this.disposed) return;
    const projection = this.source.projection;
    const coverage = projection.coverage;
    this.controls.updateBoards(this.source.availableBoards);
    this.scope.textContent = `${this.source.scopeLabel} · ${this.source.freshnessLabel}`;
    const status = coverage.complete && coverage.fresh && coverage.attributionComplete ? "선택 범위 수집 완료" : "부분 / 오래된 기록 · 연결 여부 판단 불가";
    this.status.textContent = `${projection.nodes.length}개 프로파일 · ${status} · 선 진하기 / 숫자: 고유 작업 수${this.source.orchestrator.kind === "unknown" ? " · 오케스트레이터 설정 확인 불가" : ""}`;
    this.scene.update(projection, this.source.orchestrator, this.gestures?.activeProfile ?? null);
    this.position();
  }
  private report(error: Error): void { if (!this.disposed) this.status.textContent = `요청을 완료하지 못했습니다 · ${error.message}`; }
  private save(): void {
    if (this.disposed) return;
    const metadata = this.layout.metadata(this.scene.profiles, this.source.filters);
    this.saveTail = this.saveTail.then(() => this.disposed ? undefined : this.services.savePreferences(metadata)).catch(error => { if (!(error instanceof Error)) throw error; this.report(error); });
  }
  async refresh(): Promise<void> { if (!this.disposed) await Promise.all([this.source.refresh(), this.inspector.refresh()]); }
  setVisible(visible: boolean): void { this.source.setVisible(visible); this.inspector.setVisible?.(visible); }
  async close(): Promise<boolean> { if (!await this.inspector.close()) return false; this.dispose(); return true; }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ++this.selectionGeneration;
    this.unsubscribe(); this.gestures.dispose(); this.source.dispose(); this.inspector.dispose(); this.edgeDetail.dispose(); this.scene.dispose(); this.root.remove();
  }
}
export function mountProfilesCanvas(container: HTMLElement, services: ProfilesCanvasServices): ProfilesCanvas { return new ProfilesCanvas(container, services); }
