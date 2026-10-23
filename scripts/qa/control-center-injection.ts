import { resolve } from "node:path";
import { realpathSync, readFileSync } from "node:fs";
import type { ControlCenterDependencies } from "../../src/types/control-center-composition";
import type { DashboardConnectionProvider } from "../../src/types/dashboard-connection";
import { ClosedProfileMetadataReader } from "../../src/ui/profile-metadata-reader";
import { TaskActivityCollector } from "../../src/ui/task-activity-collector";
import { SshReadOnlyAdapter } from "../../src/ui/ssh-read-only-adapter";
import { ProfileDocumentStore } from "../../src/ui/profile-document-store";
import { PROFILE_METADATA_PYTHON } from "../../src/domain/profile-metadata-python";
import { TASK_ACTIVITY_PYTHON } from "../../src/domain/task-activity-python";
import { REMOTE_DOCUMENT_SCRIPT } from "../../src/domain/profile-document-python";
import { ACTIVITY_LIMITS } from "../../src/types/task-activity";
import { FixtureRefusal, isRecord, ownedPath, verifyHost } from "./fixture-guard";
import { CONTROL_CENTER_PYTHON, fixtureDelay, fixtureProcess, scenarioAt } from "./control-center-runtime";

export interface ControlCenterFixtureOptions {
  readonly root: string;
  readonly origin: string;
  readonly sourceRoot: string;
}
export function createControlCenterFixtureDependencies(options: ControlCenterFixtureOptions): ControlCenterDependencies {
  verifyHost();
  const root = ownedPath(options.root);
  const origin = new URL(options.origin);
  if (origin.hostname !== "127.0.0.1" || origin.protocol !== "http:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) throw new FixtureRefusal("explicit loopback fixture origin required");
  const marker: unknown = JSON.parse(readFileSync(resolve(root, "owner.json"), "utf8"));
  if (!isRecord(marker) || marker.owner !== "task20_fixture" || marker.root !== root) throw new FixtureRefusal("task20 fixture ownership required");
  const sourceRoot = realpathSync(options.sourceRoot);
  if (sourceRoot !== options.sourceRoot) throw new FixtureRefusal("canonical native source root required");
  const sessions = new Map<string, { readonly abort: AbortController; references: number; readonly generation: number }>();
  let generation = 0;
  let disposed = false;
  const connections: DashboardConnectionProvider = {
    acquire(alias, signal) {
      if (disposed || signal?.aborted || !["hermes-fixture", "hermes-fixture-next"].includes(alias)) throw new FixtureRefusal("fixture connection refused");
      let session = sessions.get(alias);
      if (!session || session.abort.signal.aborted) { session = { abort: new AbortController(), references: 0, generation: ++generation }; sessions.set(alias, session); }
      const owned = session;
      owned.references += 1;
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        signal?.removeEventListener("abort", abort);
        owned.references -= 1;
        if (owned.references === 0) { owned.abort.abort(); if (sessions.get(alias) === owned) sessions.delete(alias); }
      };
      const abort = () => { void release(); };
      signal?.addEventListener("abort", abort, { once: true });
      return { ready: Promise.resolve({ alias, generation: owned.generation, baseUrl: origin.origin, signal: owned.abort.signal }), release };
    },
    async invalidate(alias) { sessions.get(alias)?.abort.abort(); sessions.delete(alias); },
    async dispose() { disposed = true; for (const session of sessions.values()) session.abort.abort(); sessions.clear(); },
  };
  const runPython = (program: string, data: string, signal?: AbortSignal, stdin?: string) => fixtureProcess(CONTROL_CENTER_PYTHON, ["-I", "-B", "-c", program, data], { root, ...(signal ? { signal } : {}), ...(stdin === undefined ? {} : { stdin }), timeoutMs: 20_000, maxBytes: 16_777_216 });
  return {
    connections,
    async location(connection, context) { context.signal?.throwIfAborted(); return { connection, root: `${root}/home`, sourceRoot }; },
    metadata(location) {
      return new ClosedProfileMetadataReader(location, async (request, signal) => {
        const scenario = scenarioAt(root);
        if (scenario === "delayed-profile" && request.profile === "xia" || scenario === "delay") await fixtureDelay(signal);
        if (scenario === "unavailable-skills" || scenario === "transport-loss") throw new FixtureRefusal("synthetic metadata unavailable");
        if (scenario === "malformed") return "{";
        const result = await runPython(PROFILE_METADATA_PYTHON, JSON.stringify(request), signal);
        if (result.exitCode !== 0 || result.capExceeded) throw new FixtureRefusal("metadata helper failed");
        return result.stdout;
      });
    },
    activity() {
      return new TaskActivityCollector(async (command, signal) => {
        const scenario = scenarioAt(root);
        if (scenario === "partial-activity" && command.request.board.board === "xia-dev") return { ok: false, reason: "missing-source" };
        if (scenario === "transport-loss") return { ok: false, reason: "transport-failure" };
        if (scenario === "delay") await fixtureDelay(signal);
        const request = command.request;
        const result = await runPython(TASK_ACTIVITY_PYTHON, JSON.stringify({ root: request.root, board: request.board.board, window: request.window, limits: ACTIVITY_LIMITS }), signal);
        return result.exitCode === 0 && !result.capExceeded ? { ok: true, stdout: result.stdout } : { ok: false, reason: "transport-failure" };
      });
    },
    adapter: new SshReadOnlyAdapter({ runner: async (_file, args, limits) => {
      const command = args.at(-1);
      const alias = args.at(-2);
      if (!command || !["hermes-fixture", "hermes-fixture-next"].includes(alias ?? "") || !command.includes(`${root}/home`)) throw new FixtureRefusal("fixture reader scope refused");
      if (scenarioAt(root) === "transport-loss") return { stdout: "", stderr: "synthetic unavailable", exitCode: 255, capExceeded: false };
      return fixtureProcess("/bin/sh", ["-c", command], { root, ...limits });
    } }),
    documents: new ProfileDocumentStore(undefined, undefined, async stdin => {
      const data: unknown = JSON.parse(stdin);
      if (!isRecord(data) || typeof data.home !== "string" || !(data.home === `${root}/home` || data.home.startsWith(`${root}/home/profiles/`))) throw new FixtureRefusal("fixture document scope refused");
      return runPython(REMOTE_DOCUMENT_SCRIPT, "", undefined, stdin);
    }),
  };
}
