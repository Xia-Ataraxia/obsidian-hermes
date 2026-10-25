import { overlap, snap } from "./geometry";
import type { ProfilesView } from "./profiles-view";

export function bindGestures(this: ProfilesView): void {
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
