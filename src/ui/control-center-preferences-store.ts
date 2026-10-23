import { PREFERENCE_LIMITS, projectControlCenterPreferences, readPreferenceEnvelope } from "../domain/control-center-preferences";
import { parseControlCenterToken } from "../domain/control-center-validation";
import type { ConnectionId } from "../types/control-center";
import type { PreferencesRead } from "../types/control-center-preferences";
import { PreferencesSaveError } from "../types/control-center-preferences";
import type { PluginDataGateway } from "./plugin-data-gateway";

/** Every operation shares the existing gateway queue with settings and snapshot updates. */
export class ControlCenterPreferencesStore {
  constructor(private readonly gateway: PluginDataGateway) {}

  /** Capture scope now, never consult mutable active-target state after awaiting. */
  bind(connection: ConnectionId) {
    const parsed = parseControlCenterToken("connection", connection);
    if (!parsed.ok) throw new PreferencesSaveError("invalid-connection");
    const captured = parsed.value;
    let active = true;
    const requireActive = (): void => {
      if (!active) throw new PreferencesSaveError("disposed");
    };
    return {
      load: async (): Promise<PreferencesRead> => {
        requireActive();
        const data = await this.gateway.read<Record<string, unknown>>();
        requireActive();
        const envelope = readPreferenceEnvelope(data.controlCenterPreferences);
        return {
          status: envelope === null ? "unsupported-version" : "ready",
          preferences: envelope?.connections.find((entry) => entry.connection === captured)?.preferences
            ?? projectControlCenterPreferences(undefined),
        };
      },
      save: async (value: unknown): Promise<void> => {
        requireActive();
        const preferences = projectControlCenterPreferences(value);
        await this.gateway.update<Record<string, unknown>>((data) => {
          requireActive();
          const envelope = readPreferenceEnvelope(data.controlCenterPreferences);
          if (envelope === null) throw new PreferencesSaveError("unsupported-version");
          const retained = envelope.connections.filter((entry) => entry.connection !== captured);
          return { ...data, controlCenterPreferences: {
            version: 1,
            connections: [...retained.slice(-(PREFERENCE_LIMITS.connections - 1)), { connection: captured, preferences }],
          } };
        });
      },
      dispose: (): void => { active = false; },
    };
  }

  /** The target owner disposes its bindings before removing a known replaced connection. */
  async remove(connection: ConnectionId): Promise<void> {
    const parsed = parseControlCenterToken("connection", connection);
    if (!parsed.ok) throw new PreferencesSaveError("invalid-connection");
    const captured = parsed.value;
    await this.gateway.update<Record<string, unknown>>((data) => {
      const envelope = readPreferenceEnvelope(data.controlCenterPreferences);
      if (envelope === null) throw new PreferencesSaveError("unsupported-version");
      return { ...data, controlCenterPreferences: {
        version: 1, connections: envelope.connections.filter((entry) => entry.connection !== captured),
      } };
    });
  }
}
