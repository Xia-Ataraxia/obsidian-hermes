import type { ProfilesSnapshot } from "./data";
import type { Detail } from "./inspect";
import type { BoardRead } from "./kanban";

/*
 * What the views keep on disk, so the next open paints at once. The rule: no secrets and no transcripts; task and
 * cron bodies, session titles and activity snippets count as transcripts. Every keep* below builds a NEW object from
 * a list of fields to keep, so a field nobody lists never reaches disk. Fields the views need but must not store
 * get a neutral value ("", [], null, 0), which keeps the stored shape the same type as live data.
 */

/** The part of the vault adapter the cache uses; Obsidian's DataAdapter fits. */
export interface CacheFs {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
}

export interface Saved { readonly at: number; readonly data: unknown }

export interface DiskCache {
  /** A miss (nothing saved, torn or foreign file, other version) is null; never rejects. */
  load(alias: string, key: string): Promise<Saved | null>;
  /** Fire and forget: writes are queued, and a failed write only costs the cache. */
  save(alias: string, key: string, data: unknown): void;
  /** Forgets one host's files, or all of them. */
  drop(alias?: string): Promise<void>;
}

/** Bump when a stored shape changes; files of another version then read as a miss. */
export const CACHE_VERSION = 1;

/**
 * One path segment, from text that comes from settings or the host. Bytes outside [a-z0-9-] become `_xx`
 * (a lone `.` only inside), so the result is [A-Za-z0-9._-], is never `.` or `..`, and no two inputs share one.
 * Lowercase only: a case-insensitive disk could not tell `A` and `a` apart.
 * ponytail: a segment over 255 bytes or a Windows device name (con, nul) fails to write, which only costs the cache.
 */
export function piece(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const out = Array.from(bytes, (byte, i) => {
    const ch = String.fromCharCode(byte);
    return /[a-z0-9-]/.test(ch) || (ch === "." && i > 0 && i < bytes.length - 1) ? ch : `_${byte.toString(16).padStart(2, "0")}`;
  }).join("");
  return out || "_";
}

/** Files at `<root>/<host>/<key>.json`; `on` is asked on every call, and a null root means no cache. */
export function diskCache(fs: CacheFs, root: string | null, on: () => boolean): DiskCache {
  if (!root) return { load: () => Promise.resolve(null), save: () => undefined, drop: () => Promise.resolve() };
  let tail = Promise.resolve();
  /** One job at a time, so a drop never lands between a save's mkdir and its write. */
  const queue = (job: () => Promise<void>): Promise<void> => (tail = tail.then(job).catch(() => undefined));
  const folder = (alias: string): string => `${root}/${piece(alias)}`;
  const file = (alias: string, key: string): string => `${folder(alias)}/${piece(key)}.json`;
  return {
    async load(alias, key) {
      if (!on()) return null;
      try {
        // ponytail: reads skip the queue; a file caught mid-write fails to parse and reads as a miss.
        const saved = JSON.parse(await fs.read(file(alias, key))) as { v?: unknown; at?: unknown; data?: unknown } | null;
        return saved?.v === CACHE_VERSION && typeof saved.at === "number" && saved.data !== undefined ? { at: saved.at, data: saved.data } : null;
      } catch {
        return null;
      }
    },
    save(alias, key, data) {
      if (!on()) return;
      let text: string;
      try { text = JSON.stringify({ v: CACHE_VERSION, at: Date.now(), data }); } catch { return; }
      const dir = folder(alias), path = file(alias, key);
      // Two guarded mkdirs, so it holds whether or not the adapter's mkdir is recursive.
      void queue(async () => {
        for (const d of [root, dir]) if (!(await fs.exists(d))) await fs.mkdir(d);
        await fs.write(path, text);
      });
    },
    drop(alias) {
      const target = alias === undefined ? root : folder(alias);
      return queue(async () => { if (await fs.exists(target)) await fs.rmdir(target, true); });
    },
  };
}

/* ───────────────────────── What each view keeps ───────────────────────── */

/** A new object with just `keys` of `from`, those it has. */
function pick<T extends object, K extends keyof T>(from: T, keys: readonly K[]): Pick<T, K> {
  const out: Partial<T> = {};
  for (const key of keys) if (from[key] !== undefined) out[key] = from[key];
  return out as Pick<T, K>;
}

/**
 * Profiles: names, models, live state, counts, edges, and per job id, name, schedule, enabled, last run and status.
 * Not kept: job prompts, errors and delivery, session titles (`usage.recent`, also the busy chip's text),
 * descriptions, skill text, next-run times.
 */
export function keepProfiles(snapshot: ProfilesSnapshot): ProfilesSnapshot {
  return {
    now: snapshot.now,
    profiles: snapshot.profiles.map(p => ({
      ...pick(p, ["id", "model", "provider"]),
      description: "",
      // Only the count shows until the live read; the names are all that is kept of the rows.
      skills: p.skills.map(({ name }) => ({ name, category: "", description: "" })),
      jobs: p.jobs.map(job => ({ ...pick(job, ["id", "name", "schedule", "enabled", "last", "status"]), state: null, next: null, error: null, deliver: null, skills: [], prompt: "" })),
      gateway: p.gateway && pick(p.gateway, ["state", "alive", "platforms", "served"]),
      usage: p.usage && { ...pick(p.usage, ["sessions7d", "tokens7d", "cost7d", "messages7d", "last", "busy", "daily", "sources"]), recent: [] },
      load: pick(p.load, ["running", "ready", "blocked", "todo", "review", "done7d"]),
    })),
    edges: snapshot.edges.map(edge => pick(edge, ["a", "b", "handoffs", "comments", "links"])),
  };
}

/** A config flag as the view reads it (`on` in kanban-view.ts): off only for false, no, off or 0, and unset is on. */
const flag = (value: string | undefined): string => String(!/^(false|no|off|0)$/i.test(value ?? ""));

/**
 * Kanban: the board read, card metadata and titles only. Not kept: card bodies, blocked reasons and last errors
 * (`text`, `reason`, `lastError`), the change token (so the first live read is a full one and a slim card is never
 * taken for a fresh one), and every `config` value but two. The two that decide the layout, `lane_by_profile` and
 * `auto_decompose`, are written as new "true"/"false" strings, never the config object or any other key, so the
 * lanes and the Auto/Manual pill do not jump after the live read.
 */
export function keepBoard(read: BoardRead): BoardRead {
  return {
    board: read.board, token: null, profiles: read.profiles,
    config: { lane_by_profile: flag(read.config.lane_by_profile), auto_decompose: flag(read.config.auto_decompose) },
    boards: read.boards.map(meta => pick(meta, ["slug", "name", "description", "icon", "color", "workdir", "archived", "counts"])),
    tasks: read.tasks.map(card => pick(card, ["id", "title", "status", "priority", "createdAt", "assignee", "tenant", "startedAt", "completedAt", "blockKind", "blockRecurrences", "failures", "heartbeatAt", "maxRuntime", "pid", "claimExpires", "comments", "parents", "children", "childrenDone"])),
  };
}

/** Chat: what paints the profile chips and nothing of any thread. */
export function keepChat(profiles: readonly { id: string; live: boolean }[]): { profiles: { id: string; live: boolean }[] } {
  return { profiles: profiles.map(p => pick(p, ["id", "live"])) };
}

/** Shown on the switches of a saved copy until the live read replaces it. */
const SAVED = "Saved copy: switches unlock once the live list has loaded";

/**
 * Inspector: skill rows (name, source, tier, enabled, last used, category, uses) and plugin rows (name, status). Not
 * kept: paths, descriptions, verdicts, settings, env names, config sums, anything of the Activity tab or of SOUL, USER
 * and MEMORY.
 * The placeholders are never a real path or key, and `readOnly` keeps every switch off while the copy is shown.
 */
export function keepDetail(detail: Detail): Detail {
  return {
    home: "", sksum: "", cfgsum: "", disabled: null, platformDisabled: {}, at: detail.at,
    skills: detail.skills.map((skill, i) => ({
      ...pick(skill, ["name", "source", "tier", "enabled", "lastUsed", "category", "uses"]),
      rdir: "", path: `cached:${i}`, owner: null, platformOff: [], description: "", verdict: null, readOnly: SAVED,
    })),
    plugins: detail.plugins.map((plugin, i) => ({
      ...pick(plugin, ["name", "status"]),
      key: `cached:${i}`, version: "", description: "", origin: "user", kind: "", tools: [], hooks: [], skills: 0, settings: [], env: [], source: null, namespace: "", readOnly: SAVED,
    })),
  };
}
