import { parseControlCenterToken } from "./control-center-validation";
import type { DashboardObject } from "../types/dashboard-client";
import { ProfileCatalogError } from "../types/profile-catalog";

export function nativeDefaultProfileRoot(data: DashboardObject): string {
  const entries = data.profiles;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 1000) throw new ProfileCatalogError("read-failed");
  const names = new Set<string>();
  let root: string | null = null;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new ProfileCatalogError("read-failed");
    const name = parseControlCenterToken("profile", entry.name), path = parseControlCenterToken("path", entry.path);
    if (!name.ok || !path.ok || names.has(name.value) || typeof entry.is_default !== "boolean") throw new ProfileCatalogError("read-failed");
    names.add(name.value);
    if (entry.is_default) {
      if (root !== null || name.value !== "default") throw new ProfileCatalogError("read-failed");
      root = path.value;
    }
  }
  if (root === null) throw new ProfileCatalogError("read-failed");
  return root;
}
