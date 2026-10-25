import type { SettingDefinitionItem } from "obsidian";
import type { ProfileRef } from "../types/hermes-cron";
import type { ProfileSectionOptions } from "../types/contracts";

/** One group per server that has profiles, listing its profile rows. Empty when nothing is known yet. */
export function profileDefinitions(options: ProfileSectionOptions): SettingDefinitionItem[] {
  const groups: SettingDefinitionItem[] = [];
  for (const alias of options.sources.servers) {
    const profiles = profilesOf(alias, options.sources);
    if (profiles.length === 0) continue;
    groups.push({
      type: "group",
      heading: alias,
      items: profiles.map((profile) => ({
        name: profile.profileId,
        desc: profile.home,
        render: (setting) => {
          setting.addToggle((toggle) =>
            toggle
              .setValue(options.isSelected(profile))
              .setTooltip("Show this profile in the viewer")
              .onChange((value) => void options.onToggle(profile, value)),
          );
        },
      })),
    });
  }
  return groups;
}

/**
 * Profiles known for one server: previously selected sources and restored snapshots merged with
 * this session's discovery, so reopening settings is never blank. Nothing is selected here.
 */
function profilesOf(
  alias: string,
  sources: ProfileSectionOptions["sources"],
): readonly ProfileRef[] {
  const byId = new Map<string, ProfileRef>();
  for (const profile of sources.known) {
    if (profile.alias === alias) byId.set(profile.profileId, profile);
  }
  for (const profile of sources.discovered.get(alias) ?? []) byId.set(profile.profileId, profile);
  return [...byId.values()].sort((a, b) => a.profileId.localeCompare(b.profileId));
}
