import { parseControlCenterToken } from "../src/domain/control-center-validation";
import type { ControlCenterToken, TokenKind } from "../src/types/control-center";
import { PluginDataGateway } from "../src/ui/plugin-data-gateway";
import { ControlCenterPreferencesStore } from "../src/ui/control-center-preferences-store";

export function token<K extends TokenKind>(kind: K, value: string): ControlCenterToken<K> {
  const result = parseControlCenterToken(kind, value);
  if (!result.ok) throw new TypeError("Invalid fixture token");
  return result.value;
}

export function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export class MemoryPluginData {
  serialized: string;
  writes = 0;
  failures = 0;
  readonly entered = deferred();
  readonly release = deferred();
  blocked = false;

  constructor(initial: unknown = {}) { this.serialized = JSON.stringify(initial); }
  async loadData(): Promise<unknown> {
    if (this.blocked) {
      this.entered.resolve();
      await this.release.promise;
    }
    return JSON.parse(this.serialized);
  }
  async saveData(value: unknown): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new TypeError("Synthetic write rejection");
    }
    this.serialized = JSON.stringify(value);
    this.writes += 1;
  }
}

export function fixture(initial: unknown = {}) {
  const adapter = new MemoryPluginData(initial);
  const gateway = new PluginDataGateway(adapter);
  return { adapter, gateway, store: new ControlCenterPreferencesStore(gateway) };
}

export function layout(x = 19) {
  return {
    positions: [{ profile: token("profile", "xia"), x, y: -7 }],
    viewport: { x: 22, y: -12, zoom: 1.5 },
    filters: { boards: [token("board", "work")], window: 7, types: ["review"] },
    view: "profiles",
  } as const;
}

export function forbiddenKeys(value: unknown): readonly string[] {
  const forbidden = new Set(["body", "prompt", "script", "soul", "user", "token", "events", "entities", "draft", "search"]);
  if (Array.isArray(value)) return value.flatMap(forbiddenKeys);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [...(forbidden.has(key) ? [key] : []), ...forbiddenKeys(child)]);
}
