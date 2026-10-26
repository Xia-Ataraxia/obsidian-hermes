import { PluginSettingTab, type App, type Setting, type SettingDefinitionItem, type SettingGroupItem } from "obsidian";
import type { ProfileRef } from "../types/hermes-cron";
import type { ProfileSectionOptions } from "../types/contracts";
import type { TransportStatus } from "../types/remote-command";
import { encodeSourceKey, type EdgeMode } from "../types/snapshot";
import type HermesCronViewerPlugin from "../main";
import { notify } from "./notices";
import { ConnectionTargetModal } from "./connection-target-modal";
import { discoverProfiles } from "./profile-discovery-runner";
import { profileDefinitions } from "./profile-settings-section";
import { serverDefinitions } from "./server-settings-section";
import { KANBAN_VIEW } from "../hermes/kanban-view";
import { EDGE_MODES } from "../hermes/profiles-common";
import { PROFILES_VIEW } from "../hermes/profiles-view";
import { hue } from "../hermes/geometry";

/** Actionable reason per transport failure, so the user knows what to fix outside Obsidian. */
const TRANSPORT_DETAIL: Record<TransportStatus, string> = {
  connected: "Connected.",
  disconnected: "Could not connect. Check that ssh {alias} works in a terminal.",
  "auth-failed": "Key authentication failed. Check your SSH agent and the remote authorized key.",
  "host-key-unknown": "Host key not verified. Connect once in a terminal to record it in known_hosts.",
  timeout: "Connection timed out. Check the network and the SSH alias.",
  "config-incompatible-shell": "The remote login shell is not compatible with safe read-only commands.",
  "command-missing": "A required command is missing on the remote host. Check the Hermes installation.",
  "proxy-failed": "SSH proxy connection failed. Check ProxyJump or ProxyCommand.",
};

function keyOf(profile: ProfileRef): string {
  return encodeSourceKey({ alias: profile.alias, profileId: profile.profileId });
}

/** Server registration, profile selection and viewer limits. No secrets are stored here. */
export class HermesCronSettingsTab extends PluginSettingTab {
  private discovered = new Map<string, readonly ProfileRef[]>();
  private status = new Map<string, { text: string; failed: boolean }>();
  private pending = new Set<string>();

  constructor(app: App, private readonly plugin: HermesCronViewerPlugin) {
    super(app, plugin);
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const ids = this.plugin.profileIds();
    const profiles = profileDefinitions(this.profileOptions());
    return [
      {
        type: "group",
        heading: "Connections",
        items: [
          { name: "What Hermes changes", desc: "Cron jobs are read-only. Kanban tasks and profile documents change only when you ask." },
          {
            name: "SSH requirements",
            desc: "Uses your existing ~/.ssh/config aliases with key authentication only; no password is stored. The host key must already be in known_hosts.",
          },
          ...serverDefinitions({
            servers: this.plugin.settings.servers,
            statusOf: (alias) => this.status.get(alias) ?? { text: "Connection not checked yet.", failed: false },
            isBusy: (alias) => this.pending.has(alias),
            onAdd: (alias) => void this.addServer(alias),
            onEdit: (alias) => this.editTarget(alias),
            onCheck: (alias) => void this.checkConnection(alias),
            onRemove: (alias) => void this.removeServer(alias),
            onKanban: (alias) => void this.plugin.openHermes(KANBAN_VIEW, alias),
            onProfiles: (alias) => void this.plugin.openHermes(PROFILES_VIEW, alias),
          }),
        ],
      },
      { type: "group", heading: "Profiles", items: profiles.length === 0 ? [{ name: "No profiles yet", desc: "Check a server to list its profiles." }] : [] },
      ...profiles,
      {
        type: "group",
        heading: "Profiles canvas",
        items: [{
          name: "Edges",
          desc: "What a line between two profiles counts, last 30 days.",
          control: {
            type: "dropdown",
            key: "edgeMode",
            options: Object.fromEntries(EDGE_MODES.map(([mode, , label]) => [mode, label])),
          },
        }],
      },
      {
        type: "group",
        heading: "Profile colors",
        visible: ids.length > 0,
        items: ids.map((id) => ({
          name: id,
          render: (setting: Setting) => {
            setting
              .addColorPicker(picker => picker
                .setValueHsl({ h: Math.round(hue(id)), s: 68, l: 56 })
                .onChange(() => this.plugin.setHue(id, picker.getValueHsl().h)))
              .addExtraButton(button => button.setIcon("rotate-ccw").setTooltip("Reset").onClick(() => {
                this.plugin.setHue(id, null);
                this.update();
              }));
          },
        })),
      },
      {
        type: "group",
        heading: "Kanban",
        items: [{
          name: "Notify when a task gets stuck",
          desc: "Blocked, sent to triage after repeated blocks, gave up, crashed or timed out. Checked every minute.",
          control: { type: "toggle", key: "kanbanNotify" },
        }],
      },
      { type: "group", heading: "Storage", items: this.storageDefinitions() },
    ];
  }

  override getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === "edgeMode") this.plugin.setEdgeMode(value as EdgeMode);
    else await this.plugin.saveSettings({ ...this.plugin.settings, [key]: value });
  }

  private async addServer(alias: string): Promise<void> {
    const settings = this.plugin.settings;
    await this.plugin.saveSettings({ ...settings, servers: [...settings.servers, alias] });
    await this.checkConnection(alias);
  }

  /** Opens the target editor; nothing changes until the user presses Save inside the modal. */
  private editTarget(alias: string): void {
    if (this.pending.has(alias)) return;
    new ConnectionTargetModal(
      this.app,
      alias,
      (target) => this.plugin.replaceServerTarget(alias, target),
      () => { this.forgetLocalRow(alias); for (const next of this.plugin.settings.servers) if (!this.discovered.has(next)) void this.checkConnection(next); },
    ).open();
  }

  /** Discovery results and the status line belong to the old target only. */
  private forgetLocalRow(alias: string): void {
    this.discovered.delete(alias);
    this.status.delete(alias);
    this.update();
  }

  private async checkConnection(alias: string): Promise<void> {
    if (this.pending.has(alias)) return;
    const generation = this.plugin.targets.generation(alias);
    this.pending.add(alias);
    this.status.set(alias, { text: "Checking connection…", failed: false });
    this.update();
    try {
      const result = await discoverProfiles(this.plugin.adapter, alias);
      if (!this.plugin.settings.servers.includes(alias) || generation !== this.plugin.targets.generation(alias)) return;
      if (result.transport !== "connected") {
        this.status.set(alias, { text: TRANSPORT_DETAIL[result.transport].replace("{alias}", alias), failed: true });
        return;
      }
      this.discovered.set(alias, result.profiles);
      this.status.set(alias, { text: `Connected. ${result.profiles.length === 1 ? "1 profile" : `${result.profiles.length} profiles`} found.`, failed: false });
      // rememberRemoteHome also seeds the in-memory state, so selected sources rebuild offline.
      this.plugin.rememberRemoteHome(alias, result.profiles[0]?.home.replace(/\/\.hermes$/, "") ?? "");
    } catch {
      if (generation === this.plugin.targets.generation(alias) && this.plugin.settings.servers.includes(alias)) this.status.set(alias, { text: `Connection check failed. Check that ssh ${alias} works in a terminal.`, failed: true });
    } finally {
      this.pending.delete(alias);
      this.update();
    }
  }

  private async removeServer(alias: string): Promise<void> {
    if (!(await this.plugin.targets.remove(alias)).ok) return;
    this.discovered.delete(alias);
    this.status.delete(alias);
    this.update();
  }

  private profileOptions(): ProfileSectionOptions {
    return {
      sources: {
        servers: this.plugin.settings.servers,
        known: this.knownProfiles(),
        discovered: this.discovered,
      },
      isSelected: (profile) => this.plugin.settings.selectedSources.includes(keyOf(profile)),
      onToggle: (profile, selected) => this.toggleProfile(profile, selected),
    };
  }

  /** Selected sources and restored snapshots, so known profiles survive a settings reopen. */
  private knownProfiles(): readonly ProfileRef[] {
    const restored = this.plugin.state.getSnapshots().map((snapshot) => ({
      alias: snapshot.source.alias,
      profileId: snapshot.source.profileId,
      home: snapshot.home,
    }));
    return [...restored, ...this.plugin.state.selectedProfiles()];
  }

  private async toggleProfile(profile: ProfileRef, selected: boolean): Promise<void> {
    const key = keyOf(profile);
    const current = this.plugin.settings.selectedSources;
    const next = selected ? [...new Set([...current, key])] : current.filter((c) => c !== key);
    await this.plugin.saveSettings({ ...this.plugin.settings, selectedSources: next });
    if (!selected) await this.plugin.dropCachedSource(key);
    this.plugin.scheduler.trigger();
  }

  private storageDefinitions(): SettingGroupItem[] {
    return [
      {
        name: "Store job names on disk",
        desc: "Job names may echo prompt text. When off, only job ids are written to disk.",
        control: { type: "toggle", key: "persistJobNames" },
      },
      {
        name: "History rows per query",
        desc: "Execution rows fetched per source in one round (1-200).",
        render: (setting) => {
          setting.addText((text) =>
            text.setValue(String(this.plugin.settings.historyLimit)).onChange(async (value) => {
              const parsed = Number.parseInt(value, 10);
              if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) return;
              await this.plugin.saveSettings({ ...this.plugin.settings, historyLimit: parsed });
            }),
          );
        },
      },
      {
        name: "Cached data",
        desc: "Last-seen schedules, kanban boards (titles, no task text), profiles, skill and plugin rows and the chat profile list, stored in the vault config folder where they may sync. Nothing is cached while the job names switch above is off. Chat messages, session titles, task bodies, job prompts, memory and skill files and secrets are never written to disk.",
        render: (setting) => {
          setting.addExtraButton((button) =>
            button.setIcon("eraser").setTooltip("Clear cache").onClick(async () => {
              await this.plugin.clearCache();
              notify("Cached data cleared.");
            }),
          );
        },
      },
    ];
  }
}
