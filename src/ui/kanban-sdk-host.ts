import * as Native from "../vendor/hermes-kanban/primitives";
import { createNativeKanban } from "../vendor/hermes-kanban/factory";
import { createLeafDialogs, type RegisterDialogEscape } from "./kanban-leaf-dialogs";
import { createLeafEffects } from "./kanban-leaf-effects";
import { kanbanSdkTransport } from "./kanban-sdk-routes";
import type { KanbanHostServices } from "./kanban-host-services";

export function mountKanbanSdkHost(container: HTMLElement, services: KanbanHostServices, registerDialogEscape?: RegisterDialogEscape) {
  const root = container.ownerDocument.createElement("div");
  root.className = "hcv-kanban-root";
  root.style.cssText = "position:relative;isolation:isolate;contain:layout paint;transform:translateZ(0);height:100%;overflow:auto";
  const target = container.ownerDocument.createElement("div");
  target.className = "hcv-kanban-scroll-host";
  const style = container.ownerDocument.createElement("style");
  style.textContent = ".hcv-kanban-root.hcv-kanban-root.hcv-kanban-root > .hcv-kanban-scroll-host{height:100%;overflow:auto}.hcv-kanban-root.hcv-kanban-root.hcv-kanban-root > .hcv-kanban-scroll-host:has(.hermes-kanban-drawer-shade,.hermes-kanban-dialog-backdrop){overflow:hidden}.hcv-kanban-root.hcv-kanban-root.hcv-kanban-root .hermes-kanban-drawer{height:100%;max-height:100%;width:min(var(--hcv-kanban-hermes-kanban-drawer-width,640px),92%)}.hcv-kanban-root.hcv-kanban-root.hcv-kanban-root .hermes-kanban-drawer-close{height:auto}.hcv-kanban-root.hcv-kanban-root.hcv-kanban-root .hermes-kanban-dialog-backdrop{z-index:61}.hcv-kanban-root.hcv-kanban-root.hcv-kanban-root .hermes-kanban-dialog{max-height:calc(100% - 3rem)}";
  root.append(style);
  root.append(target);
  container.append(root);
  const lifetime = new AbortController();
  const effects = createLeafEffects(root);
  const dialogs = createLeafDialogs(registerDialogEscape);
  const watches = new Set<() => void>();
  effects.window.localStorage.setItem("hermes.kanban.selectedBoard", services.initialBoard ?? "default");
  const Page = createNativeKanban({
    view: services.bridge,
    React: Native.React, hooks: Native.React, components: { ...Native, ConfirmDialog: dialogs.Confirm },
    utils: { cn: Native.cn, timeAgo: timestamp => {
      const seconds = Date.now() / 1000 - timestamp;
      return seconds < 60 ? "just now" : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : seconds < 172800 ? "yesterday" : `${Math.floor(seconds / 86400)}d ago`;
    } },
    ...kanbanSdkTransport(services, lifetime.signal),
    buildWsUrl: async () => { throw new Error("Native sockets are managed by the watch owner"); },
    watch(request) {
      if (lifetime.signal.aborted) return () => undefined;
      const cancel = services.watch({ ...request,
        onEvents: batch => { if (!lifetime.signal.aborted) request.onEvents(batch); },
        onRefresh: () => { if (!lifetime.signal.aborted) request.onRefresh(); },
        onFailure: error => { if (!lifetime.signal.aborted) request.onFailure(error); },
      });
      const close = () => { if (watches.delete(close)) cancel(); };
      watches.add(close);
      return close;
    },
  }, { ...effects, WebSocket, navigator: { clipboard: navigator.clipboard }, console,
    prompt: dialogs.prompt, notice: message => { void dialogs.prompt(message); },
    safeLink: value => typeof value === "string" && /^https:\/\/hermes-agent\.nousresearch\.com\/docs\//.test(value) ? value : undefined,
  });
  const react = Native.createRoot(target);
  react.render(Native.React.createElement(Native.React.Fragment, null, Native.React.createElement(Page), Native.React.createElement(dialogs.Prompts)));
  return {
    element: root,
    diagnostics: () => ({ ...effects.diagnostics(), watches: watches.size, connected: root.isConnected }),
    dispose() {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      for (const close of watches) close();
      dialogs.dispose();
      react.unmount();
      effects.dispose();
      root.remove();
    },
  };
}
