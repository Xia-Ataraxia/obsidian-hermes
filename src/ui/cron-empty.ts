import { emptyBox } from "../hermes/ui";
import type { ViewerState } from "./viewer-state";

export interface CronViewActions {
  readonly openSettings: () => void;
  readonly refresh: () => void;
}

/** True once any source has been read; a source that failed before its first good read yields an empty snapshot. */
export function hasSchedule(state: ViewerState): boolean {
  return state.getSnapshots().some(snapshot => snapshot.jobs.length > 0 || snapshot.transport === "connected");
}

/** Draws why a cron view has nothing to show, each case with its one next step. False when there is content. */
export function renderCronEmpty(root: HTMLElement, state: ViewerState, actions: CronViewActions): boolean {
  const settings = state.getSettings();
  const box = (iconName: string, text: string, action?: string, onAction?: () => void, detail?: string): true => {
    emptyBox(root, iconName, text, action, onAction, detail, "hcv-empty-state").querySelector("button")?.addClass("mod-cta");
    return true;
  };
  if (settings.servers.length === 0) return box("server", "Add an SSH host to see its cron schedules", "Open settings", actions.openSettings);
  if (settings.selectedSources.length === 0) return box("calendar-clock", "Pick a profile to see its cron schedule", "Open settings", actions.openSettings);
  if (!hasSchedule(state)) {
    if (state.isRefreshing()) return box("loader", "Loading schedules…");
    const failed = state.getSnapshots()[0];
    if (failed) return box("wifi-off", "Can't reach Hermes", "Retry", actions.refresh, failed.statusDetail ?? `${failed.source.alias}: ${failed.transport}`);
    return box("calendar-clock", "No schedule loaded yet", "Refresh", actions.refresh);
  }
  if (state.filteredSnapshots().length === 0) return box("filter-x", "No profiles match this filter", "Clear filter", () => state.setFilter({ alias: null, profileId: null, text: "" }));
  return false;
}
