import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardConnectionError } from "../types/dashboard-connection";

export const DASHBOARD_SSH_OPTIONS = [
  "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
  "-o", "ExitOnForwardFailure=yes", "-o", "PermitLocalCommand=no",
  "-o", "RequestTTY=no", "-o", "ConnectTimeout=15",
  "-o", "ControlMaster=no", "-o", "ControlPath=none",
  "-o", "ForkAfterAuthentication=no", "-o", "RemoteCommand=none",
  "-o", "ClearAllForwardings=no",
] as const;

export interface DashboardTunnelConfig {
  readonly path: string;
  remove(): Promise<void>;
}

export async function dashboardTunnelConfig(alias: string, signal: AbortSignal): Promise<DashboardTunnelConfig> {
  const resolved = await new Promise<string>((resolve, reject) => {
    execFile("ssh", ["-G", ...DASHBOARD_SSH_OPTIONS, "--", alias],
      { signal, timeout: 15_000, maxBuffer: 256 * 1024, encoding: "utf8" }, (error, stdout) => {
        if (error) reject(new DashboardConnectionError("config"));
        else resolve(stdout);
      });
  });
  return writeDashboardTunnelConfig(resolved, signal);
}

export async function writeDashboardTunnelConfig(resolved: string, signal: AbortSignal): Promise<DashboardTunnelConfig> {
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "hermes-dashboard-ssh-"));
  const path = join(directory, "config");
  const remove = (): Promise<void> => rm(directory, { recursive: true, force: true });
  try {
    const config = resolved.split("\n").filter((line) =>
      !/^(localforward|remoteforward|dynamicforward|clearallforwardings)\s/i.test(line)).join("\n");
    await writeFile(path, config, { mode: 0o600 });
    signal.throwIfAborted();
    return { path, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}
