/** Pure canvas math: snapping, edge curves and the initial layout. No DOM. */

export interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
/** A thin alignment line: `axis: "x"` is vertical at `at`, spanning `from`..`to` on y. */
export interface Guide { readonly axis: "x" | "y"; readonly at: number; readonly from: number; readonly to: number }

const lines = (start: number, size: number): number[] => [start, start + size / 2, start + size];

/**
 * Slides-style snapping: the moving rect's left/center/right (top/middle/bottom) lock onto the
 * nearest matching line of any other rect within `threshold`, then every line that now coincides
 * becomes a guide spanning the rects that share it.
 */
export function snap(moving: Rect, others: readonly Rect[], threshold: number): { x: number; y: number; guides: Guide[] } {
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
  for (const axis of ["x", "y"] as const) {
    const cross = axis === "x" ? "y" : "x";
    const crossSize = axis === "x" ? "h" : "w";
    for (const at of axis === "x" ? lines(placed.x, placed.w) : lines(placed.y, placed.h)) {
      const sharing = others.filter(other => (axis === "x" ? lines(other.x, other.w) : lines(other.y, other.h)).some(line => Math.abs(line - at) < 0.5));
      if (sharing.length === 0) continue;
      const span = [placed, ...sharing];
      guides.push({ axis, at, from: Math.min(...span.map(r => r[cross])), to: Math.max(...span.map(r => r[cross] + r[crossSize])) });
    }
  }
  return { x: placed.x, y: placed.y, guides };
}

/** Where the ray from the rect center towards (tx, ty) leaves the rect, pushed out by `gap`. */
function exit(rect: Rect, tx: number, ty: number, gap: number): [number, number] {
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  const dx = tx - cx, dy = ty - cy;
  const scale = 1 / Math.max(Math.abs(dx) / (rect.w / 2 + gap), Math.abs(dy) / (rect.h / 2 + gap), 1e-9);
  return [cx + dx * scale, cy + dy * scale];
}

export interface Curve { readonly d: string; readonly head: string; readonly mid: readonly [number, number]; readonly start: readonly [number, number]; readonly end: readonly [number, number] }

/**
 * A gently bowed quadratic between two cards. The bow is always to the right of travel, so A→B
 * and B→A separate into two arcs instead of overlapping.
 */
export function curve(from: Rect, to: Rect, headSize: number): Curve {
  const fc = [from.x + from.w / 2, from.y + from.h / 2] as const;
  const tc = [to.x + to.w / 2, to.y + to.h / 2] as const;
  const start = exit(from, tc[0], tc[1], 6);
  const end = exit(to, fc[0], fc[1], 8 + headSize);
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const length = Math.hypot(dx, dy) || 1;
  const bow = Math.min(60, length * 0.14);
  const control = [(start[0] + end[0]) / 2 - (dy / length) * bow, (start[1] + end[1]) / 2 + (dx / length) * bow] as const;
  // Arrow tip sits `headSize` beyond the stroke end, along the end tangent.
  const tx = end[0] - control[0], ty = end[1] - control[1];
  const tl = Math.hypot(tx, ty) || 1;
  const ux = tx / tl, uy = ty / tl;
  const tip = [end[0] + ux * headSize, end[1] + uy * headSize];
  const wing = headSize * 0.62;
  const head = `${tip[0]},${tip[1]} ${end[0] - uy * wing},${end[1] + ux * wing} ${end[0] + uy * wing},${end[1] - ux * wing}`;
  const mid = [0.25 * start[0] + 0.5 * control[0] + 0.25 * end[0], 0.25 * start[1] + 0.5 * control[1] + 0.25 * end[1]] as const;
  return { d: `M${start[0]},${start[1]} Q${control[0]},${control[1]} ${end[0]},${end[1]}`, head, mid, start, end };
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
