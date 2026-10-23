import type { ProfileRef, SourceKey } from "../types/hermes-cron";
import { decodeSourceKey } from "../types/snapshot";
import { profileHome } from "./profile-candidate-paths";

export function selectedProfileRefs(sources: readonly string[], homes: ReadonlyMap<string, string>): readonly ProfileRef[] {
  const profiles: ProfileRef[] = [];
  for (const encoded of sources) {
    const key = decodeSourceKey(encoded);
    const remoteHome = homes.get(key.alias);
    if (remoteHome !== undefined) profiles.push({ alias: key.alias, profileId: key.profileId, home: profileHome(remoteHome, key.profileId) });
  }
  return profiles;
}

export function selectedProfileFor(sources: readonly string[], homes: ReadonlyMap<string, string>, key: SourceKey): ProfileRef | undefined {
  return selectedProfileRefs(sources, homes).find(profile => profile.alias === key.alias && profile.profileId === key.profileId);
}
