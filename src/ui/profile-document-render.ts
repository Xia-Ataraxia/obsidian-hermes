import { iconButton } from "./icon-action";
import type { ProfileRef } from "../types/hermes-cron";
import type { ProfileDocumentName } from "../types/profile-document";

export type DocumentEditorView = {
  readonly profile: ProfileRef;
  readonly name: ProfileDocumentName;
  readonly phase: "loading" | "ready" | "failed";
  readonly message: string | null;
  readonly conflict: boolean;
  readonly resolvedPath: string;
  readonly buffer: string;
  readonly busy: boolean;
  readonly savable: boolean;
  readonly stateLabel: string;
};
export type DocumentEditorActions = {
  readonly reload: () => void;
  readonly retry: () => void;
  readonly save: () => void;
  readonly close: () => void;
  readonly input: (value: string) => void;
};

export function updateDocumentActions(root: HTMLElement, savable: boolean, stateLabel: string): void {
  const save = root.querySelector<HTMLButtonElement>(".hcv-doc-save");
  if (save !== null) save.disabled = !savable;
  const flag = root.querySelector<HTMLElement>(".hcv-doc-dirty");
  if (flag !== null) flag.textContent = stateLabel;
}

export function renderDocumentEditor(root: HTMLElement, view: DocumentEditorView, actions: DocumentEditorActions): void {
  root.empty();
  root.addClass("hcv-doc");
  const header = root.createDiv({ cls: "hcv-doc-header" });
  const heading = header.createDiv({ cls: "hcv-doc-heading" });
  heading.createEl("h2", { cls: "hcv-doc-title", text: view.name });
  heading.createSpan({ cls: "hcv-doc-subject", text: `${view.profile.alias} / ${view.profile.profileId} - ${view.profile.home}` });
  if (view.resolvedPath !== "") heading.createSpan({ cls: "hcv-doc-subject hcv-doc-path", text: view.resolvedPath, attr: { title: view.resolvedPath } });
  iconButton(header, "refresh-cw", `Reload ${view.name} from the server`, actions.reload);
  const status = root.createEl("p", { cls: view.conflict || view.phase === "failed" ? "hcv-doc-error" : "hcv-doc-status", text: view.message ?? "", attr: { "data-document-message": "true", role: "status" } });
  status.hidden = view.message === null;
  if (view.phase === "loading") {
    status.hidden = false;
    status.textContent = `Loading ${view.name}...`;
    return;
  }
  if (view.phase === "failed") {
    const bar = root.createDiv({ cls: "hcv-doc-actions" });
    iconButton(bar, "rotate-ccw", "Try reading the document again", actions.retry);
    iconButton(bar, "x", "Close", actions.close);
    return;
  }
  const editor = root.createEl("textarea", { cls: "hcv-doc-editor", attr: { "aria-label": `${view.name} contents`, spellcheck: "false" } });
  editor.value = view.buffer;
  editor.disabled = view.busy;
  editor.addEventListener("input", () => actions.input(editor.value));
  const bar = root.createDiv({ cls: "hcv-doc-actions" });
  bar.createSpan({ cls: "hcv-doc-dirty", text: view.stateLabel });
  const save = iconButton(bar, "save", `Save ${view.name}`, actions.save);
  save.addClass("hcv-doc-save");
  save.disabled = !view.savable;
  iconButton(bar, "x", "Cancel and close", actions.close);
}
