import type { ProfileKey } from "../types/control-center";
import type { CanvasPoint } from "../types/profiles-canvas";
import type { ProfilesCanvasLayout } from "./profiles-canvas-model";

type Drag = { readonly id: number; readonly node: HTMLElement; readonly profile: ProfileKey | null; readonly origin: CanvasPoint; readonly pointer: CanvasPoint; moved: boolean };
export class ProfilesCanvasGestures {
  private drag: Drag | null = null;
  private suppressClick = false;
  private readonly abort = new AbortController();
  constructor(private readonly stage: HTMLElement, private readonly layout: ProfilesCanvasLayout, private readonly profileFor: (element: Element) => ProfileKey | null, private readonly render: () => void, private readonly save: () => void) {
    const options = { signal: this.abort.signal };
    stage.addEventListener("pointerdown", event => this.down(event), options);
    stage.addEventListener("pointermove", event => this.move(event), options);
    stage.addEventListener("pointerup", event => this.up(event), options);
    stage.addEventListener("pointercancel", event => this.up(event), options);
    stage.addEventListener("lostpointercapture", event => this.up(event), options);
    stage.addEventListener("click", event => { if (this.suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); this.suppressClick = false; } }, { ...options, capture: true });
    stage.addEventListener("wheel", event => {
      if (this.excluded(event.target)) return;
      event.preventDefault();
      const box = stage.getBoundingClientRect();
      layout.zoom(Math.exp(-event.deltaY * .001), { x: event.clientX - box.left, y: event.clientY - box.top });
      render(); save();
    }, { ...options, passive: false });
  }
  private excluded(target: EventTarget | null): boolean { return target instanceof Element && target.closest(".hpc-overlay,.hpc-tools,.hpc-edge-label") !== null; }
  private down(event: PointerEvent): void {
    if (event.button !== 0 || this.drag || this.excluded(event.target) || !(event.target instanceof Element)) return;
    const profile = this.profileFor(event.target);
    const node = event.target.closest<HTMLElement>(".hpc-node") ?? this.stage;
    this.suppressClick = false;
    this.drag = { id: event.pointerId, node, profile, origin: profile ? this.layout.point(profile) : this.layout.viewport, pointer: { x: event.clientX, y: event.clientY }, moved: false };
    node.setPointerCapture(event.pointerId);
    if (profile) node.focus({ preventScroll: true });
  }
  private move(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.pointer.x, dy = event.clientY - drag.pointer.y;
    if (Math.hypot(dx, dy) > 3) drag.moved = true;
    if (!drag.moved) return;
    event.preventDefault();
    const divisor = drag.profile ? this.layout.viewport.zoom : 1;
    const point = { x: drag.origin.x + dx / divisor, y: drag.origin.y + dy / divisor };
    if (drag.profile) this.layout.move(drag.profile, point); else this.layout.pan(point);
    this.render();
  }
  private up(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId) return;
    this.drag = null;
    this.suppressClick = drag.moved;
    if (drag.node.hasPointerCapture(event.pointerId)) drag.node.releasePointerCapture(event.pointerId);
    if (drag.moved) this.save();
  }
  get activeProfile(): ProfileKey | null { return this.drag?.profile ?? null; }
  dispose(): void {
    this.abort.abort();
    const drag = this.drag;
    this.drag = null;
    if (drag?.node.hasPointerCapture(drag.id)) drag.node.releasePointerCapture(drag.id);
  }
}
