/** Pure canvas math: snapping, tidying, edge curves and the initial layout. No DOM. */

export interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
/** A thin alignment line: `axis: "x"` is vertical at `at`; `marks` are where it meets the aligned rects' edges on y. */
export interface Guide { readonly axis: "x" | "y"; readonly at: number; readonly center: boolean; readonly marks: readonly number[] }
/** An equal-spacing span: `axis: "x"` runs along x from `from` to `to` at y `at`. */
export interface Gap { readonly axis: "x" | "y"; readonly from: number; readonly to: number; readonly at: number }
/** A gap between two rects that face each other; `a` and `b` index `others`, -1 is the moving rect. */
interface Pair extends Gap { readonly a: number; readonly b: number }

const lines = (start: number, size: number): number[] => [start, start + size / 2, start + size];

/** Area two rects share; 0 when they only touch. */
export const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** Every gap along `axis` between neighbors in the row (column) of rects that face `rect`, marked mid-way along the strip they share with `rect`. */
function pairs(rect: Rect, others: readonly Rect[], axis: "x" | "y"): Pair[] {
  const [pos, size, cross, span] = axis === "x" ? (["x", "w", "y", "h"] as const) : (["y", "h", "x", "w"] as const);
  const faces = (p: Rect, q: Rect): boolean => p[cross] < q[cross] + q[span] && q[cross] < p[cross] + p[span];
  const band = [[-1, rect] as const, ...others.flatMap((other, i) => faces(rect, other) ? [[i, other] as const] : [])];
  return band.flatMap(([a, p]) => {
    const next = band.filter(([, q]) => q[pos] >= p[pos] + p[size] && faces(p, q)).sort((m, n) => m[1][pos] - n[1][pos])[0];
    if (!next || next[1][pos] === p[pos] + p[size]) return [];
    const [b, q] = next;
    return [{ axis, from: p[pos] + p[size], to: q[pos], at: (Math.max(p[cross], q[cross], rect[cross]) + Math.min(p[cross] + p[span], q[cross] + q[span], rect[cross] + rect[span])) / 2, a, b }];
  });
}

/**
 * Slides-style snapping: the moving rect's left/center/right (top/middle/bottom) lock onto the
 * nearest matching line of any other rect, or onto equal spacing (centered between its neighbors,
 * or matching a gap between two others), within `threshold`. Every line that now coincides becomes
 * a guide across the rects that share it; every gap beside the moving rect that equals another gap
 * in its row or column comes back in `gaps`. `targets` are the rects involved, as indices in `others`.
 */
export function snap(moving: Rect, others: readonly Rect[], threshold: number): { x: number; y: number; guides: Guide[]; gaps: Gap[]; targets: number[] } {
  const offset = (rect: Rect, axis: "x" | "y"): number => {
    let best = Infinity;
    for (const other of others) {
      for (const target of axis === "x" ? lines(other.x, other.w) : lines(other.y, other.h)) {
        for (const own of axis === "x" ? lines(rect.x, rect.w) : lines(rect.y, rect.h)) {
          if (Math.abs(target - own) < Math.abs(best)) best = target - own;
        }
      }
    }
    // Moving by d widens the gaps before the rect by d and narrows the one after it by d.
    const found = pairs(rect, others, axis), span = (p: Pair): number => p.to - p.from;
    const before = found.filter(p => p.b === -1).map(span), after = found.filter(p => p.a === -1).map(span);
    const fixed = found.filter(p => p.a >= 0 && p.b >= 0).map(span);
    const candidates = [
      ...(before.length > 0 && after.length > 0 ? [(after[0]! - Math.min(...before)) / 2] : []),
      ...fixed.flatMap(gap => [...before.map(own => gap - own), ...after.map(own => own - gap)]),
    ];
    // No gap can close: the line snap that closes one is exactly that gap away, and a candidate must be strictly nearer.
    for (const d of candidates) if (Math.abs(d) < Math.abs(best)) best = d;
    return Math.abs(best) <= threshold ? best : 0;
  };
  // ponytail: y snaps first so x's equal gaps see the cards facing the snapped rect; y still uses the unsnapped x band, iterate if columns show the same jump.
  const shifted = { ...moving, y: moving.y + offset(moving, "y") };
  const placed = { ...shifted, x: shifted.x + offset(shifted, "x") };
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
  const gaps = new Set<Pair>();
  for (const axis of ["x", "y"] as const) {
    const found = pairs(placed, others, axis);
    for (const p of found) {
      if (p.a !== -1 && p.b !== -1) continue;
      for (const q of found) if (q !== p && Math.abs(q.to - q.from - (p.to - p.from)) < 0.5) { gaps.add(p); gaps.add(q); }
    }
  }
  for (const { a, b } of gaps) for (const i of [a, b]) if (i >= 0) targets.add(i);
  return { x: placed.x, y: placed.y, guides, gaps: [...gaps].map(({ axis, from, to, at }) => ({ axis, from, to, at })), targets: [...targets] };
}

const TIDY = 48; // under the shortest card (~190): stacked cards never share a row; ~24 screen px at fit zoom

/**
 * Straighten near rows and columns among `ids`: tops (then lefts) within `TIDY` of the first one in their
 * group take the median one's value. A move that would deepen an overlap with any card is skipped, with
 * the rest of that side of the row. Returns only the cards that move; tidying the result moves nothing.
 */
// ponytail: a card moves at most TIDY per pass, so up to 8 x TIDY in all: a later pass can merge rows an earlier one made (50/54/60 and 102/150 align to 54 and 102, then merge at 54: 96 px; 13 cards chain to 144). Anchor on each group's first card for a hard TIDY cap.
export function tidy(rects: ReadonlyMap<string, Rect>, ids: readonly string[]): Map<string, [number, number]> {
  const now = new Map(rects);
  const clear = (id: string, to: Rect): boolean => [...now].every(([other, r]) => other === id || overlap(to, r) <= overlap(now.get(id)!, r));
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const key of ["y", "x"] as const) {
      const sorted = ids.filter(id => now.has(id)).sort((a, b) => now.get(a)![key] - now.get(b)![key] || a.localeCompare(b));
      const clusters: string[][] = [];
      for (const id of sorted) {
        const last = clusters[clusters.length - 1];
        if (last && now.get(id)![key] - now.get(last[0]!)![key] <= TIDY) last.push(id); else clusters.push([id]);
      }
      for (const cluster of clusters) {
        const mid = Math.floor((cluster.length - 1) / 2), anchor = now.get(cluster[mid]!)![key];
        for (const side of [cluster.slice(0, mid).reverse(), cluster.slice(mid + 1)]) {
          for (const id of side) {
            const to = { ...now.get(id)!, [key]: anchor };
            if (!clear(id, to)) break;
            if (to[key] !== now.get(id)![key]) { now.set(id, to); changed = true; }
          }
        }
      }
    }
    if (!changed) break;
  }
  const out = new Map<string, [number, number]>();
  for (const [id, r] of now) {
    const was = rects.get(id)!;
    if (r.x !== was.x || r.y !== was.y) out.set(id, [r.x, r.y]);
  }
  return out;
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
