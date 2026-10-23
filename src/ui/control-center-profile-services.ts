import type { App } from "obsidian";
import { parseControlCenterToken } from "../domain/control-center-validation";
import type { BoardKey, TaskKey } from "../types/control-center";
import type { ControlCenterDependencies } from "../types/control-center-composition";
import { DashboardClientError } from "../types/dashboard-client";
import type { ProfilesCanvasServices } from "../types/profiles-canvas";
import type { ControlCenterConnection } from "./control-center-connections";
import type { ControlCenterPreferencesStore } from "./control-center-preferences-store";
import { ProfileCatalogReader } from "./profile-catalog-reader";
import { mountProfileInspector } from "./profile-inspector";
import { requireObject } from "./dashboard-response";

export async function createControlCenterProfileServices(
  app: App, scope: ControlCenterConnection, dependencies: ControlCenterDependencies,
  preferences: ControlCenterPreferencesStore, openTask: (task: TaskKey) => Promise<void>,
) {
  const binding = preferences.bind(scope.connection);
  const catalog = new ProfileCatalogReader(scope.connection, scope.client, scope.metadata);
  const dispose = (): void => { binding.dispose(); catalog.dispose(); };
  try {
    const saved = await binding.load();
    const services: ProfilesCanvasServices = {
      state: scope.state,
      preferences: saved.preferences,
      savePreferences: binding.save,
      loadRoster: context => catalog.roster(context),
      loadBoards: async context => {
        const data = await scope.client.read({ route: "GET /boards" }, context);
        if (!Array.isArray(data.boards)) throw new DashboardClientError("malformed-response");
        return data.boards.map(value => {
          const board = parseControlCenterToken("board", requireObject(value).slug);
          if (!board.ok) throw new DashboardClientError("malformed-response");
          return { kind: "board", connection: scope.connection, board: board.value } satisfies BoardKey;
        });
      },
      loadActivity: async (board, window, context) => {
        const location = await scope.resolveLocation(context);
        if (location === null) throw new DashboardClientError("transport", 0, "Native activity location unavailable");
        const result = await scope.activity.read({ connection: board.connection, board: board.board, root: location.root, end: window.end, preset: window.preset }, context.signal ?? new AbortController().signal);
        if (!result.ok) throw new DashboardClientError("malformed-response");
        return result.value;
      },
      loadConfiguration: async context => {
        const data = await scope.client.read({ route: "GET /orchestration" }, context);
        const profile = parseControlCenterToken("profile", data.orchestrator_profile);
        if (!profile.ok || profile.value === "all") return { kind: "unknown" };
        return { kind: "configured", profile: { kind: "profile", connection: scope.connection, profile: profile.value }, source: "GET /orchestration" };
      },
      mountInspector: (container, onClose) => mountProfileInspector(container, {
        app, connection: scope.connection, state: scope.state, adapter: dependencies.adapter, onClose,
        ...(dependencies.documents ? { documents: dependencies.documents } : {}),
      }),
      openTask,
    };
    return { services, dispose, status: saved.status };
  } catch (error) { dispose(); throw error; }
}
