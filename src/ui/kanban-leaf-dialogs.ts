import { React, Button, Input } from "../vendor/hermes-kanban/primitives";
import type { ConfirmDialog } from "../vendor/hermes-kanban/primitives";

type Confirmation = React.ComponentProps<typeof ConfirmDialog>;
type Prompt = { readonly message: string; readonly initial: string; readonly resolve: (value: string | null) => void };

export type RegisterDialogEscape = (dialog: HTMLElement, cancel: () => void) => () => void;

function useDialogFocus(open: boolean, cancel: () => void, registerEscape?: RegisterDialogEscape) {
  const ref = React.useRef<HTMLElement | null>(null);
  const onEscape = React.useRef(cancel);
  onEscape.current = cancel;
  React.useEffect(() => {
    if (!open || !ref.current) return;
    const dialog = ref.current;
    const previous = dialog.ownerDocument.activeElement;
    const releaseEscape = registerEscape?.(dialog, () => onEscape.current());
    (dialog.querySelector<HTMLElement>('input:not(:disabled),button:not(:disabled),[tabindex="0"]') ?? dialog).focus();
    return () => { releaseEscape?.(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [open, registerEscape]);
  return ref;
}
function containFocus(event: React.KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled),[tabindex="0"]'));
  const first = controls[0], last = controls.at(-1);
  if (!first || event.target === event.currentTarget) {
    event.preventDefault();
    (event.shiftKey ? last ?? event.currentTarget : first ?? event.currentTarget).focus();
    return;
  }
  if (event.shiftKey && event.target === first) { event.preventDefault(); last?.focus(); }
  if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus(); }
}

function keepBackdropFocus(event: React.MouseEvent) {
  if (event.target === event.currentTarget) event.preventDefault();
}

export function createLeafDialogs(registerEscape?: RegisterDialogEscape) {
  let active: Prompt | null = null;
  let update: (() => void) | undefined;
  const settle = (value: string | null) => { const previous = active; active = null; update?.(); previous?.resolve(value); };
  function Confirm(props: Confirmation) {
    const ref = useDialogFocus(props.open, props.onCancel, registerEscape);
    if (!props.open) return React.createElement(React.Fragment);
    return React.createElement("div", { className: "hermes-kanban-dialog-backdrop", onMouseDown: keepBackdropFocus, onKeyDown: (event: React.KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); props.onCancel(); } } },
      React.createElement("section", { ref, onKeyDown: containFocus, className: "hermes-kanban-dialog", role: "alertdialog", "aria-modal": true, "aria-label": props.title, tabIndex: -1 },
        React.createElement("h2", { className: "hermes-kanban-dialog-title" }, props.title),
        React.createElement("p", null, props.description),
        React.createElement("div", { className: "hermes-kanban-dialog-actions" },
          React.createElement(Button, { onClick: props.onCancel, disabled: props.loading }, props.cancelLabel ?? "Cancel"),
          React.createElement(Button, { onClick: props.onConfirm, disabled: props.loading, destructive: props.destructive ?? false }, props.confirmLabel ?? "Confirm"))));
  }
  function Prompts() {
    const [, render] = React.useState(0);
    const [value, setValue] = React.useState("");
    const ref = useDialogFocus(active !== null, () => settle(null), registerEscape);
    React.useEffect(() => { update = () => { setValue(active?.initial ?? ""); render(number => number + 1); }; update(); return () => { update = undefined; }; }, []);
    if (!active) return null;
    return React.createElement("div", { className: "hermes-kanban-dialog-backdrop", onMouseDown: keepBackdropFocus },
      React.createElement("form", { ref, className: "hermes-kanban-dialog", role: "dialog", "aria-modal": true, "aria-label": active.message, tabIndex: -1,
        onSubmit: (event: React.FormEvent) => { event.preventDefault(); if (value.trim()) settle(value); },
        onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => { containFocus(event); if (event.key === "Escape") { event.stopPropagation(); settle(null); } } },
        React.createElement("label", null, active.message,
          React.createElement(Input, { value, onChange: (event: React.ChangeEvent<HTMLInputElement>) => setValue(event.target.value) })),
        React.createElement("div", { className: "hermes-kanban-dialog-actions" },
          React.createElement(Button, { type: "button", onClick: () => settle(null) }, "Cancel"),
          React.createElement(Button, { type: "submit", disabled: !value.trim() }, "Confirm"))));
  }
  return { Confirm, Prompts, prompt: (message: string, initial = "") => new Promise<string | null>(resolve => { settle(null); active = { message, initial, resolve }; update?.(); }), dispose: () => settle(null) };
}
