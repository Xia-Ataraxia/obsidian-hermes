import * as primitives from "./fixture-reference-primitives";
class FixtureRefusal extends Error { constructor(readonly reason: string) { super(reason); } }

declare global {
  interface Window {
    __HERMES_PLUGIN_SDK__: unknown;
    __HERMES_PLUGINS__: { register(name: string, page: primitives.React.ComponentType): void };
  }
}
const bootstrap = await fetch("/").then(response => response.text());
const literal = bootstrap.match(/window\.__HERMES_SESSION_TOKEN__=("[a-f0-9]+");/);
const token: unknown = literal?.[1] ? JSON.parse(literal[1]) : null;
if (typeof token !== "string") throw new FixtureRefusal("reference bootstrap missing");
function scoped(path: string): URL {
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin || !url.pathname.startsWith("/api/plugins/kanban/")) throw new FixtureRefusal("reference URL refused");
  url.searchParams.set("profile", "default");
  return url;
}
const authedFetch = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("X-Hermes-Session-Token", token);
  return fetch(scoped(path), { ...init, headers });
};
// Upstream web/src/lib/utils.ts:18, SHA256 4e13dd449bd4aa30829e93d9f44b9dcc4b64cf31f836efc9756132c58d70b4e7 (MIT).
function timeAgo(ts: number): string {
  const delta = Date.now() / 1000 - ts;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 172800) return "yesterday";
  return `${Math.floor(delta / 86400)}d ago`;
}
window.__HERMES_PLUGIN_SDK__ = {
  React: primitives.React, hooks: primitives.React, components: primitives,
  utils: { cn: primitives.cn, timeAgo },
  authedFetch,
  fetchJSON: async (path: string, init?: RequestInit) => {
    const response = await authedFetch(path, init);
    if (!response.ok) throw new FixtureRefusal(`HTTP ${response.status}`);
    return response.json();
  },
  buildWsUrl: async (path: string, params: Record<string, string>) => {
    const url = scoped(path);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("token", token);
    url.protocol = "ws:";
    return url.toString();
  },
};
window.__HERMES_PLUGINS__ = { register(name, Page) {
  if (name !== "kanban") throw new FixtureRefusal("unexpected reference plugin");
  const target = document.getElementById("reference");
  if (!target) throw new FixtureRefusal("reference root absent");
  primitives.createRoot(target).render(primitives.React.createElement(Page));
} };
const upstream = document.createElement("script");
upstream.src = "/reference/upstream.js";
document.head.append(upstream);
