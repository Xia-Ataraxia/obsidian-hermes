import type * as React from "react";
import type * as Native from "./primitives";
import type { KanbanHostServices } from "../../ui/kanban-host-services";

export interface NativeKanbanSdk {
  readonly React: typeof React;
  readonly components: Pick<typeof Native,
    "Card" | "CardContent" | "Badge" | "Button" | "Input" | "Label" |
    "Select" | "SelectOption" | "Checkbox" | "ConfirmDialog">;
  readonly hooks: Pick<typeof React, "useState" | "useEffect" | "useCallback" | "useMemo" | "useRef">;
  readonly utils: {
    readonly cn: typeof Native.cn;
    readonly timeAgo: (timestamp: number) => string;
  };
  readonly fetchJSON: (path: string, init?: RequestInit) => Promise<unknown>;
  readonly authedFetch: (path: string, init?: RequestInit) => Promise<Response>;
  readonly buildWsUrl: (path: string, params: Readonly<Record<string, string>>) => Promise<string>;
  readonly useI18n?: () => { readonly t: Readonly<Record<string, unknown>>; readonly locale: string };
  readonly watch: KanbanHostServices["watch"];
  readonly view?: KanbanHostServices["bridge"];
}

/** All ambient browser effects are owned by the future leaf host. */
export interface NativeKanbanEnvironment {
  readonly window: Pick<Window, "localStorage" | "addEventListener" | "removeEventListener" | "prompt" | "alert" | "confirm">;
  readonly document: Pick<Document, "body" | "createElement" | "elementFromPoint" | "querySelector" | "querySelectorAll" | "addEventListener" | "removeEventListener">;
  readonly navigator: Pick<Navigator, "clipboard">;
  readonly WebSocket: typeof WebSocket;
  readonly URL: typeof URL;
  readonly setTimeout: (callback: () => void, delay?: number) => number;
  readonly clearTimeout: (id: number) => void;
  readonly requestAnimationFrame: typeof globalThis.requestAnimationFrame;
  readonly console: Pick<Console, "error">;
  readonly prompt: (message: string, initial?: string) => Promise<string | null>;
  readonly notice: (message: string) => void;
  readonly safeLink: (value: unknown) => string | undefined;
}

/** Generates the native page locally; does not mount, register, or start IO. */
export function createNativeKanban(sdk: NativeKanbanSdk, host: NativeKanbanEnvironment): React.ComponentType;
