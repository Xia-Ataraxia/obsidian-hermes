/** Pure canvas math: snapping, edge curves and the initial layout. No DOM. */

export interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
/** A thin alignment line: `axis: "x"` is vertical at `at`; `marks` are where it meets the aligned rects' edges on y. */
export interface Guide { readonly axis: "x" | "y"; readonly at: number; readonly center: boolean; readonly marks: readonly number[] }

const lines = (start: number, size: number): number[] => [start, start + size / 2, start + size];

/**
 * Slides-style snapping: the moving rect's left/center/right (top/middle/bottom) lock onto the
 * nearest matching line of any other rect within `threshold`, then every line that now coincides
 * becomes a guide across the rects that share it. `targets` are their indices in `others`.
 */
export function snap(moving: Rect, others: readonly Rect[], threshold: number): { x: number; y: number; guides: Guide[]; targets: number[] } {
  const offset = (axis: "x" | "y"): number => {
    let best = Infinity;
    for (const other of others) {
      for (const target of axis === "x" ? lines(other.x, other.w) : lines(other.y, other.h)) {
        for (const own of axis === "x" ? lines(moving.x, moving.w) : lines(moving.y, moving.h)) {
          if (Math.abs(target - own) < Math.abs(best)) best = target - own;
        }
      }
    }
    return Math.abs(best) <= threshold ? best : 0;
  };
  const placed = { ...moving, x: moving.x + offset("x"), y: moving.y + offset("y") };
  const guides: Guide[] = [];
  const targets = new Set<number>();
  for (const axis of ["x", "y"] as const) {
    const cross = axis === "x" ? "y" : "x";
    const crossSize = axis === "x" ? "h" : "w";
    for (const [index, at] of (axis === "x" ? lines(placed.x, placed.w) : lines(placed.y, placed.h)).entries()) {
      const sharing = others.flatMap((other, i) => (axis === "x" ? lines(other.x, other.w) : lines(other.y, other.h)).some(line => Math.abs(line - at) < 0.5) ? [i] : []);
      if (sharing.length === 0) continue;
      for (const i of sharing) targets.add(i);
      guides.push({ axis, at, center: index === 1, marks: [placed, ...sharing.map(i => others[i]!)].flatMap(r => [r[cross], r[cross] + r[crossSize]]) });
    }
  }
  return { x: placed.x, y: placed.y, guides, targets: [...targets] };
}

/** Where the ray from the rect center towards (tx, ty) leaves the rect. */
function exit(rect: Rect, tx: number, ty: number): [number, number] {
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  const dx = tx - cx, dy = ty - cy;
  const scale = 1 / Math.max(Math.abs(dx) / (rect.w / 2), Math.abs(dy) / (rect.h / 2), 1e-9);
  return [cx + dx * scale, cy + dy * scale];
}

export interface Curve { readonly d: string; readonly mid: readonly [number, number]; readonly start: readonly [number, number]; readonly end: readonly [number, number]; readonly bow: number }

/**
 * A gently bowed quadratic from border to border (cards sit above edges and hide the round caps).
 * It takes `prefer` (the caller's last bow) while that stays clear of `obstacles`, else the gentlest
 * clear bow (alternating sides), so it never runs under a card and does not flip sides mid-drag.
 */
// ponytail: sampled bow search, not a router; dense layouts fall back to the least-blocked bow.
export function curve(a: Rect, b: Rect, obstacles: readonly Rect[] = [], prefer = 1): Curve {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
  const length = Math.hypot(bx - ax, by - ay) || 1;
  const nx = (ay - by) / length, ny = (bx - ax) / length;
  const base = Math.min(60, length * 0.14);
  let best: Curve | null = null, fewest = Infinity;
  for (const factor of [prefer, 1, -1, 2, -2, 3.5, -3.5, 5, -5, 7, -7]) {
    const control = [(ax + bx) / 2 + nx * base * factor, (ay + by) / 2 + ny * base * factor] as const;
    const start = exit(a, control[0], control[1]), end = exit(b, control[0], control[1]);
    const at = (t: number): [number, number] => [0, 1].map(i => (1 - t) ** 2 * start[i]! + 2 * (1 - t) * t * control[i]! + t ** 2 * end[i]!) as [number, number];
    let hits = 0;
    for (let i = 1; i < 25; i++) {
      const [x, y] = at(i / 25);
      if (obstacles.some(r => x > r.x - 12 && x < r.x + r.w + 12 && y > r.y - 12 && y < r.y + r.h + 12)) hits++;
    }
    if (hits < fewest) { fewest = hits; best = { d: `M${start[0]},${start[1]} Q${control[0]},${control[1]} ${end[0]},${end[1]}`, mid: at(0.5), start, end, bow: factor }; }
    if (hits === 0) break;
  }
  return best!;
}

/** Hub in the middle, everyone else on a ring around it, strongest partners first. */
export function ring(ids: readonly string[], weightOf: (id: string) => number, card: { w: number; h: number }): Map<string, [number, number]> {
  const sorted = [...ids].sort((a, b) => weightOf(b) - weightOf(a));
  const [hub, ...rest] = sorted;
  const out = new Map<string, [number, number]>();
  if (hub === undefined) return out;
  out.set(hub, [-card.w / 2, -card.h / 2]);
  const radius = Math.max(320, rest.length * 56);
  rest.forEach((id, index) => {
    const angle = -Math.PI / 2 + (index / rest.length) * Math.PI * 2;
    out.set(id, [Math.round(Math.cos(angle) * radius * 1.6 - card.w / 2), Math.round(Math.sin(angle) * radius - card.h / 2)]);
  });
  return out;
}

export const hues = new Map<string, number>();

/** Stable hue per name unless the user picked one in settings. */
export function hue(name: string): number {
  const picked = hues.get(name);
  if (picked !== undefined) return picked;
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (hash * 137.508) % 360;
}
