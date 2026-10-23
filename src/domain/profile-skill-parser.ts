import type { ProfileSkillMetadata, SkillCandidate, SkillInspection } from "../types/profile-catalog";
import { serializeScopedKey } from "./control-center-validation";

const TIERS = { local: 1, create: 2, external: 3 } as const;
function winner(rows: readonly SkillCandidate[]): SkillCandidate | null {
  const tier = Math.min(...rows.map(row => TIERS[row.source]));
  const contenders = rows.filter(row => TIERS[row.source] === tier);
  const first = contenders[0];
  if (!first) return null;
  if (contenders.length === 1) return first;
  const sameRoot = contenders.every(row => row.root === first.root);
  const sameFile = contenders.every(row => row.canonicalPath === first.canonicalPath);
  const sameBytes = first.digest !== null && contenders.every(row => row.digest === first.digest);
  if (!sameRoot || !(sameFile || sameBytes)) return null;
  const rank = (row: SkillCandidate) => row.path.slice(row.root.length + 1).split("/").length;
  const ranked = [...contenders].sort((a, b) => rank(a) - rank(b));
  const best = ranked[0], second = ranked[1];
  return best && second && rank(best) < rank(second) ? best : null;
}

export function inspectProfileSkills(metadata: ProfileSkillMetadata, platform: string | null): readonly SkillInspection[] {
  const resolutionComplete = metadata.configuration.status === "read" && metadata.configuration.externalDirs.status === "read" && metadata.configuration.createDir.status === "read"
    && metadata.roots.every(root => root.status === "read") && metadata.candidates.every(row => row.metadataStatus === "read")
    && (metadata.coverage.kind === "complete" || metadata.coverage.kind === "incomplete" && metadata.coverage.reasons.every(reason => reason === "missing-attribution" || reason === "missing-source"));
  const owners = new Map<string, SkillCandidate[]>();
  for (const row of metadata.candidates) {
    if (row.name === null || row.metadataStatus !== "read") continue;
    const dirname = row.path.split("/").at(-2) ?? "";
    for (const alias of new Set([row.name, dirname, row.relativePath])) owners.set(alias, [...owners.get(alias) ?? [], row]);
  }
  const config = metadata.configuration;
  const global = config.disabled;
  const scoped = platform === null ? undefined : config.platformDisabled[platform];
  const globalKnown = config.status === "read" && global.status === "read";
  const platformKnown = platform !== null && config.status === "read" && config.platformStatus === "read" && (scoped === undefined || scoped.status === "read");
  return metadata.candidates.map(row => {
    let resolution: SkillInspection["resolution"] = "unknown";
    let loadName: string | null = null;
    if (row.name !== null && row.metadataStatus === "read" && resolutionComplete) {
      const choices = owners.get(row.name) ?? [];
      const selected = winner(choices);
      if (choices.some(other => TIERS[other.source] < TIERS[row.source]) || selected !== null && selected !== row) resolution = "shadowed";
      else if (selected === row) { resolution = "unique"; loadName = row.name; }
      else { resolution = "ambiguous"; loadName = winner(owners.get(row.relativePath) ?? []) === row ? row.relativePath : null; }
    }
    const matches = (names: readonly string[]) => names.some(name => name !== "hermes-agent" && (name === row.name || name === loadName));
    const configuredGlobal = row.name === null || row.metadataStatus !== "read" || !globalKnown ? "unknown" : matches(global.values) ? "disabled" : resolution === "unknown" && global.values.length > 0 ? "unknown" : "enabled";
    const configuredPlatform = configuredGlobal === "disabled" ? "disabled" : !platformKnown ? "unknown" : matches(scoped?.values ?? []) ? "disabled" : configuredGlobal === "unknown" || resolution === "unknown" && (scoped?.values.length ?? 0) > 0 ? "unknown" : "enabled";
    const os = row.restrictions["platforms"];
    const compatible = os?.values.some(value => {
      const normalized = value.trim().toLowerCase();
      const mapped = normalized === "macos" ? "darwin" : normalized === "windows" ? "win32" : normalized;
      return metadata.hostPlatform.startsWith(mapped);
    });
    return { ...row, identity: JSON.stringify([serializeScopedKey(metadata.profile), row.source, row.root, row.path, row.canonicalPath, row.declaredName]), resolution, loadName,
      configuredGlobal, configuredPlatform, osCompatibility: row.metadataStatus !== "read" || os?.status !== "read" ? "unknown" : os.values.length === 0 || compatible ? "compatible" : "restricted", effective: "unknown" };
  });
}
