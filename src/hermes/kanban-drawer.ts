import { Component, FuzzySuggestModal, Notice, Setting, setTooltip, type TFile } from "obsidian";
import { MAX_ATTACHMENT, type Attachment, type Detail, type NotifyTarget, type TaskRow, type Verb } from "./kanban";
import { renderSafe } from "./markdown";
import { absolute, avatar, compact, icon, iconButton } from "./ui";
import { COLUMNS, CONFIRM, action, copy, deleteText, elapsed, mask, matches, message, when } from "./kanban-common";
import { type Focus, ask, askBlock, askComplete, askReassign, confirmed } from "./kanban-ask";
import { type TaskHost, diagCard, modelPicker } from "./kanban-create";
export * from "./kanban-common";
export * from "./kanban-ask";
export * from "./kanban-create";

/** Section names folded by the user, kept for the session. Home channels cost an SSH read, so they load on first unfold. */
const folded = new Set(["Events", "Worker log", "Notify home channels"]);

export class TaskDrawer {
  readonly el: HTMLElement;
  private readonly head: HTMLElement;
  private readonly pane: HTMLElement;
  private readonly composer: HTMLTextAreaElement;
  private detail: Detail | null = null;
  private part: Component | null = null;
  private seq = 0;
  /** A specify or decompose LLM call is in flight. */
  private busy = false;
  private focus: Focus | undefined;
  /** Home channels and subscriptions, read once per drawer and again after each toggle. */
  private homes: Promise<{ homes: NotifyTarget[]; subs: NotifyTarget[] } | string> | undefined;

  constructor(readonly host: TaskHost, parent: HTMLElement, readonly id: string, focus?: Focus) {
    this.focus = focus;
    this.el = parent.createDiv("hm-drawer hm-k-drawer");
    this.head = this.el.createDiv("hm-drawer-head hm-k-head");
    this.pane = this.el.createDiv("hm-pane");
    const foot = this.el.createDiv("hm-k-composer");
    this.composer = foot.createEl("textarea", { attr: { rows: 2, placeholder: "Add a comment… (enter to submit)" } });
    setTooltip(icon(foot, "info"), "Comments reach the worker on its next run or kanban_show() — no need to block the task first.");
    this.composer.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      const text = this.composer.value.trim();
      if (!text || this.composer.disabled) return;
      this.composer.disabled = true;
      void this.host.write({ verb: "comment", id: this.id, text }).then(error => {
        this.composer.disabled = false;
        if (error !== null) { new Notice(error, 10_000); return; }
        this.composer.value = "";
        this.composer.focus();
      });
    });
    this.renderHead();
    this.pane.createDiv({ cls: "hm-muted hm-pad", text: "Loading…" });
    this.el.win.requestAnimationFrame(() => this.el.addClass("is-open"));
    void this.refresh();
  }

  /** Re-read the task. A quiet refresh skips while the user edits inside the drawer. */
  async refresh(quiet = false): Promise<void> {
    // ponytail: a skipped refresh waits for the next board change or write
    if (quiet && this.editing()) return;
    const seq = ++this.seq;
    const detail = await this.host.kanban.detail(this.host.alias, this.host.slug, this.id).catch(message);
    if (seq !== this.seq) return;
    if (typeof detail !== "string") return this.render(detail);
    if (!this.detail) { this.pane.empty(); this.pane.createDiv({ cls: "hm-error hm-pad", text: detail }); }
    else if (!quiet) new Notice(detail, 10_000);
  }

  show(focus?: Focus): void {
    this.focus = focus;
    if (this.detail) this.applyFocus();
  }

  close(): void {
    this.seq++;
    if (this.part) this.host.owner.removeChild(this.part);
    this.part = null;
    this.el.removeClass("is-open");
    this.el.win.setTimeout(() => this.el.remove(), 200);
  }

  private editing(): boolean {
    const active = this.el.doc.activeElement;
    return !!this.el.querySelector(".hm-k-edit") || (!!active && active !== this.composer && this.el.contains(active) && active.matches("input, textarea, select"));
  }

  private applyFocus(): void {
    const focus = this.focus;
    this.focus = undefined;
    if (focus === "comment") this.composer.focus();
    const box = focus === "diagnostics" ? this.pane.querySelector<HTMLDetailsElement>(".hm-k-diags") : null;
    if (box) { box.open = true; box.scrollIntoView({ block: "start" }); }
  }

  private async write(v: Verb, undo?: () => void): Promise<void> {
    const error = await this.host.write(v);
    if (error === null) return;
    new Notice(error, 10_000);
    undo?.();
  }

  private section(key: string, label = key): { details: HTMLDetailsElement; head: HTMLElement; body: HTMLElement } {
    const details = this.pane.createEl("details", { cls: "hm-k-section" });
    details.open = !folded.has(key);
    details.addEventListener("toggle", () => { if (details.open) folded.delete(key); else folded.add(key); });
    const head = details.createEl("summary");
    head.createSpan({ cls: "hm-k-section-name", text: label });
    return { details, head, body: details.createDiv("hm-k-section-body") };
  }

  /** One toggle per home channel and per other subscription; a failed toggle repaints the last read. */
  private drawHomes(box: HTMLElement): void {
    if (!box.childElementCount) box.createDiv({ cls: "hm-muted", text: "Loading…" });
    const read = this.homes ??= this.host.kanban.homes(this.host.alias, this.host.slug, this.id).catch(message);
    void read.then(r => {
      if (!box.isConnected || read !== this.homes) return;
      box.empty();
      if (typeof r === "string") { box.createDiv({ cls: "hm-error", text: r }); return; }
      const key = (t: NotifyTarget): string => `${t.platform}\n${t.chat}\n${t.thread}`;
      const subbed = new Set(r.subs.map(key)), homes = new Set(r.homes.map(key));
      for (const t of [...r.homes, ...r.subs.filter(s => !homes.has(key(s)))]) {
        const on = subbed.has(key(t)), target = [t.name, mask(t.chat), t.thread && `thread ${mask(t.thread)}`].filter(Boolean).join(" · ");
        new Setting(box).setName(t.platform).setDesc(target).addToggle(toggle => toggle.setValue(on)
          .setTooltip(on ? `Sending updates to ${target}. Click to stop.` : `Send completed, blocked and gave-up notifications to ${target}.`)
          .onChange(value => {
            toggle.setDisabled(true);
            void this.host.write({ verb: value ? "notify-subscribe" : "notify-unsubscribe", id: this.id, platform: t.platform, chat: t.chat, ...(t.thread ? { thread: t.thread } : {}) }).then(error => {
              if (error === null) this.homes = undefined; else new Notice(error, 10_000);
              this.drawHomes(box);
            });
          }));
      }
      if (!r.homes.length) box.createDiv({ cls: "hm-muted", text: "Set a home channel in Hermes" });
    });
  }

  /** Attach a file of `size` bytes; the cap is checked before the bytes are read. */
  private async upload(name: string, size: number, read: () => Promise<ArrayBuffer>, type = ""): Promise<void> {
    if (size > MAX_ATTACHMENT) { new Notice(`${name} is larger than 25 MiB`, 10_000); return; }
    const notice = new Notice(`Uploading ${name}…`, 0);
    try {
      await this.write({ verb: "attach", id: this.id, name, ...(type ? { type } : {}), bytes: new Uint8Array(await read()) });
    } catch (e) {
      new Notice(message(e), 10_000);
    } finally {
      notice.hide();
    }
  }

  /** Hermes guesses a vault file's content type from its name. */
  private attachVault(): void {
    const app = this.host.app, pick = (file: TFile): void => void this.upload(file.name, file.stat.size, () => app.vault.readBinary(file));
    const modal = new (class extends FuzzySuggestModal<TFile> {
      getItems(): TFile[] { return app.vault.getFiles(); }
      getItemText(file: TFile): string { return file.path; }
      onChooseItem(file: TFile): void { pick(file); }
    })(app);
    modal.setPlaceholder("Attach a vault file…");
    modal.open();
  }

  private attachFile(): void {
    // Owned by the drawer's document: a popout's click activation can't open a chooser for the main window.
    const input = this.el.doc.adoptNode(createEl("input", { type: "file" }));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) void this.upload(file.name, file.size, () => file.arrayBuffer(), file.type);
    });
    input.click();
  }

  /** Save an attachment to the vault's attachment folder, then open it in a new tab. */
  private async download(a: Attachment, root: string | undefined): Promise<void> {
    const moved = this.host.moved();
    if (moved !== null) { new Notice(moved, 10_000); return; }
    const app = this.host.app, notice = new Notice(`Downloading ${a.name}…`, 0);
    try {
      const r = await this.host.kanban.download(this.host.alias, this.host.slug, this.id, a, root);
      if (!r.ok) { new Notice(r.message, 10_000); return; }
      // eslint-disable-next-line no-control-regex -- control characters never belong in a vault file name
      const name = a.name.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f\u007f]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "") || "attachment";
      const file = await app.vault.createBinary(await app.fileManager.getAvailablePathForAttachment(name), r.bytes.slice().buffer);
      await app.workspace.getLeaf("tab").openFile(file);
    } catch (e) {
      new Notice(message(e), 10_000);
    } finally {
      notice.hide();
    }
  }

  private render(detail: Detail): void {
    this.detail = detail;
    const t = detail.task, app = this.host.app, top = this.pane.scrollTop;
    if (this.part) this.host.owner.removeChild(this.part);
    const part = this.part = this.host.owner.addChild(new Component());
    const md = (parent: HTMLElement, text: string): void => { void renderSafe(app, text, parent.createDiv("hm-doc markdown-rendered"), part); };
    this.renderHead(t);
    this.pane.empty();

    const diags = this.host.diagnostics(this.id);
    if (diags.length) {
      const { details, body } = this.section("Diagnostics", `Diagnostics (${diags.length})`);
      details.addClass("hm-k-diags");
      for (const d of diags) diagCard(body, this.host, t, d);
    }

    this.meta(this.section("Details").body.createDiv("hm-k-meta"), t);

    const homes = this.section("Notify home channels");
    if (homes.details.open) this.drawHomes(homes.body);
    else homes.details.addEventListener("toggle", () => this.drawHomes(homes.body), { once: true });

    const desc = this.section("Description");
    const showBody = (body: string | undefined): void => {
      desc.body.empty();
      if (body) md(desc.body, body); else desc.body.createDiv({ cls: "hm-muted", text: "— no description —" });
    };
    showBody(t.body);
    iconButton(desc.head, "pencil", "Edit description", () => {
      if (desc.body.querySelector(".hm-k-edit")) return;
      desc.details.open = true;
      desc.body.empty();
      const area = desc.body.createEl("textarea", { cls: "hm-k-edit", attr: { rows: 10 } });
      area.value = t.body ?? "";
      const bar = desc.body.createDiv("hm-k-edit-bar");
      const save = bar.createEl("button", { cls: "mod-cta", text: "Save" });
      const cancel = (): void => showBody(t.body);
      const submit = (): void => {
        const body = area.value;
        if (body === (t.body ?? "")) return cancel();
        area.disabled = save.disabled = true;
        void this.host.write({ verb: "edit", id: this.id, body }).then(error => {
          area.disabled = save.disabled = false;
          if (error !== null) { new Notice(error, 10_000); return; }
          t.body = body;
          showBody(body);
        });
      };
      save.addEventListener("click", submit);
      bar.createEl("button", { text: "Cancel" }).addEventListener("click", cancel);
      area.addEventListener("keydown", event => {
        if (event.isComposing) return;
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); }
        else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
      });
      area.focus();
    }, "hm-push");

    const deps = this.section("Dependencies");
    iconButton(deps.head, "plus", "Add dependency", () => this.addDependency(), "hm-push");
    for (const [label, list, isParent] of [["Parents:", detail.parents, true], ["Children:", detail.children, false]] as const) {
      const line = deps.body.createDiv("hm-k-deps");
      line.createSpan({ cls: "hm-muted", text: label });
      if (!list.length) line.createSpan({ cls: "hm-muted", text: "none" });
      for (const r of list) {
        const chip = line.createSpan(`hm-k-dep is-${r.status}`);
        const open = chip.createEl("button", { cls: "hm-k-dep-open", text: r.id });
        setTooltip(open, `${r.title || "(untitled)"} · ${COLUMNS[r.status].label}`);
        open.addEventListener("click", () => this.host.open(r.id));
        iconButton(chip, "x", "Remove dependency", () => void this.write(isParent ? { verb: "unlink", id: r.id, child: this.id } : { verb: "unlink", id: this.id, child: r.id }));
      }
    }

    const summary = [...detail.runs].reverse().find(r => r.summary)?.summary;
    if (t.result) md(this.section("Result").body, t.result);
    else if (summary) md(this.section("Result", "Final Result (run summary)").body, summary);
    else if (t.status === "done") this.section("Result").body.createDiv({ cls: "hm-muted", text: detail.children.length ? "This card is an orchestrator / parent task. Review the child results section for the substantive work." : "No final result was recorded. Check Run History, Logs, or Child Tasks for details." });

    if (detail.children.length) {
      const box = this.section("Child results", `Child results (${detail.children.length})`).body;
      for (const c of detail.children) {
        const item = box.createDiv("hm-k-item");
        const line = item.createDiv("hm-k-line");
        line.createSpan({ cls: "hm-k-line-text", text: `${c.id} · ${c.title || "(untitled)"}` });
        line.createSpan({ cls: `hm-k-chip is-${c.status}`, text: COLUMNS[c.status].label });
        action(line, "Open", () => this.host.open(c.id));
        const text = c.result || c.summary;
        if (text) md(item, text); else item.createDiv({ cls: "hm-muted", text: "No result recorded yet." });
      }
    }

    const files = this.section("Attachments", `Attachments (${detail.attachments.length})`);
    iconButton(files.head, "file-plus", "Attach a vault file", () => this.attachVault(), "hm-push");
    iconButton(files.head, "upload", "Attach a file from this computer", () => this.attachFile());
    if (!detail.attachments.length) files.body.createDiv({ cls: "hm-muted", text: "— no attachments —" });
    for (const a of detail.attachments) {
      const line = files.body.createDiv("hm-k-line");
      setTooltip(icon(line, "paperclip"), a.type || "Attachment");
      line.createSpan({ cls: "hm-k-line-text", text: a.name });
      if (a.size) line.createSpan({ cls: "hm-muted", text: `${compact(a.size)}B` });
      when(line, a.at);
      iconButton(line, "download", "Save to vault", () => void this.download(a, detail.attachRoot));
      iconButton(line, "trash-2", "Remove attachment", () => void confirmed(app, "Remove attachment", "Remove this attachment?", "Delete", true).then(ok => {
        if (ok) void this.write({ verb: "attach-rm", id: this.id, attachment: a.id });
      }));
    }

    const comments = this.section("Comments", `Comments (${detail.comments.length})`).body;
    if (!detail.comments.length) comments.createDiv({ cls: "hm-muted", text: "— no comments —" });
    for (const c of detail.comments) {
      const item = comments.createDiv("hm-k-item");
      const line = item.createDiv("hm-k-line");
      line.createSpan({ cls: "hm-k-author", text: c.author || "anon" });
      when(line, c.at);
      md(item, c.body);
    }

    const events = this.section("Events", `Events (${detail.events.length} of ${detail.eventCount})`).body;
    for (const e of detail.events) {
      const line = events.createDiv("hm-k-event");
      line.createSpan({ cls: "hm-k-author", text: e.kind });
      when(line, e.at);
      if (e.payload !== undefined && e.payload !== null) line.createEl("code", { text: JSON.stringify(e.payload) });
    }

    const log = this.section("Worker log", detail.log ? `Worker log (${detail.log.size} B)` : "Worker log");
    iconButton(log.head, "refresh-cw", "Refresh log", () => void this.refresh(), "hm-push");
    if (!detail.log) log.body.createDiv({ cls: "hm-muted", text: "— no worker log yet (task hasn't spawned or log was rotated away) —" });
    else {
      if (detail.log.size > 100_000) log.body.createDiv({ cls: "hm-muted", text: "(showing last 100 KB)" });
      log.body.createEl("pre", { cls: "hm-k-log", text: detail.log.text || "(empty)" });
    }

    const runs = this.section("Run history", `Run history (${detail.runs.length})`).body;
    const drawRuns = (all: boolean): void => {
      runs.empty();
      if (!detail.runs.length) runs.createDiv({ cls: "hm-muted", text: "— no runs —" });
      for (const r of all ? detail.runs : detail.runs.slice(-3)) {
        const item = runs.createDiv("hm-k-item");
        const line = item.createDiv("hm-k-line");
        line.createSpan({ cls: "hm-k-chip", text: r.endedAt ? r.outcome || r.status || "ended" : "active" });
        line.createSpan({ text: r.profile ? `@${r.profile}` : "(no profile)" });
        if (r.startedAt) line.createSpan({ cls: "hm-muted", text: elapsed((r.endedAt ?? Date.now() / 1000) - r.startedAt) });
        when(line, r.startedAt);
        if (r.summary) item.createDiv({ cls: "hm-k-run-text", text: r.summary });
        if (r.error) item.createDiv({ cls: "hm-error", text: r.error });
        if (r.metadata !== undefined && r.metadata !== null) {
          const json = JSON.stringify(r.metadata, null, 2), box = item.createEl("details", { cls: "hm-k-json" });
          box.open = json.length <= 300;
          box.createEl("summary", { text: "Metadata" });
          box.createEl("pre", { text: json });
        }
      }
      if (!all && detail.runs.length > 3) action(runs, "Show all attempts", () => drawRuns(true));
    };
    drawRuns(false);

    this.pane.scrollTop = top;
    this.applyFocus();
  }

  private renderHead(t?: TaskRow): void {
    const head = this.head;
    head.empty();
    const top = head.createDiv("hm-k-head-top");
    if (t) setTooltip(icon(top, COLUMNS[t.status].icon, `hm-icon hm-k-status is-${t.status}`), COLUMNS[t.status].label);
    const id = top.createEl("button", { cls: "hm-k-id hm-code", text: this.id });
    setTooltip(id, "Copy id");
    id.addEventListener("click", () => copy(this.id));
    iconButton(top, "x", "Close (Esc)", () => this.host.close(), "hm-push");
    if (!t) return;
    const title = head.createDiv({ cls: "hm-drawer-name hm-k-title", text: t.title || "(untitled)" });
    setTooltip(title, "Click to edit");
    title.addEventListener("click", () => this.editTitle(title, t));
    const chips = head.createDiv("hm-k-chips");
    chips.createSpan({ cls: `hm-k-chip is-${t.status}`, text: COLUMNS[t.status].label });
    chips.createSpan({ cls: "hm-k-chip", text: `P${t.priority}` });
    if (t.tenant) chips.createSpan({ cls: "hm-k-chip", text: t.tenant });
    if (t.assignee) {
      const chip = chips.createSpan("hm-k-chip");
      avatar(chip, t.assignee, "hm-avatar is-small");
      chip.createSpan({ text: t.assignee });
    }
    this.actions(head.createDiv("hm-k-acts"), t);
  }

  private editTitle(title: HTMLElement, t: TaskRow): void {
    const input = createEl("input", { cls: "hm-k-edit hm-k-title", type: "text", value: t.title });
    title.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean): void => {
      if (done) return;
      done = true;
      const text = input.value.trim();
      input.replaceWith(title);
      if (!save || !text || text === t.title) return;
      title.setText(text);
      void this.write({ verb: "edit", id: this.id, title: text }, () => title.setText(t.title || "(untitled)"));
    };
    input.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); finish(true); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  }

  private actions(row: HTMLElement, t: TaskRow): void {
    const app = this.host.app, id = this.id, s = t.status;
    const add = (iconName: string, label: string, tip: string, run: () => void): void => { action(row, label, run, iconName, tip); };
    const sure = (title: string, text: string, cta: string, warning: boolean, v: Verb): void => {
      void confirmed(app, title, text, cta, warning).then(ok => { if (ok) void this.write(v); });
    };
    if (s === "triage") {
      add("sparkles", "Specify", "Let an LLM flesh out the spec", () => void this.slow("specify"));
      add("split", "Decompose", "Let an LLM split it into child tasks", () => void this.slow("decompose"));
    }
    if (s === "todo") add("circle-dot", "Ready", "Promote to ready", () => void this.write({ verb: "promote", id }));
    if (s === "scheduled") add("circle-dot", "Ready", "Unblock to ready", () => void this.write({ verb: "unblock", id }));
    if (s === "running") add("rotate-ccw", "Reclaim", "Stop the worker and return the task to ready", () => sure("Reclaim task", CONFIRM.reclaim, "Reclaim", true, { verb: "reclaim", id, reason: "reclaimed from Obsidian" }));
    if (s === "blocked") add("lock-open", "Unblock", "Move back to ready", () => void this.write({ verb: "unblock", id }));
    if (s === "review") add("undo-2", "Request changes", "Send back to ready with a reason", () => ask(app, {
      title: "Request changes", cta: "Send back",
      fields: [{ key: "reason", label: "What should change?", kind: "textarea", required: true, enter: true }],
      submit: v => this.host.write({ verb: "reopen-review", id, reason: v.reason ?? "" }),
    }));
    if (s === "ready" || s === "running") add("ban", "Block…", "Block with a reason", () => askBlock(app, [t], (kind, reason) => this.host.write({ verb: "block", id, kind, reason })));
    if (s === "ready" || s === "running" || s === "blocked" || s === "review") add("circle-check", "Complete…", "Mark as done", () => askComplete(app, 1, (summary, result) =>
      this.host.write({ verb: "complete", id, ...(summary ? { summary } : {}), ...(result ? { result } : {}), ...(s === "running" ? { force: true } : {}) })));
    if (s === "todo" || s === "ready" || s === "running" || s === "blocked") add("clock", "Schedule", "Park until a known time or follow-up", () => ask(app, {
      title: "Schedule task", cta: "Schedule",
      fields: [{ key: "reason", label: "Reason", kind: "textarea", enter: true, placeholder: "Optional" }],
      submit: v => this.host.write({ verb: "schedule", id, ...(v.reason ? { reason: v.reason } : {}) }),
    }));
    if (s === "ready") add("eye", "Request review", "Move to review", () => void this.write({ verb: "request-review", id }));
    if (s === "running") add("eye", "Request review", "Move to review", () => sure("Request review", "Move this task to review? Its worker may still be running.", "Move", false, { verb: "request-review", id, force: true }));
    if (s !== "archived") add("archive", "Archive", "Archive this task", () => sure("Archive task", CONFIRM.archive, "Archive", true, { verb: "archive", id }));
    add("trash-2", "Delete", "Delete this task permanently", () => void confirmed(app, "Delete task", deleteText(1, s === "running" ? 1 : 0), "Delete", true).then(async ok => {
      if (!ok) return;
      const error = await this.host.remove(id);
      // The task is gone from the board once the reload lands, so the drawer has nothing left to show.
      if (error === null) this.host.close(); else new Notice(error, 10_000);
    }));
  }

  /** Specify and decompose call an LLM on the host; they get the slow adapter and a sticky notice. */
  private async slow(v: "specify" | "decompose"): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const specify = v === "specify";
      if (!await confirmed(this.host.app, specify ? "Specify task" : "Decompose task", CONFIRM[v], specify ? "Specify" : "Decompose")) return;
      const notice = new Notice(`${specify ? "Specifying" : "Decomposing"} ${this.id}… (can take a minute)`, 0);
      const error = await this.host.write({ verb: v, id: this.id });
      notice.hide();
      if (error !== null) new Notice(error, 10_000);
    } finally {
      this.busy = false;
    }
  }

  private meta(grid: HTMLElement, t: TaskRow): void {
    const app = this.host.app;
    const key = (label: string): HTMLElement => { grid.createDiv({ cls: "hm-k-meta-key", text: label }); return grid.createDiv("hm-k-meta-value"); };
    const row = (label: string, value: string | number | undefined, tip = ""): void => {
      if (value === undefined || value === "") return;
      const el = key(label).createSpan({ text: String(value) });
      if (tip) setTooltip(el, tip);
    };
    const time = (label: string, at: number | undefined): void => { if (at) when(key(label), at, ""); };

    const who = key("Assignee").createEl("select", { cls: "dropdown" });
    for (const p of new Set(["", ...this.host.profiles(), t.assignee ?? ""])) who.createEl("option", { value: p, text: p || "unassigned" });
    who.value = t.assignee ?? "";
    who.addEventListener("change", () => {
      const profile = who.value || null, undo = (): void => { who.value = t.assignee ?? ""; };
      who.blur();
      if (t.status !== "running") { void this.write({ verb: "assign", id: this.id, profile }, undo); return; }
      askReassign(app, reclaim => this.host.write({ verb: "reassign", id: this.id, profile, reason: "reassigned from Obsidian", ...(reclaim ? { reclaim } : {}) }), { cancelled: undo });
    });

    const priority = key("Priority");
    priority.createSpan({ text: `P${t.priority}` });
    iconButton(priority, "pencil", "Set priority", () => ask(app, {
      title: "Set priority", cta: "Save",
      fields: [{ key: "priority", label: "Priority", kind: "number", value: String(t.priority) }],
      submit: v => /^-?\d+$/.test(v.priority ?? "") ? this.host.write({ verb: "edit", id: this.id, priority: Number(v.priority) }) : Promise.resolve("Priority must be a whole number"),
    }));

    const model = key("Model");
    model.createSpan({ text: t.model ? (t.provider ? `${t.provider}: ${t.model}` : t.model) : "profile default" });
    iconButton(model, "pencil", "Set model", () => {
      const models = modelPicker(this.host);
      ask(app, {
        title: "Set model", cta: "Save",
        fields: [
          { key: "model", label: "Model", value: t.model ?? "", placeholder: "empty = profile default", suggest: q => models(q, t.assignee || "default") },
          { key: "provider", label: "Provider", value: t.provider ?? "" },
        ],
        submit: v => v.provider && !v.model ? Promise.resolve("provider_override requires a model_override")
          : this.host.write({ verb: "set-model", id: this.id, model: v.model || null, ...(v.model && v.provider ? { provider: v.provider } : {}) }),
      });
    });

    row("Tenant", t.tenant);
    row("Workspace", t.workspaceKind && (t.workspacePath ? `${t.workspaceKind}: ${t.workspacePath}` : t.workspaceKind));
    row("Branch", t.branch);
    row("Skills", t.skills?.join(", "));
    row("Goal", t.goalMode ? `on (max ${t.goalMaxTurns ?? 20} turns)` : undefined);
    row("Max runtime", t.maxRuntime ? elapsed(t.maxRuntime) : undefined);
    row("Max retries", t.maxRetries);
    row("Failures", t.failures, t.lastError);
    row("Created by", t.createdBy);
    time("Created", t.createdAt);
    time("Started", t.startedAt);
    time("Completed", t.completedAt);
    time("Heartbeat", t.heartbeatAt);
    row("Claim", t.claimLock, t.claimExpires ? `Expires ${absolute(t.claimExpires)}` : "");
    row("PID", t.pid);
    row("Run", t.runId && `#${t.runId}`);
  }

  private addDependency(): void {
    const cards = this.host.cards().filter(c => c.id !== this.id);
    ask(this.host.app, {
      title: "Add dependency", cta: "Link",
      fields: [
        { key: "relation", label: "This task", kind: "dropdown", value: "child", options: [["child", "waits for (is a child of)"], ["parent", "is a parent of"]] },
        { key: "other", label: "Task", required: true, placeholder: "Task id or title", suggest: q => cards.filter(c => matches(q, c.id, c.title)).slice(0, 50).map(c => ({ value: c.id, label: c.title || "(untitled)", note: c.id })) },
      ],
      submit: v => {
        // An exact id wins, else the one card with that title; `cards` leaves this task out, so it never links to itself.
        const text = (v.other ?? "").trim(), named = cards.filter(c => c.title.trim().toLowerCase() === text.toLowerCase());
        const other = cards.find(c => c.id === text)?.id ?? (named.length === 1 ? named[0]?.id : undefined);
        if (!other) return Promise.resolve("Pick a task from the list");
        return this.host.write(v.relation === "parent" ? { verb: "link", id: this.id, child: other } : { verb: "link", id: other, child: this.id });
      },
    });
  }
}
