import { createHash } from "node:crypto";
import { hostPatches } from "./build-host-patches.mjs";
import { viewPatches } from "./build-view-patches.mjs";

export const SOURCE_PINS = Object.freeze({
  "upstream.js": "c316f2e7155b288de8dd709fd8975e9dbc3af6d59a255c74039ce401fd121a3a",
  "upstream.css": "4fec2b7a06c80dedacce78a63b05dffaaa44afe20e4288693d0d13f06a1977a4",
  "upstream-host.css": "0f65b06e327494f599d59d57cd0633387a0f0bef11be2917a70cc2ffde60690b",
  LICENSE: "821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6",
});
export const PRIMITIVES = Object.freeze(["Card", "CardContent", "Badge", "Button", "Input", "Label", "Select", "SelectOption", "Checkbox", "ConfirmDialog"]);
export function sha256(text) { return createHash("sha256").update(text).digest("hex"); }

export function verifySources(files, manifest) {
  if (manifest?.schemaVersion !== 1) throw new Error("Unsupported Kanban provenance schemaVersion");
  if (JSON.stringify(manifest.requiredPrimitives) !== JSON.stringify(PRIMITIVES)) throw new Error("Missing/malformed requiredPrimitives inventory");
  for (const [name, pin] of Object.entries(SOURCE_PINS)) {
    if (manifest.sourcePins?.[name] !== pin) throw new Error(`Source manifest pin mismatch: ${name}`);
    if (typeof files[name] !== "string" || sha256(files[name]) !== pin) throw new Error(`Source hash mismatch: ${name}`);
  }
}

function replaceOnce(source, from, to, label) {
  if (source.split(from).length !== 2) throw new Error(`Adapter patch mismatch: ${label}`);
  return source.replace(from, to);
}

export function factorySource(files, manifest) {
  verifySources(files, manifest);
  let source = replaceOnce(files["upstream.js"], '\n(function () {\n  "use strict";', '\nexport function createNativeKanban(SDK, host) {\n  "use strict";', "factory-injection");
  source = replaceOnce(source, "  const SDK = window.__HERMES_PLUGIN_SDK__;\n  if (!SDK) return;", `
  for (const name of ${JSON.stringify(PRIMITIVES)}) {
    if (!SDK?.components?.[name]) throw new Error("Missing Kanban primitive: " + name);
  }
  for (const name of ["useState", "useEffect", "useCallback", "useMemo", "useRef"]) {
    if (typeof SDK?.hooks?.[name] !== "function") throw new Error("Missing Kanban hook: " + name);
  }
  for (const name of ["fetchJSON", "authedFetch", "buildWsUrl"]) {
    if (typeof SDK?.[name] !== "function") throw new Error("Missing Kanban service: " + name);
  }
  if (typeof SDK?.React?.createElement !== "function" || typeof SDK.React.Component !== "function") throw new Error("Missing Kanban React");
  for (const name of ["cn", "timeAgo"]) {
    if (typeof SDK?.utils?.[name] !== "function") throw new Error("Missing Kanban utility: " + name);
  }
  if (!host) throw new Error("Missing Kanban host");
  const { window, document, navigator, WebSocket, URL, setTimeout, clearTimeout, requestAnimationFrame, console } = host;
`, "host-globals");
  const tail = '  if (window.__HERMES_PLUGINS__ && typeof window.__HERMES_PLUGINS__.register === "function") {\n    window.__HERMES_PLUGINS__.register("kanban", KanbanPage);\n  }\n})();';
  return viewPatches(hostPatches(replaceOnce(source, tail, "  return KanbanPage;\n}", "local-registration")));
}
