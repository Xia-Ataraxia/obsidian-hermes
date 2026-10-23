import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseControlCenterToken } from "../domain/control-center-validation";
import { CONTROL_CENTER_LOCATION_PYTHON } from "../domain/control-center-location-python";
import { posixSingleQuote } from "../domain/posix-single-quote";
import type { ControlCenterDependencies } from "../types/control-center-composition";
import { ProfileCatalogError } from "../types/profile-catalog";
import { DashboardSshTunnel } from "./dashboard-ssh-tunnel";
import { authenticatedDashboardProbe } from "./dashboard-client";
import { parseDashboardJson, requireObject } from "./dashboard-response";
import { ClosedProfileMetadataReader } from "./profile-metadata-reader";
import { TaskActivityCollector } from "./task-activity-collector";
import type { SshReadOnlyAdapter } from "./ssh-read-only-adapter";
import { DashboardClientError } from "../types/dashboard-client";
import { nativeDefaultProfileRoot } from "../domain/control-center-native-root";

export function controlCenterDependencies(adapter: SshReadOnlyAdapter): ControlCenterDependencies {
  return {
    connections: new DashboardSshTunnel(authenticatedDashboardProbe), adapter,
    metadata: location => new ClosedProfileMetadataReader(location),
    activity: () => new TaskActivityCollector(),
    location: async (connection, context, client) => {
      let root: string;
      try { root = nativeDefaultProfileRoot(await client.profileLocations(context)); }
      catch (error) {
        if (error instanceof DashboardClientError && (error.code === "cancelled" || error.code === "stale-generation")) throw new ProfileCatalogError("aborted");
        if (error instanceof DashboardClientError) throw new ProfileCatalogError("read-failed");
        throw error;
      }
      const program = `import base64;exec(base64.b64decode('${Buffer.from(CONTROL_CENTER_LOCATION_PYTHON).toString("base64")}'))`;
      const remote = ["python3", "-I", "-B", "-c", program].map(posixSingleQuote).join(" ");
      let stdout: string;
      try {
        ({ stdout } = await promisify(execFile)("ssh", ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "RequestTTY=no", "-o", "ConnectTimeout=10", "--", connection, remote], { signal: context.signal, timeout: 15_000, maxBuffer: 4096 }));
      } catch (error) {
        if (context.signal?.aborted) throw new ProfileCatalogError("aborted");
        if (error instanceof Error && ("code" in error || "killed" in error)) throw new ProfileCatalogError("read-failed");
        throw error;
      }
      if (context.signal?.aborted || context.isCurrent?.() === false) throw new ProfileCatalogError("aborted");
      let value;
      try { value = requireObject(parseDashboardJson(stdout)); }
      catch (error) { if (error instanceof DashboardClientError) throw new ProfileCatalogError("read-failed"); throw error; }
      const sourceRoot = parseControlCenterToken("path", value.sourceRoot);
      if (!sourceRoot.ok) throw new ProfileCatalogError("read-failed");
      return { connection, root, sourceRoot: sourceRoot.value };
    },
  };
}
