import { Notice, setTooltip } from "obsidian";
import type { LedgerReadResult } from "../types/snapshot";
import { SOURCE_LABEL } from "../ui/notices";
import type { CronJob } from "./data";
import { absolute, icon, relative, stat } from "./ui";
import { type Runs, duration, fail, instant, message, skeleton } from "./inspector-common";
import type { ProfileModal } from "./inspector";

export function renderCron(this: ProfileModal, el: HTMLElement): void {
  const jobs = [...this.profile.jobs].sort((a, b) => Number(b.enabled) - Number(a.enabled) || String(a.next ?? "~").localeCompare(String(b.next ?? "~")));
  if (!jobs.length) { el.createDiv({ cls: "hm-muted hm-pad", text: "No cron jobs" }); return; }
  for (const job of jobs) this.jobCard(el, job);
}

export function jobCard(this: ProfileModal, parent: HTMLElement, job: CronJob): void {
  const key = `job:${job.id}`;
  const on = this.state(key, job.enabled);
  const failed = !!job.error || (job.status !== null && !["ok", "success"].includes(job.status));
  const card: HTMLDetailsElement = this.fold(parent, key, `hm-job${on ? "" : " is-off"}${failed ? " is-failed" : ""}`, false, summary => {
    const top = summary.createDiv("hm-job-top");
    setTooltip(top.createSpan("hm-job-dot"), on ? `Last run: ${job.status ?? (failed ? "error" : "—")}` : "Paused");
    top.createDiv({ cls: "hm-job-name", text: job.name || job.id });
    setTooltip(top.createSpan({ cls: "hm-code", text: job.schedule }), "Schedule");
    this.toggle(top, on, job.state === "completed" ? "Completed one-shot job" : null, value => {
      this.overrides.set(key, value);
      card.toggleClass("is-off", !value);
      this.jobErrors.delete(job.id);
      const { alias, profileId } = this;
      void this.host.inspect.toggleJob(alias, profileId, job.id, value).catch(fail).then(outcome => {
        if (outcome.ok) { this.refresh(); return; }
        new Notice(outcome.message);
        if (!this.opened || alias !== this.alias || profileId !== this.profileId) return;
        this.overrides.delete(key);
        this.jobErrors.set(job.id, outcome.message);
        if (!this.editor) this.renderPane(true);
      });
    }, on ? undefined : "Schedules the next occurrence; a run missed while paused may fire once.");
    const meta = summary.createDiv("hm-job-meta");
    if (on && job.next) setTooltip(stat(meta, "timer", relative(job.next, this.now), "Next"), `Next · ${absolute(job.next)}`);
    if (job.last) setTooltip(stat(meta, "history", relative(job.last, this.now), "Last"), `Last · ${absolute(job.last)}`);
    if (job.deliver) stat(meta, "send", job.deliver, "Delivers to");
    if (job.skills.length) stat(meta, "sparkles", job.skills.join(", "), "Skills");
    const error = this.jobErrors.get(job.id) ?? job.error;
    if (error) summary.createDiv({ cls: "hm-error", text: error });
  }, body => this.runs(body, job));
}

/** The job's last runs from the execution ledger, cached a minute; the full history opens the job modal. */
export function renderRuns(this: ProfileModal, el: HTMLElement, job: CronJob): void {
  const list = el.createDiv("hm-runs");
  if (!this.detail) this.pending(list, 2);
  else {
    const { alias, profileId } = this;
    let entry = this.runCache.get(job.id);
    if (!entry || Date.now() - entry.at > 60_000) {
      const read = this.host.inspect.runs(alias, profileId, job.id)
        .catch((error: unknown): LedgerReadResult => ({ status: "ledger-unavailable", detail: message(error), rows: [], windowLimited: false }));
      const fresh: Runs = { at: Date.now(), read };
      void read.then(result => { fresh.value = result; });
      this.runCache.set(job.id, entry = fresh);
    }
    const draw = (result: LedgerReadResult): void => {
      if (result.status !== "read") { list.createDiv({ cls: "hm-muted", text: result.detail ?? SOURCE_LABEL[result.status] }); return; }
      if (!result.rows.length) { list.createDiv({ cls: "hm-muted", text: result.windowLimited ? "No runs in the recent window" : "No run history recorded" }); return; }
      for (const row of result.rows) {
        const line = list.createDiv(`hm-exec is-${row.status}`);
        line.createSpan("hm-exec-dot");
        const start = instant(row.startedAt ?? row.claimedAt), end = instant(row.finishedAt);
        const when = line.createSpan({ text: start === null ? row.startedAt ?? row.claimedAt ?? "—" : relative(start, this.now) });
        if (start !== null) setTooltip(when, absolute(start));
        if (start !== null && end !== null) line.createSpan({ cls: "hm-muted", text: duration(end - start) });
        const status = line.createSpan({ cls: "hm-push", text: row.statusRaw ?? row.status });
        if (row.error) setTooltip(status, row.error);
      }
    };
    if (entry.value) draw(entry.value);
    else {
      skeleton(list, 2);
      void entry.read.then(result => { if (list.isConnected) { list.empty(); draw(result); } });
    }
  }
  const button = el.createDiv("hm-job-foot").createEl("button");
  icon(button, "history");
  button.createSpan({ text: "Open full history" });
  button.addEventListener("click", () => {
    button.disabled = true;
    void this.host.inspect.job(this.alias, this.profileId, job.id).catch(message).then(found => {
      button.disabled = false;
      if (typeof found === "string") new Notice(found);
      else this.host.openJob(found.record, found.ref);
    });
  });
  if (job.prompt) {
    const prompt = el.createEl("details", { cls: "hm-prompt" });
    const summary = prompt.createEl("summary");
    icon(summary, "message-square");
    summary.createSpan({ text: job.prompt.split("\n")[0]!.slice(0, 90) });
    prompt.createEl("pre", { text: job.prompt });
  }
}
