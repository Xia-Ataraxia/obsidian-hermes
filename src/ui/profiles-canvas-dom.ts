export function canvasElement<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = parent.ownerDocument.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  parent.append(element);
  return element;
}
export function canvasButton(parent: HTMLElement, label: string, action: () => void, className = ""): HTMLButtonElement {
  const button = canvasElement(parent, "button", className, label);
  button.type = "button";
  button.addEventListener("click", action);
  return button;
}
