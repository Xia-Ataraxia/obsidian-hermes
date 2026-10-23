import type { ActivityActor, ActivityEdge } from "../types/task-activity";
import type { TaskKey } from "../types/control-center";
import { canvasButton, canvasElement } from "./profiles-canvas-dom";

function actorLabel(actor: ActivityActor): string {
  switch (actor.kind) {
    case "current-profile": return actor.profile.profile;
    case "retired-profile": return `${actor.profile.profile} (이전 프로파일)`;
    case "system": case "generic": return `${actor.label} (${actor.kind})`;
    case "unknown": return "확인 불가";
    default: throw new TypeError(`Unexpected actor: ${String(actor)}`);
  }
}
export class ProfilesCanvasEdgeDetail {
  private root: HTMLElement | null = null;
  private anchor: HTMLElement | null = null;
  constructor(private readonly container: HTMLElement, private readonly openTask: (task: TaskKey) => void | Promise<void>, private readonly report: (error: Error) => void) {}
  show(edge: ActivityEdge, anchor: HTMLElement, scope: string, partial: boolean): void {
    this.close(false);
    this.anchor = anchor;
    const root = canvasElement(this.container, "section", "hpc-edge-detail");
    this.root = root;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "기록된 프로파일 연결");
    root.tabIndex = -1;
    canvasElement(root, "h3", "", `${edge.profiles[0].profile} — ${edge.profiles[1].profile}`);
    canvasButton(root, "닫기", () => this.close(), "hpc-close");
    canvasElement(root, "p", "hpc-muted", `${edge.distinctTaskCount}개 고유 작업 · ${edge.events.length}개 이벤트${partial ? " · 부분 기록" : ""}`);
    canvasElement(root, "p", "hpc-muted", scope);
    canvasElement(root, "p", "hpc-muted", "선은 기록된 협업 빈도입니다. 관리·지휘 관계를 뜻하지 않습니다.");
    canvasElement(root, "h4", "", "칸반에서 작업 열기");
    for (const task of edge.tasks.slice(0, 200)) canvasButton(root, `${task.board} / ${task.taskId}`, () => { void Promise.resolve(this.openTask(task)).catch(error => { if (!(error instanceof Error)) throw error; this.report(error); }); }, "hpc-task-link");
    if (edge.tasks.length > 200) canvasElement(root, "p", "hpc-muted", `처음 200개 작업 표시 · 총 ${edge.tasks.length}개`);
    canvasElement(root, "h4", "", "방향 · 유형 · 출처");
    const list = canvasElement(root, "ol", "hpc-event-list");
    for (const event of edge.events.slice(0, 200)) {
      const row = canvasElement(list, "li", "");
      canvasElement(row, "strong", "", `${actorLabel(event.from)} → ${actorLabel(event.to)} · ${event.type}`);
      canvasElement(row, "small", "", `${event.task.board} / ${event.task.taskId} · event ${event.event.eventId} · ${new Date(event.occurredAt).toISOString()}`);
    }
    if (edge.events.length > 200) canvasElement(root, "p", "hpc-muted", `처음 200개 이벤트 표시 · 총 ${edge.events.length}개`);
    root.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.close(); } });
    root.focus({ preventScroll: true });
  }
  close(focus = true): void {
    this.root?.remove(); this.root = null;
    if (focus && this.anchor?.isConnected) this.anchor.focus({ preventScroll: true });
    this.anchor = null;
  }
  dispose(): void { this.close(false); }
}
