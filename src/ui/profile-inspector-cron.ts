import type { CronJobRecord, ProfileRef } from "../types/hermes-cron";
import type { InspectorCron } from "../types/profile-inspector";
import { InspectorCronDetail } from "./profile-inspector-cron-detail";
import { inspectorButton } from "./profile-inspector-dom";
import type { SshReadOnlyAdapter } from "./ssh-read-only-adapter";

export class InspectorCronPane {
  private readonly status: HTMLElement;
  private readonly list: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private jobs: readonly CronJobRecord[] = [];
  private selected: string | null = null;
  private ref: ProfileRef | null = null;
  private current: InspectorCronDetail | null = null;
  constructor(root: HTMLElement, private readonly adapter: SshReadOnlyAdapter) {
    this.status = root.createEl("p", { attr: { role: "status" } });
    this.list = root.createDiv({ cls: "hcv-inspector-jobs" });
    this.detail = root.createDiv();
  }
  update(cron: InspectorCron, ref: ProfileRef | null): void {
    this.status.textContent = cron.status === "read" ? `${cron.jobs.length} stored jobs. ${cron.detail ?? ""}` : `Cron ${cron.status}: ${cron.detail ?? "unknown"}`;
    if (cron.status !== "read" || ref === null) return;
    if (this.ref !== null && this.ref.home !== ref.home) { this.current?.dispose(); this.current = null; this.selected = null; }
    this.ref = ref;
    this.jobs = cron.jobs;
    for (const [id, button] of this.buttons) if (!cron.jobs.some(job => job.id === id)) { button.remove(); this.buttons.delete(id); }
    for (const job of cron.jobs) {
      let button = this.buttons.get(job.id);
      if (button === undefined) {
        button = inspectorButton(this.list, job.name ?? job.id, () => this.select(job.id));
        this.buttons.set(job.id, button);
      }
      button.textContent = `${job.name ?? job.id} · ${job.schedule.display ?? job.schedule.kind}`;
      button.setAttribute("aria-pressed", String(this.selected === job.id));
    }
    const job = cron.jobs.find(row => row.id === this.selected);
    if (job !== undefined) { this.current?.update(job); void this.current?.refresh(); }
    else if (this.selected !== null) { this.current?.dispose(); this.current = null; this.selected = null; }
  }
  private select(id: string): void {
    const job = this.jobs.find(row => row.id === id);
    if (job === undefined || this.ref === null || id === this.selected) return;
    this.current?.dispose();
    this.detail.empty();
    this.selected = id;
    for (const [key, button] of this.buttons) button.setAttribute("aria-pressed", String(key === id));
    this.current = new InspectorCronDetail(this.detail, job, this.ref, this.adapter);
  }
  dispose(): void {
    this.current?.dispose();
    this.current = null;
    this.jobs = [];
    this.ref = null;
    this.buttons.clear();
  }
}
