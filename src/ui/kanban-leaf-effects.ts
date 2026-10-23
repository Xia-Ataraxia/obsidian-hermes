export function createLeafEffects(root: HTMLElement) {
  const owner = root.ownerDocument;
  const view = owner.defaultView;
  if (!view) throw new Error("Kanban leaf has no window");
  const timers = new Set<number>();
  const frames = new Set<number>();
  const urls = new Set<string>();
  const listeners = new Map<EventListenerOrEventListenerObject, { readonly target: EventTarget; readonly type: string; readonly wrapped: EventListener; readonly options?: boolean | AddEventListenerOptions }[]>();
  let disposed = false;
  function events(target: EventTarget) {
    return {
      addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
        if (!listener || disposed) return;
        const wrapped = (event: Event) => {
          if (type === "keydown" && !(event.target instanceof Node && root.contains(event.target))) return;
          if (typeof listener === "function") listener(event); else listener.handleEvent(event);
        };
        const entries = listeners.get(listener) ?? [];
        entries.push({ target, type, wrapped, ...(options === undefined ? {} : { options }) });
        listeners.set(listener, entries);
        target.addEventListener(type, wrapped, options);
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
        if (!listener) return;
        const entries = listeners.get(listener) ?? [];
        for (const entry of entries.filter(entry => entry.target === target && entry.type === type)) target.removeEventListener(type, entry.wrapped, entry.options);
        const remaining = entries.filter(entry => entry.target !== target || entry.type !== type);
        if (remaining.length) listeners.set(listener, remaining); else listeners.delete(listener);
      },
    };
  }
  const storage = new Map<string, string>();
  const localStorage: Storage = { get length() { return storage.size; }, clear: () => storage.clear(), getItem: key => storage.get(key) ?? null, key: index => [...storage.keys()][index] ?? null, removeItem: key => { storage.delete(key); }, setItem: (key, value) => { storage.set(key, value); } };
  class LeafURL extends URL {
    static override createObjectURL(blob: Blob) { if (disposed) throw new Error("Kanban leaf disposed"); const url = URL.createObjectURL(blob); urls.add(url); return url; }
    static override revokeObjectURL(url: string) { if (urls.delete(url)) URL.revokeObjectURL(url); }
  }
  return {
    window: { ...events(view), localStorage, prompt: () => { throw new Error("Synchronous prompt refused"); }, confirm: () => false, alert: () => undefined },
    document: {
      ...events(owner), body: root, createElement: owner.createElement.bind(owner),
      querySelector: root.querySelector.bind(root), querySelectorAll: root.querySelectorAll.bind(root),
      elementFromPoint: (x: number, y: number) => { const element = owner.elementFromPoint(x, y); return element && root.contains(element) ? element : null; },
    },
    URL: LeafURL,
    setTimeout(callback: () => void, delay = 0) { if (disposed) return 0; const id = view.setTimeout(() => { timers.delete(id); if (!disposed) callback(); }, delay); timers.add(id); return id; },
    clearTimeout(id: number) { timers.delete(id); view.clearTimeout(id); },
    requestAnimationFrame(callback: FrameRequestCallback) { if (disposed) return 0; const id = view.requestAnimationFrame(time => { frames.delete(id); if (!disposed) callback(time); }); frames.add(id); return id; },
    diagnostics: () => ({ disposed, timers: timers.size, frames: frames.size, objectUrls: urls.size, listeners: [...listeners.values()].reduce((sum, entries) => sum + entries.length, 0) }),
    dispose() {
      disposed = true;
      for (const id of timers) view.clearTimeout(id);
      for (const id of frames) view.cancelAnimationFrame(id);
      for (const url of urls) URL.revokeObjectURL(url);
      for (const entries of listeners.values()) for (const entry of entries) entry.target.removeEventListener(entry.type, entry.wrapped, entry.options);
      timers.clear(); frames.clear(); urls.clear(); listeners.clear(); storage.clear();
      root.querySelectorAll(".hermes-kanban-touch-proxy, .hermes-kanban-drag-ghost").forEach(element => element.remove());
    },
  };
}
