import { matchesCronOwner } from "../domain/cron-execution-definition";
import { buildOutputFileIndex } from "../domain/output-file-index";
import { buildListOutputFiles, buildReadOutputFile } from "../domain/read-command-builder";
import { splitNulRecords } from "../domain/response-bound";
import type { CronJobRecord, OutputFileIndex, ProfileRef } from "../types/hermes-cron";
import type { LedgerReadResult } from "../types/snapshot";
import { readExecutionHistory } from "./execution-history-reader";
import { renderLedgerPanel, renderOutputPanel } from "./job-evidence-panels";
import { renderOverviewPanel } from "./job-detail-panels";
import { renderOutputReader } from "./output-reader-panel";
import { inspectorButton, updateInspectorContent } from "./profile-inspector-dom";
import type { SshReadOnlyAdapter } from "./ssh-read-only-adapter";
import { VerbatimMemoryStore } from "./verbatim-memory-store";

export class InspectorCronDetail {
  private readonly overview: HTMLElement;
  private readonly history: HTMLElement;
  private readonly output: HTMLElement;
  private readonly bodies = new VerbatimMemoryStore();
  private ledger: LedgerReadResult = { status: "ledger-unavailable", rows: [], windowLimited: false, detail: "Loading history" };
  private outputs: OutputFileIndex = { files: [], rejectedCount: 0 };
  private outputError: string | null = null;
  private file: string | null = null;
  private loading = true;
  private generation = 0;
  private outputGeneration = 0;
  private disposed = false;
  private job: CronJobRecord | null;
  constructor(private readonly root: HTMLElement, job: CronJobRecord, private readonly ref: ProfileRef, private readonly adapter: SshReadOnlyAdapter) {
    this.job = job;
    const tabs = root.createDiv({ cls: "hcv-inspector-tabs", attr: { "aria-label": "Cron evidence" } });
    this.overview = root.createDiv();
    this.history = root.createDiv();
    this.output = root.createDiv();
    const panes = [this.overview, this.history, this.output];
    const names = ["Definition", "History", "Output"];
    const buttons = names.map((name, index) => inspectorButton(tabs, name, () => {
      panes.forEach((pane, offset) => { pane.hidden = offset !== index; });
      buttons.forEach((button, offset) => button.setAttribute("aria-pressed", String(index === offset)));
    }));
    buttons[0]?.click();
    this.update(job);
    void this.refresh();
  }
  update(job: CronJobRecord): void {
    if (this.disposed || !matchesCronOwner(job, this.ref) || this.job?.id !== job.id) return;
    this.job = job;
    const content = this.root.ownerDocument.createElement("div");
    content.createEl("p", { text: `Storage owner: ${this.ref.profileId} · ${this.ref.alias} · job ${job.id}` });
    renderOverviewPanel(content, job);
    updateInspectorContent(this.overview, content);
  }
  async refresh(): Promise<void> {
    const job = this.job;
    if (this.disposed || job === null || !matchesCronOwner(job, this.ref)) return;
    const generation = ++this.generation;
    const [ledger, listing] = await Promise.all([
      readExecutionHistory(this.adapter, this.ref, { jobId: job.id, limit: 50 }), this.listOutputs(job.id),
    ]);
    if (this.disposed || generation !== this.generation) return;
    this.ledger = ledger;
    this.outputs = listing.index;
    this.outputError = listing.error;
    this.loading = false;
    this.renderHistory();
    if (this.file === null) this.renderOutput();
  }
  private async listOutputs(jobId: string): Promise<{ readonly index: OutputFileIndex; readonly error: string | null }> {
    const command = buildListOutputFiles(this.ref.home, jobId);
    if (!command.ok) return { index: { files: [], rejectedCount: 0 }, error: command.detail };
    const result = await this.adapter.run(this.ref.alias, command.command);
    if (result.transport !== "connected" || result.exitCode !== 0 || result.capExceeded) return { index: { files: [], rejectedCount: 0 }, error: "Output listing unavailable or incomplete." };
    return { index: buildOutputFileIndex(this.ref, jobId, `${this.ref.home}/cron/output/${jobId}`, splitNulRecords(result.stdout, false)), error: null };
  }
  private renderHistory(): void {
    const content = this.root.ownerDocument.createElement("div");
    if (this.loading) content.createEl("p", { text: "Loading history" });
    else renderLedgerPanel(content, this.ledger, this.ledger.windowLimited && this.ledger.rows.length < 500 ? () => void this.older() : null, null);
    content.querySelectorAll("li").forEach((row, index) => row.setAttribute("data-inspector-key", this.ledger.rows[index]?.id ?? String(index)));
    if (this.ledger.rows.length >= 500) content.createEl("p", { text: "Showing at most 500 rows in this visit." });
    updateInspectorContent(this.history, content);
  }
  private async older(): Promise<void> {
    const job = this.job;
    const last = this.ledger.rows.at(-1);
    if (job === null || last?.claimedAt === undefined || last.claimedAt === null) return;
    const generation = ++this.generation;
    const page = await readExecutionHistory(this.adapter, this.ref, { jobId: job.id, limit: 50, before: { claimedAt: last.claimedAt, id: last.id } });
    if (this.disposed || generation !== this.generation) return;
    if (page.status === "read") this.ledger = { ...page, rows: [...this.ledger.rows, ...page.rows].slice(0, 500) };
    else { renderLedgerPanel(this.history, page, null, null); return; }
    this.renderHistory();
  }
  private renderOutput(): void {
    const content = this.root.ownerDocument.createElement("div");
    content.createEl("p", { text: "Hermes stores no link between a ledger row and an output file; these are not paired." });
    if (this.loading) content.createEl("p", { text: "Loading output files" });
    else renderOutputPanel(content, this.outputs, name => void this.openOutput(name), this.outputError);
    content.querySelectorAll("li").forEach(row => row.setAttribute("data-inspector-key", row.textContent ?? ""));
    updateInspectorContent(this.output, content);
  }
  private async openOutput(name: string): Promise<void> {
    const job = this.job;
    if (job === null || !this.outputs.files.some(file => file.fileName === name)) return;
    const generation = ++this.outputGeneration;
    this.file = name;
    this.showFile(name, true, null);
    const command = buildReadOutputFile(this.ref.home, job.id, name);
    if (!command.ok) { this.showFile(name, false, command.detail); return; }
    const result = await this.adapter.run(this.ref.alias, command.command);
    if (this.disposed || generation !== this.outputGeneration) return;
    const accepted = result.transport === "connected" && result.exitCode === 0;
    if (accepted) this.bodies.set(name, result.stdout, result.capExceeded);
    this.showFile(name, false, accepted ? null : "Output read failed.");
  }
  private showFile(name: string, loading: boolean, error: string | null): void {
    this.output.empty();
    renderOutputReader(this.output, { fileName: name, loading, error, entry: this.bodies.get(name) }, {
      onBack: () => { ++this.outputGeneration; this.file = null; this.renderOutput(); }, onPrevious: null, onNext: null,
    });
  }
  dispose(): void {
    this.disposed = true;
    ++this.generation;
    ++this.outputGeneration;
    this.job = null;
    this.ledger = { status: "read", rows: [], detail: null, windowLimited: false };
    this.outputs = { files: [], rejectedCount: 0 };
    this.bodies.clear();
    this.root.empty();
  }
}
