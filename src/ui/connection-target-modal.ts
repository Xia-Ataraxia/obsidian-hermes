import { ButtonComponent, Modal, Setting, type App } from "obsidian";
import type { TargetChangeResult } from "../types/contracts";

/** User-facing reason per rejected target, so the message names the exact problem. */
export function describeTargetFailure(reason: Exclude<TargetChangeResult, { ok: true }>["reason"]): string {
  if (reason === "invalid") return "Use 1-64 characters: letters, digits, dot, underscore or hyphen.";
  if (reason === "duplicate") return "That SSH target is already registered.";
  if (reason === "cancelled") return "Target change cancelled. Your open edits are still available.";
  return "This server is no longer registered. Close this dialog and reopen settings.";
}

/**
 * Edits the SSH target of one registered server.
 *
 * The target is the single value stored for a server: an alias from `~/.ssh/config` or a hostname
 * that `ssh` can resolve on its own. HostName, User, Port, ProxyJump and key material keep coming
 * from your SSH configuration and agent - this dialog never reads or writes `~/.ssh/config`.
 */
export class ConnectionTargetModal extends Modal {
  private buffer: string;
  private busy = false;
  private closed = false;
  private messageEl: HTMLElement | null = null;
  private controls: { setDisabled(disabled: boolean): unknown }[] = [];

  constructor(
    app: App,
    private readonly current: string,
    private readonly submit: (target: string) => Promise<TargetChangeResult>,
    private readonly onSaved?: () => void,
  ) {
    super(app);
    this.buffer = current;
  }

  override onOpen(): void {
    this.setTitle("Edit connection target");
    const root = this.contentEl;
    root.createEl("p", {
      cls: "hcv-settings-note",
      text: "An SSH alias from your SSH config, or a host name SSH can resolve. Host, user, port, jump host and keys still come from your SSH config and agent, which are never edited.",
    });
    new Setting(root)
      .setName("SSH target")
      .addText((text) => {
        text.setValue(this.buffer).onChange((value) => {
          this.buffer = value;
        });
        text.inputEl.spellcheck = false;
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.isComposing) void this.save();
        });
        this.controls.push(text);
        window.setTimeout(() => text.inputEl.select());
      });
    root.createEl("p", {
      cls: "hcv-settings-note",
      text: "A new target may be a different machine. Saving clears this server's profile selections, cached schedules and remembered remote home. Check the connection again to rediscover profiles.",
    });
    this.messageEl = root.createEl("p", { cls: "hcv-doc-status" });
    this.messageEl.hide();
    const actions = root.createDiv({ cls: "modal-button-container" });
    this.controls.push(new ButtonComponent(actions).setButtonText("Save").setCta().onClick(() => void this.save()));
    new ButtonComponent(actions).setButtonText("Cancel").onClick(() => this.close());
  }

  /** An in-flight save is never abandoned silently, and closing never reports success. */
  override close(): void {
    if (this.busy) {
      this.show("Saving. Wait until it finishes.", false);
      return;
    }
    super.close();
  }

  override onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }

  private show(message: string, failed: boolean): void {
    if (!this.messageEl) return;
    this.messageEl.setText(message);
    this.messageEl.toggleClass("hcv-setting-error", failed);
    this.messageEl.show();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    for (const control of this.controls) control.setDisabled(busy);
  }

  private async save(): Promise<void> {
    if (this.busy) return;
    const target = this.buffer.trim();
    if (target === "") {
      this.show("Enter an SSH target.", true);
      return;
    }
    if (target === this.current) {
      // Nothing to invalidate: leave every selection, cache and snapshot exactly as it is.
      super.close();
      return;
    }
    this.setBusy(true);
    this.show("Saving...", false);
    let result: TargetChangeResult;
    try {
      result = await this.submit(target);
    } catch {
      this.setBusy(false);
      this.show("Could not save the new target. Nothing was changed.", true);
      return;
    }
    if (this.closed) return;
    this.setBusy(false);
    if (!result.ok) {
      this.show(describeTargetFailure(result.reason), true);
      return;
    }
    this.onSaved?.();
    super.close();
  }
}
