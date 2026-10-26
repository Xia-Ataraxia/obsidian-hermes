import type { SettingDefinition } from "obsidian";
import { checkAlias } from "../domain/remote-token-validator";
import type { ServerSectionOptions } from "../types/contracts";

/**
 * Definitions for the connection section: the add row, then one row per registered SSH target.
 *
 * Kept apart from the settings tab so each server's row (open Kanban or Profiles, edit, check, remove) exists once:
 * Obsidian keys setting rows by name, so a second row per alias would collide.
 * Every action is a callback; this module owns no state and performs no persistence.
 */
export function serverDefinitions(options: ServerSectionOptions): SettingDefinition[] {
  const rows = options.servers.map((alias) => serverRow(alias, options));
  if (rows.length === 0) rows.push({ name: "No SSH hosts yet", desc: "Add a host alias above to see its schedules, kanban and profiles." });
  return [addRow(options), ...rows];
}

function addRow(options: ServerSectionOptions): SettingDefinition {
  return {
    name: "Add SSH host alias",
    desc: "A host alias from your SSH config, with key authentication already set up.",
    render: (setting) => {
      let pending = "";
      const add = (): void => {
        if (pending === "") return;
        const rejection = !checkAlias(pending).ok
          ? "Use 1-64 characters: letters, digits, dot, underscore or hyphen."
          : options.servers.includes(pending)
            ? "That SSH host alias is already registered."
            : null;
        if (rejection !== null) {
          setting.setDesc(rejection);
          setting.descEl.addClass("hcv-setting-error");
          return;
        }
        options.onAdd(pending);
      };
      setting
        .addText((text) => {
          text.setPlaceholder("SSH alias").onChange((value) => {
            pending = value.trim();
          });
          text.inputEl.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && !event.isComposing) add();
          });
        })
        .addExtraButton((button) => button.setIcon("plus").setTooltip("Add server").onClick(add));
    },
  };
}

function serverRow(alias: string, options: ServerSectionOptions): SettingDefinition {
  return {
    name: alias,
    render: (setting) => {
      const status = options.statusOf(alias);
      const busy = options.isBusy(alias);
      setting.setDesc(status.text);
      setting.descEl.toggleClass("hcv-setting-error", status.failed);
      setting
        .addExtraButton((button) =>
          button.setIcon("square-kanban").setTooltip("Kanban").onClick(() => options.onKanban(alias)),
        )
        .addExtraButton((button) =>
          button.setIcon("network").setTooltip("Profiles").onClick(() => options.onProfiles(alias)),
        )
        .addExtraButton((button) =>
          button
            .setIcon("pencil")
            .setTooltip("Edit connection target")
            .setDisabled(busy)
            .onClick(() => options.onEdit(alias)),
        )
        .addExtraButton((button) => {
          button
            .setIcon(busy ? "loader" : "plug")
            .setTooltip(busy ? "Checking connection" : "Check connection and list profiles")
            .setDisabled(busy)
            .onClick(() => options.onCheck(alias));
          button.extraSettingsEl.toggleClass("hm-spinning", busy);
        })
        .addExtraButton((button) =>
          button.setIcon("trash").setTooltip("Remove server").onClick(() => options.onRemove(alias)),
        );
    },
  };
}
