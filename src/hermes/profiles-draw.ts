import { setTooltip } from "obsidian";
import type { Profile } from "./data";
import { curve, hue, type Gap, type Guide } from "./geometry";
import { avatar, compact, icon, iconButton, relative, stat } from "./ui";
import { EDGE_MODES, LOAD, color, plural, shortModel, svg } from "./profiles-common";
import type { ProfilesView } from "./profiles-view";

export function renderCard(this: ProfilesView, profile: Profile, now: number): HTMLElement {
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

export function sparkline(this: ProfilesView, parent: HTMLElement, values: readonly number[]): void {
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

export function drawEdges(this: ProfilesView): void {
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
export function drawGuides(this: ProfilesView, guides: readonly Guide[], targets: readonly string[] = [], gaps: readonly Gap[] = []): void {
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

export function drawLegend(this: ProfilesView): void {
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
