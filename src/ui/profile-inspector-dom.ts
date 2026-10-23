export function inspectorButton(parent: HTMLElement, text: string, run: () => void): HTMLButtonElement {
  const button = parent.createEl("button", { text, attr: { type: "button" } });
  button.addEventListener("click", run);
  return button;
}

/** Renderer-owned text/attributes update in place; user disclosure and focus state survive. */
export function updateInspectorContent(target: HTMLElement, source: HTMLElement): void {
  const current = Array.from(target.childNodes);
  const incoming = Array.from(source.childNodes);
  const element = target.ownerDocument.defaultView?.HTMLElement;
  const isElement = (node: Node): node is HTMLElement => element !== undefined && node instanceof element;
  incoming.forEach((next, index) => {
    const key = isElement(next) ? next.getAttribute("data-inspector-key") : null;
    const previous = key === null ? current[index] : current.find(node => isElement(node) && node.getAttribute("data-inspector-key") === key);
    if (previous === undefined) { target.insertBefore(next, target.childNodes[index] ?? null); return; }
    if (key !== null && target.childNodes[index] !== previous) target.insertBefore(previous, target.childNodes[index] ?? null);
    if (previous.nodeType !== next.nodeType || previous.nodeName !== next.nodeName) {
      previous.replaceWith(next);
      return;
    }
    if (previous.nodeType === 3) { if (previous.textContent !== next.textContent) previous.textContent = next.textContent; return; }
    if (element === undefined || !(previous instanceof element) || !(next instanceof element)) return;
    for (const attribute of Array.from(next.attributes)) if (attribute.name !== "open") previous.setAttribute(attribute.name, attribute.value);
    updateInspectorContent(previous, next);
  });
  const keys = new Set(incoming.filter(isElement).map(node => node.getAttribute("data-inspector-key")));
  for (const old of current) {
    const key = isElement(old) ? old.getAttribute("data-inspector-key") : null;
    if (key !== null ? !keys.has(key) : current.indexOf(old) >= incoming.length) old.remove();
  }
}

export function placeInspector(card: HTMLElement, container: HTMLElement, anchor?: HTMLElement): void {
  const bounds = container.getBoundingClientRect();
  const node = anchor?.getBoundingClientRect();
  const gutter = 12;
  const x = bounds.width <= 600 ? gutter : (node?.right ?? bounds.left) - bounds.left + gutter;
  const y = bounds.width <= 600 ? gutter : (node?.top ?? bounds.top) - bounds.top;
  card.style.left = `${Math.max(gutter, Math.min(x, bounds.width - card.offsetWidth - gutter))}px`;
  card.style.top = `${Math.max(gutter, Math.min(y, bounds.height - card.offsetHeight - gutter))}px`;
}
