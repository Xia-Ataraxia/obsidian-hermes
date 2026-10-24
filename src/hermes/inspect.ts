import { parseYaml } from "obsidian";
import { asRecord } from "../domain/json-scalars";
import { parseJobsJson } from "../domain/jobs-json-parser";
import { profileHome } from "../domain/profile-candidate-paths";
import type { CronJobRecord, ProfileRef } from "../types/hermes-cron";
import type { LedgerReadResult } from "../types/snapshot";
import { readExecutionHistory } from "../ui/execution-history-reader";
import type { SshReadOnlyAdapter } from "../ui/ssh-read-only-adapter";
import { profileDir, type Outcome } from "./data";
import { b64Arg, json, runScript, safeToken, type RemoteResult, type Sections } from "./remote";

/* ───────────────────────── Types ───────────────────────── */

export type Source = "bundled" | "modified" | "hub" | "local" | "shared" | "omh" | "plugin";

export interface SkillInfo {
  readonly name: string; readonly rdir: string; readonly category: string;
  readonly tier: 1 | 2 | 3 | 4; readonly path: string; readonly source: Source;
  /** Plugin key for plugin skills, "omh" for the omh root. */
  readonly owner: string | null;
  readonly enabled: boolean; readonly platformOff: readonly string[];
  /** Epoch seconds. */
  readonly lastUsed: number | null; readonly uses: number;
  readonly description: string; readonly verdict: string | null;
  /** Why the toggle is locked; shown as its tooltip. */
  readonly readOnly: string | null;
}

export interface PluginInfo {
  readonly key: string; readonly name: string; readonly version: string; readonly description: string;
  readonly origin: "bundled" | "user"; readonly kind: string;
  readonly status: "enabled" | "disabled" | "off" | "provider";
  readonly tools: readonly string[]; readonly hooks: readonly string[]; readonly skills: number;
  /** Flattened, secrets already masked. */
  readonly settings: readonly (readonly [string, string])[];
  /** Names only. */
  readonly env: readonly string[];
  /** "repo @rev · pinned" from the install metadata. */
  readonly source: string | null;
  readonly namespace: string; readonly readOnly: string | null;
}

export interface Detail {
  readonly home: string;
  /** cksum of the config's skills block: the compare-and-swap token for skill toggles. */
  readonly sksum: string;
  /** cksum of the skills and plugins blocks: a skill save checks it, so the roots it allows are the ones this read saw. */
  readonly cfgsum: string;
  /** null when `skills.disabled` isn't a list, so toggles stay read-only. */
  readonly disabled: readonly string[] | null;
  readonly platformDisabled: Readonly<Record<string, readonly string[]>>;
  readonly skills: readonly SkillInfo[]; readonly plugins: readonly PluginInfo[]; readonly at: number;
}

/** Tool → last call (epoch seconds) over the last 30 days. */
export type ToolUse = Readonly<Record<string, number>>;

/* ───────────────────────── Remote scripts ───────────────────────── */

const CHANGED = "Changed on the server. Reload first.";
const SECRET = /key|token|secret|password|auth/i;
const KINDS = new Set(["standalone", "backend", "exclusive", "platform", "model-provider"]);
export const EDIT_CAP = 128 * 1024;

/** `$sk` = the config's skills block, `$pl` = its plugins block plus `memory.provider`. Runs in the profile dir. */
const CONFIG = `N='
'
b=; sk=; pl=
while IFS= read -r l || [ -n "$l" ]; do
  case "$l" in skills:*) b=s ;; plugins:*) b=p ;; memory:*) b=m ;; [!\\ #]*) b= ;; esac
  case "$b" in s) sk="$sk$l$N" ;; p) pl="$pl$l$N" ;; m) case "$l" in memory:*|"  provider:"*) pl="$pl$l$N" ;; esac ;; esac
done < config.yaml
`;

// ponytail: block-list external_dirs only and no ${VAR} expansion (eval would run config text).
/** `$roots` = "<tier> <dir>" lines: 1 the profile's skills, 2 create_dir, 3 external_dirs. */
const ROOTS = `roots="1 $h/skills"
add() {
  p=\${2%%[ \t]#*}; p=\${p#"\${p%%[! ]*}"}; p=\${p#\\"}; p=\${p%\\"}; p=\${p#\\'}; p=\${p%\\'}
  case "$p" in '~'|null|'') return ;; '~/'*) p="$HOME/\${p#\\~/}" ;; /*) ;; *) p="$h/$p" ;; esac
  p=\${p%/}
  case "$N$roots$N" in *" $p$N"*) return ;; esac
  [ -d "$p" ] && roots="$roots$N$1 $p"
}
k=
while IFS= read -r l; do
  case "$l" in
    "  create_dir:"*) k=; add 2 "\${l#*:}" ;;
    "  external_dirs:"*) k=x ;;
    "  - "*|"    - "*) [ "$k" = x ] && add 3 "\${l#*- }" ;;
    "  "[!\\ -]*) k= ;;
  esac
done <<EOF
$sk
EOF
`;

// ponytail: plugin skills only at skills/*/SKILL.md, the depth Hermes and bstack's register() load; a plugin registering deeper ones from code is missed.
/** Everything the profile popup shows, in one pass: config, plugin manifests, every SKILL.md frontmatter, usage. */
function detailScript(id: string): string {
  return `h=${profileDir(id)}
cd "$h" || { echo "Profile not found" >&2; exit 1; }
${CONFIG}S home; printf '%s\\n' "$HOME"
S cfg; printf '%s' "$sk$pl"
S sksum; printf '%s' "$sk" | cksum
S cfgsum; printf '%s' "$sk$pl" | cksum
${ROOTS}man() { for m in plugin.yaml plugin.yml plugin.json; do [ -f "$1$m" ] && { M=$1$m; return 0; }; done; return 1; }
emit() { S "manifest $1 $2 $3"; cat "$3"; [ -d "\${3%/*}/skills" ] && roots="$roots\${N}4 \${3%/*}/skills"; }
for d in "$h"/plugins/*/; do
  n=\${d%/}; n=\${n##*/}; case "$n" in __*) continue ;; esac
  if man "$d"; then emit u "$n" "$M"
  else for e in "$d"*/; do x=\${e%/}; man "$e" && emit u "$n/\${x##*/}" "$M"; done; fi
done
B=$H/hermes-agent/plugins
for t in $(printf '%s' "$pl" | tr -cs 'A-Za-z0-9_./-' '\\n' | sort -u); do
  case "$t" in *..*|/*|-*|.*) continue ;; esac
  man "$B/$t/" || { f=; for c in "$B"/*/; do man "$c$t/" && { f=1; break; }; done; [ -n "$f" ]; } || continue
  emit b "$t" "$M"
done
src=
while read -r t r; do
  [ -d "$r" ] || continue
  set -- "$r"
  for l in $(find "$r" -type l); do [ -d "$l" ] && set -- "$@" "$l/"; done
  for d; do case "$d" in *"'"*) continue ;; esac; src="\${src:+$src UNION ALL }SELECT $t AS tier, '$r' AS root, name, data FROM fsdir('$d')"; done
done <<EOF
$roots
EOF
[ -n "$src" ] || src="SELECT 0 AS tier, '' AS root, '' AS name, NULL AS data WHERE 0"
S skills; sqlite3 :memory: "
WITH f AS (SELECT tier, root, data, CAST(data AS TEXT) t,
                  '/' || replace(substr(name, length(root) + 2), '//', '/') rel FROM ($src)
           WHERE name LIKE '%/SKILL.md' AND rel NOT GLOB '*/.*/*'
             AND rel NOT GLOB '*/node_modules/*' AND rel NOT GLOB '*/venv/*' AND rel NOT GLOB '*/site-packages/*'
             AND rel NOT GLOB '*/__pycache__/*' AND rel NOT GLOB '*/references/*' AND rel NOT GLOB '*/templates/*'
             AND rel NOT GLOB '*/assets/*' AND rel NOT GLOB '*/scripts/*'),
     g AS (SELECT *, substr(rel, 2, length(rel) - 10) rdir,
                  CASE WHEN substr(t, 1, 4) = '---' || char(10) THEN instr(substr(t, 5), char(10) || '---') + 4 ELSE 0 END e FROM f)
SELECT json_group_array(json_array(tier, root, rdir,
         CASE WHEN e > 4 THEN substr(t, 5, e - 5) ELSE '' END,
         CASE WHEN tier = 1 THEN readfile('$H/hermes-agent/skills/' || rdir || '/SKILL.md') = data END))
FROM g WHERE tier < 4 OR instr(rdir, '/') = 0"
S usage; sqlite3 :memory: <<'SQL'
SELECT json_group_object(key, json_array(CAST(strftime('%s', json_extract(value,'$.last_used_at')) AS INTEGER), json_extract(value,'$.use_count'))) FROM json_each(CAST(readfile('skills/.usage.json') AS TEXT));
SQL
S hub; sqlite3 :memory: <<'SQL'
SELECT json_group_object(key, json_array(json_extract(value,'$.source'), json_extract(value,'$.trust_level'), json_extract(value,'$.scan_verdict'))) FROM json_each(CAST(readfile('skills/.hub/lock.json') AS TEXT), '$.installed');
SQL
S bundled; cut -d: -f1 skills/.bundled_manifest 2>/dev/null
S install; cat plugins/.install-metadata.json 2>/dev/null
S end
`;
}

/** Last call per tool over 30 days. state.db has no tool_name index, so scan only ids past the window's first message. */
function toolScript(id: string): string {
  return `cd ${profileDir(id)} || { echo "Profile not found" >&2; exit 1; }
S tools
if [ -f state.db ]; then
  w=$(echo "SELECT coalesce(min(id), (SELECT coalesce(max(id),0) + 1 FROM messages)) FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE started_at > strftime('%s','now') - 2592000);" | ro state.db)
  case "$w" in ''|*[!0-9]*) echo '{}' ;; *) echo "SELECT json_group_object(tool_name, ts) FROM (SELECT tool_name, max(timestamp) ts FROM messages WHERE id >= $w AND role = 'tool' AND tool_name IS NOT NULL GROUP BY tool_name);" | ro state.db ;; esac
else echo '{}'; fi
S end
`;
}

/* ───────────────────────── Parsing ───────────────────────── */

type Row = [number, string, string, string, number | null];

const key = (alias: string, id: string): string => `${alias}\u0000${id}`;
const obj = (value: unknown): Record<string, unknown> => asRecord(value) ?? {};
const own = (record: Record<string, unknown>, name: string): unknown => Object.hasOwn(record, name) ? record[name] : undefined;
const str = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
/** Drops `user:pass@` from URLs. */
const bare = (text: string): string => text.replace(/\/\/[^/@\s]+@/g, "//");
/** Every spelling `skills.disabled` may use for a skill: name, dir name, relative dir; plugin skills only by `ns:skill`. */
const forms = (tier: number, name: string, rdir: string): string[] => tier === 4 ? [name] : [name, rdir.slice(rdir.lastIndexOf("/") + 1), rdir];

function flatten(value: unknown, prefix: string): [string, string][] {
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([name, item]) => flatten(item, prefix ? `${prefix}.${name}` : name));
  return [[prefix, SECRET.test(prefix) ? "••••" : typeof value === "string" ? bare(value) : typeof value === "number" || typeof value === "boolean" ? String(value) : ""]];
}

function envNames(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => typeof item === "string" ? item : str(obj(item).name)).filter(Boolean) : Object.keys(obj(value));
}

async function sha8(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest.slice(0, 4)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function parseDetail(sections: Sections, now: number): Promise<Detail | string> {
  if (!sections.has("end")) return "Incomplete read";
  let cfg: Record<string, unknown> = {};
  const text = sections.get("cfg") ?? "";
  if (text.trim()) {
    try { cfg = obj(parseYaml(text)); } catch { return "Couldn't parse config.yaml"; }
  }
  const home = sections.get("home") ?? "";
  const skillsCfg = obj(cfg.skills), pluginsCfg = obj(cfg.plugins), entries = obj(pluginsCfg.entries);
  const rawDisabled = skillsCfg.disabled;
  // Only a list of plain strings: strings() would drop other entries and the next toggle would write the list back without them.
  const disabled = rawDisabled === undefined || rawDisabled === null ? [] : Array.isArray(rawDisabled) && rawDisabled.every(item => typeof item === "string") ? rawDisabled : null;
  const platformDisabled = Object.fromEntries(Object.entries(obj(skillsCfg.platform_disabled)).map(([platform, list]) => [platform, strings(list)]));
  const enabledList = strings(pluginsCfg.enabled), disabledList = strings(pluginsCfg.disabled);
  const provider = str(obj(cfg.memory).provider);
  const install = obj(json<unknown>(sections.get("install"), null));
  const rows = json<unknown[]>(sections.get("skills"), [])
    .filter((row): row is Row => Array.isArray(row) && typeof row[2] === "string" && row[2] !== "")
    .sort((a, b) => a[0] - b[0]);

  const plugins: PluginInfo[] = [];
  const byRoot = new Map<string, PluginInfo>();
  for (const [name, body] of sections) {
    const [tag, origin, pluginKey, ...rest] = name.split(" ");
    if (tag !== "manifest" || !pluginKey || plugins.some(plugin => plugin.key === pluginKey)) continue;
    const path = rest.join(" "), portable = path.endsWith(".json");
    let manifest: Record<string, unknown>;
    try { manifest = obj(portable ? JSON.parse(body) : parseYaml(body)); } catch { continue; }
    const m = portable ? { ...manifest, ...obj(obj(manifest.extensions)["com.nousresearch.hermes"]) } : manifest;
    const label = str(m.name) || pluginKey;
    const named = (entry: string): boolean => entry === pluginKey || entry === label;
    const isProvider = named(provider);
    // The bundled scan matches every word in the plugins block; only real references count.
    if (origin === "b" && !enabledList.some(named) && !disabledList.some(named) && !isProvider) continue;
    const kind = KINDS.has(str(m.kind)) ? str(m.kind) : "standalone";
    const dir = path.slice(0, path.lastIndexOf("/"));
    const meta = obj(own(install, pluginKey)), rev = str(meta.revision);
    const info: PluginInfo = {
      key: pluginKey, name: label, version: typeof m.version === "number" ? String(m.version) : str(m.version), description: str(m.description),
      origin: origin === "b" ? "bundled" : "user", kind,
      status: disabledList.some(named) ? "disabled" : kind === "model-provider" ? "provider" : enabledList.some(named) || isProvider ? "enabled" : "off",
      tools: strings(m.provides_tools), hooks: strings(m.provides_hooks ?? m.hooks),
      skills: rows.filter(row => row[0] === 4 && row[1] === `${dir}/skills`).length,
      settings: flatten(obj(obj(own(entries, pluginKey)).settings), ""), env: envNames(m.requires_env),
      source: str(meta.source) ? `${bare(str(meta.source))}${rev ? ` @${/^[0-9a-f]{40}$/.test(rev) ? rev.slice(0, 7) : rev}` : ""}${meta.pinned === true ? " · pinned" : ""}` : null,
      namespace: portable ? `agent-plugin-${pluginKey.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${await sha8(pluginKey)}` : str(m.skill_namespace) || label,
      readOnly: isProvider ? "Active via memory.provider; switch it in config.yaml"
        : kind === "exclusive" ? "Exclusive plugin; activate via its provider config"
        : kind === "model-provider" ? "Model providers load whenever configured" : null,
    };
    plugins.push(info);
    byRoot.set(`${dir}/skills`, info);
  }

  const usage = obj(json<unknown>(sections.get("usage"), null));
  const hub = obj(json<unknown>(sections.get("hub"), null));
  const bundled = new Set((sections.get("bundled") ?? "").split("\n"));
  const omhHome = str(obj(obj(own(entries, "omh")).settings).omh_home).replace(/^~(?=\/|$)/, home).replace(/\/+$/, "");
  const omhRoot = omhHome && `${omhHome}/skills`;
  const skills: SkillInfo[] = [];
  const seen = new Set<string>();
  for (const [tier, root, rdir, fm, same] of rows) {
    const plugin = tier === 4 ? byRoot.get(root) : undefined;
    // Plugin skills load only while their plugin is enabled.
    if (tier === 4 && plugin?.status !== "enabled") continue;
    let front: Record<string, unknown> = {};
    try { front = fm ? obj(parseYaml(fm)) : {}; } catch { /* the dir name stands in */ }
    const base = rdir.slice(rdir.lastIndexOf("/") + 1);
    const short = str(front.name) || base;
    const name = plugin ? `${plugin.namespace}:${short}` : short;
    if (seen.has(name)) continue;
    seen.add(name);
    const source: Source = plugin ? "plugin"
      : tier === 1 && Object.hasOwn(hub, name) ? "hub"
      : tier === 1 && bundled.has(name) ? same === 0 ? "modified" : "bundled"
      : root === omhRoot ? "omh"
      : tier === 3 ? "shared" : "local";
    const spellings = forms(tier, name, rdir);
    const hit = (list: readonly string[]): boolean => list.some(entry => spellings.includes(entry));
    // Older usage files key plugin skills by bare name; fall back to it unless a non-plugin skill owns that name.
    const used = own(usage, name) ?? (plugin && !seen.has(short) ? own(usage, short) : undefined), [last, count] = Array.isArray(used) ? used as unknown[] : [];
    const lock = own(hub, name);
    skills.push({
      name, rdir, category: plugin ? plugin.name : rdir.includes("/") ? rdir.slice(0, rdir.lastIndexOf("/")) : "",
      tier: tier as SkillInfo["tier"], path: `${root}/${rdir}/SKILL.md`, source,
      owner: plugin ? plugin.key : source === "omh" ? "omh" : null,
      enabled: !hit(disabled ?? []), platformOff: Object.keys(platformDisabled).filter(platform => hit(platformDisabled[platform] ?? [])),
      lastUsed: typeof last === "number" ? last : null, uses: typeof count === "number" ? count : 0,
      description: str(front.description), verdict: source === "hub" && Array.isArray(lock) ? str(lock[2]) || null : null,
      readOnly: name === "hermes-agent" ? "Essential" : disabled === null ? "skills.disabled isn't a plain list; edit config.yaml" : null,
    });
  }
  return { home, sksum: sections.get("sksum") ?? "", cfgsum: sections.get("cfgsum") ?? "", disabled, platformDisabled, skills, plugins, at: now };
}

/** `skills.disabled` after turning `skill` on or off; turning on drops every spelling of it. */
export function nextDisabled(list: readonly string[], skill: SkillInfo, on: boolean): string[] {
  const names = forms(skill.tier, skill.name, skill.rdir);
  if (on) return list.filter(entry => !names.includes(entry));
  return list.some(entry => names.includes(entry)) ? [...list] : [...list, skill.name];
}

/** Least recently used first; never-used skills lead. */
export const byLeastRecent = (a: SkillInfo, b: SkillInfo): number =>
  (a.lastUsed ?? -Infinity) - (b.lastUsed ?? -Infinity) || a.name.localeCompare(b.name);

/** Latest call to the plugin's tools (declared, else `<name>_*`) or use of its skills. */
export function pluginLastUsed(plugin: PluginInfo, use: ToolUse, skills: readonly SkillInfo[]): number | null {
  const tools = plugin.tools.length ? plugin.tools : Object.keys(use).filter(tool => tool.startsWith(`${plugin.name}_`));
  const known = [...tools.map(tool => use[tool]), ...skills.filter(skill => skill.owner === plugin.key && skill.tier === 4).map(skill => skill.lastUsed)]
    .filter((at): at is number => typeof at === "number");
  return known.length ? Math.max(...known) : null;
}

function outcome(result: RemoteResult): Outcome {
  return result.ok && result.sections.has("ok") ? { ok: true } : { ok: false, message: result.ok ? "No confirmation from host" : result.message };
}

/* ───────────────────────── Client ───────────────────────── */

/** Profile popup reads and writes. Writes go through the `hermes` CLI or a checksum-guarded file swap, one at a time per profile. */
export class InspectClient {
  private readonly details = new Map<string, Detail>();
  private readonly reads = new Map<string, Promise<Detail | string>>();
  private readonly toolUse = new Map<string, { readonly at: number; readonly use: Promise<ToolUse | null> }>();
  private readonly queue = new Map<string, Promise<unknown>>();

  constructor(private readonly adapter: SshReadOnlyAdapter) {}

  cached(alias: string, id: string): Detail | null {
    return this.details.get(key(alias, id)) ?? null;
  }

  /** Joins a read in flight unless `fresh` (after a write). */
  detail(alias: string, id: string, fresh = false): Promise<Detail | string> {
    const k = key(alias, id), pending = this.reads.get(k);
    if (pending && !fresh) return pending;
    const read: Promise<Detail | string> = runScript(this.adapter, alias, detailScript(id)).then(async result => {
      if (!result.ok) return result.message;
      const detail = await parseDetail(result.sections, Date.now() / 1000);
      if (typeof detail !== "string" && this.reads.get(k) === read) this.details.set(k, detail);
      return detail;
    }).finally(() => { if (this.reads.get(k) === read) this.reads.delete(k); });
    this.reads.set(k, read);
    return read;
  }

  /** Cached a minute: it scans state.db. A failed read resolves null and is dropped, so the next call reads again. */
  tools(alias: string, id: string): Promise<ToolUse | null> {
    const k = key(alias, id), hit = this.toolUse.get(k);
    if (hit && Date.now() - hit.at < 60_000) return hit.use;
    const use: Promise<ToolUse | null> = runScript(this.adapter, alias, toolScript(id))
      .then(result => result.ok && result.sections.has("end") ? json<ToolUse>(result.sections.get("tools"), {}) : null)
      .catch(() => null)
      .then(got => { if (got === null && this.toolUse.get(k)?.use === use) this.toolUse.delete(k); return got; });
    this.toolUse.set(k, { at: Date.now(), use });
    return use;
  }

  /** A SKILL.md or the profile's SOUL/USER/MEMORY file, with the cksum a save must match. */
  async read(alias: string, id: string, path: string): Promise<{ readonly text: string; readonly sum: string } | string> {
    if (!["SOUL.md", "memories/USER.md", "memories/MEMORY.md"].includes(path) && !this.cached(alias, id)?.skills.some(skill => skill.path === path)) return "Not a readable file";
    const result = await runScript(this.adapter, alias, `h=${profileDir(id)}; f=${b64Arg(path)}
N='
'
case "$f" in *..*|*"$N"*|'') echo "Bad path" >&2; exit 2 ;; /*) ;; *) f="$h/$f" ;; esac
case "$f" in */SKILL.md|"$h/SOUL.md"|"$h/memories/USER.md"|"$h/memories/MEMORY.md") ;; *) echo "Not a readable file" >&2; exit 2 ;; esac
S sum; { [ -f "$f" ] && cksum < "$f"; } || echo missing
S body; cat "$f" 2>/dev/null; printf x
`);
    if (!result.ok) return result.message;
    const body = result.sections.get("body");
    // The trailing "x" keeps trailing whitespace; a second split means the file held a section mark.
    if (result.sections.size !== 2 || !body?.endsWith("x")) return "Incomplete read";
    return { text: body.slice(0, -1), sum: result.sections.get("sum") ?? "missing" };
  }

  /** Swaps the file in only if its cksum still matches `sum`. A skill's directory (a linked SKILL.md's: its target's)
   *  must physically sit in this profile's own roots, not omh's. */
  save(alias: string, id: string, path: string, sum: string, next: string): Promise<Outcome> {
    return this.serial(key(alias, id), async () => {
      const detail = this.cached(alias, id);
      if (!detail || !/^\d+ \d+$/.test(detail.cfgsum) || !/^(\d+ \d+|missing)$/.test(sum)) return { ok: false, message: CHANGED };
      const content = Buffer.from(next, "utf8");
      // ponytail: the content rides in the ssh command (~256 KiB limit); sending it on stdin would lift this cap.
      if (content.length > EDIT_CAP) return { ok: false, message: "Too large to edit here (> 128 KB)" };
      // The omh root comes from the cached Detail; the cfgsum check below keeps the host's config the one it was read from.
      const omh = detail.skills.find(skill => skill.source === "omh");
      const omhRoot = omh ? omh.path.slice(0, -(omh.rdir.length + 10)) : "";
      return outcome(await runScript(this.adapter, alias, `h=${profileDir(id)}; f=${b64Arg(path)}
cd "$h" || { echo "Profile not found" >&2; exit 1; }
${CONFIG}case "$f" in *..*|*"$N"*|'') echo "Bad path" >&2; exit 2 ;; /*) ;; *) f="$h/$f" ;; esac
case "$f" in */SKILL.md) [ "$(printf '%s' "$sk$pl" | cksum)" = '${detail.cfgsum}' ] || { echo "${CHANGED}" >&2; exit 3; } ;; esac
${ROOTS}omh=${b64Arg(omhRoot)}
ok=; case "$f" in
  "$h/SOUL.md"|"$h/memories/USER.md"|"$h/memories/MEMORY.md") ok=1 ;;
  */SKILL.md)
    # Each path leaves $(...) with a sentinel x: a bare $(...) strips trailing newlines, so a name ending in one would
    # be checked as another path than the one written.
    real() { cd -P "$1" 2>/dev/null && pwd -P && printf x; }
    d=$(real "\${f%/*}"); d=\${d%?x}
    if [ -L "$f" ]; then
      g=$(readlink -n "$f"; printf x); g=\${g%x}; case "$g" in /*) ;; *) g="\${f%/*}/$g" ;; esac
      [ -L "$g" ] && { echo "Linked twice; edit it at its source" >&2; exit 2; }
      d=; [ "\${g##*/}" = SKILL.md ] && d=$(real "\${g%/*}") && d=\${d%?x}
    fi
    [ -n "$omh" ] && { o=$(real "$omh") || { echo "${CHANGED}" >&2; exit 3; }; o=\${o%?x}; case "$d/" in "$o"/*) d= ;; esac; }
    while read -r t r; do r=$(real "$r") && r=\${r%?x} && [ -n "$d" ] && case "$d" in "$r"/*) ok=1 ;; esac; done <<EOF
$roots
EOF
    ;;
esac
[ -n "$ok" ] || { echo "Not an editable file" >&2; exit 2; }
cur=$( { [ -f "$f" ] && cksum < "$f"; } || echo missing )
[ "$cur" = '${sum}' ] || { echo "${CHANGED}" >&2; exit 3; }
c='${content.toString("base64")}'
if [ -L "$f" ]; then arg "$c" > "$f" || { echo "Couldn't save the file" >&2; exit 1; }
else tmp="$f.obsidian.$$"; mkdir -p "\${f%/*}" && { [ ! -e "$f" ] || cp -p "$f" "$tmp"; } && arg "$c" > "$tmp" && mv -f "$tmp" "$f" || { rm -f "$tmp"; echo "Couldn't save the file" >&2; exit 1; }
fi && S ok
`, 64 * 1024));
    });
  }

  /** Rewrites `skills.disabled` only if the skills block is unchanged since the last read. */
  toggleSkill(alias: string, id: string, skill: SkillInfo, on: boolean): Promise<Outcome> {
    return this.serial(key(alias, id), async () => {
      if (skill.readOnly) return { ok: false, message: skill.readOnly };
      const detail = this.cached(alias, id);
      if (!detail?.disabled || !/^\d+ \d+$/.test(detail.sksum)) return { ok: false, message: CHANGED };
      // ponytail: ~2 s pass between this check and the write while hermes starts; closing that needs a lock inside hermes.
      const result = outcome(await runScript(this.adapter, alias, `cd ${profileDir(id)} || { echo "Profile not found" >&2; exit 1; }
${CONFIG}[ "$(printf '%s' "$sk" | cksum)" = '${detail.sksum}' ] || { echo "${CHANGED}" >&2; exit 3; }
hermes -p ${safeToken(id)} config set skills.disabled ${b64Arg(JSON.stringify(nextDisabled(detail.disabled, skill, on)))} </dev/null >&2 && S ok
`));
      await this.detail(alias, id, true);
      return result;
    });
  }

  /** A plain `plugins enable`: it keeps any tool-override grant, and without a TTY it turns the plugin on with its
   *  capabilities not granted (`ungranted`); granting them takes a terminal. */
  togglePlugin(alias: string, id: string, plugin: PluginInfo, on: boolean): Promise<Outcome & { ungranted?: true }> {
    return this.serial(key(alias, id), async () => {
      if (plugin.readOnly) return { ok: false, message: plugin.readOnly };
      const result = await runScript(this.adapter, alias, `k=${b64Arg(plugin.key)}; case "$k" in -*|*..*|'') echo "Bad plugin key" >&2; exit 2 ;; esac
${on ? `out=$(hermes -p ${safeToken(id)} plugins enable "$k" 2>&1 </dev/null) && { S ok; printf '%s\\n' "$out"; } || { printf '%s\\n' "$out" >&2; exit 1; }`
    : `hermes -p ${safeToken(id)} plugins disable "$k" </dev/null >&2 && S ok`}
`);
      await this.detail(alias, id, true);
      const done = outcome(result);
      return done.ok && result.ok && /capabilities NOT granted/.test(result.sections.get("ok") ?? "") ? { ...done, ungranted: true as const } : done;
    });
  }

  /** Pause or resume, only if the job's enabled flag still reads the way the popup showed it. */
  toggleJob(alias: string, id: string, job: string, on: boolean): Promise<Outcome> {
    return this.serial(key(alias, id), async () => outcome(await runScript(this.adapter, alias, `cd ${profileDir(id)} || { echo "Profile not found" >&2; exit 1; }
cur=$(sqlite3 :memory: "SELECT coalesce(json_extract(value,'\\$.enabled'),1) FROM json_each(CAST(readfile('cron/jobs.json') AS TEXT),'\\$.jobs') WHERE json_extract(value,'\\$.id')='${safeToken(job)}'")
[ "$cur" = '${on ? 0 : 1}' ] || { echo "${CHANGED}" >&2; exit 3; }
hermes -p ${safeToken(id)} cron ${on ? "resume" : "pause"} ${safeToken(job)} </dev/null >&2 && S ok
`)));
  }

  /** Last 10 runs of one job from the execution ledger. */
  async runs(alias: string, id: string, job: string): Promise<LedgerReadResult> {
    const detail = this.cached(alias, id);
    if (!detail) return { status: "ledger-unavailable", detail: "Profile not loaded", rows: [], windowLimited: false };
    return readExecutionHistory(this.adapter, { alias, profileId: id, home: profileHome(detail.home, id) }, { jobId: job, limit: 10 });
  }

  /** The full job record and profile ref the job detail modal takes. */
  async job(alias: string, id: string, job: string): Promise<{ readonly record: CronJobRecord; readonly ref: ProfileRef } | string> {
    const result = await runScript(this.adapter, alias, `cd ${profileDir(id)} || { echo "Profile not found" >&2; exit 1; }
S home; printf '%s\\n' "$HOME"
S jobs; cat cron/jobs.json 2>/dev/null; true
`);
    if (!result.ok) return result.message;
    const record = parseJobsJson({ alias, profileId: id }, json<unknown>(result.sections.get("jobs"), null)).jobs.find(row => row.id === job);
    return record ? { record, ref: { alias, profileId: id, home: profileHome(result.sections.get("home") ?? "", id) } } : "Job not found";
  }

  private serial<T>(name: string, task: () => Promise<T>): Promise<T> {
    const run = (this.queue.get(name) ?? Promise.resolve()).then(task);
    this.queue.set(name, run.catch(() => undefined));
    return run;
  }
}
