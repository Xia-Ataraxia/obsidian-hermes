import { spawn } from "node:child_process";
import { parseControlCenterToken, parseScopedIdentity } from "../domain/control-center-validation";
import { posixSingleQuote } from "../domain/posix-single-quote";
import { PROFILE_METADATA_PYTHON } from "../domain/profile-metadata-python";
import { parseProfileMetadata } from "../domain/profile-metadata-response";
import type { ProfileKey } from "../types/control-center";
import type { DashboardRequestContext } from "../types/dashboard-client";
import { PROFILE_LIMITS, ProfileCatalogError } from "../types/profile-catalog";
import type { ProfileMetadataReader, ProfileSkillMetadata } from "../types/profile-catalog";

export type ProfileMetadataLocation = { readonly connection: string; readonly root: string; readonly sourceRoot: string };
export type ProfileMetadataRequest = ProfileMetadataLocation & { readonly profile: string; readonly limits: typeof PROFILE_LIMITS };
export type ProfileMetadataExecutor = (request: ProfileMetadataRequest, signal: AbortSignal) => Promise<string>;

export function buildProfileMetadataCommand(request: ProfileMetadataRequest): readonly string[] {
  const encoded = Buffer.from(PROFILE_METADATA_PYTHON).toString("base64");
  const program = `import base64;exec(base64.b64decode('${encoded}'))`;
  const remote = [`${request.sourceRoot}/.venv/bin/python`, "-I", "-B", "-c", program, JSON.stringify(request)].map(posixSingleQuote).join(" ");
  return ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "RequestTTY=no", "-o", "ConnectTimeout=10", "--", request.connection, remote];
}

export const executeProfileMetadata: ProfileMetadataExecutor = (request, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new ProfileCatalogError("aborted")); return; }
  const child = spawn("ssh", [...buildProfileMetadataCommand(request)], { stdio: ["ignore", "pipe", "ignore"] });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let failure: ProfileCatalogError | null = null;
  const stop = (code: "aborted" | "read-failed") => { failure ??= new ProfileCatalogError(code); child.kill("SIGKILL"); };
  const abort = () => stop("aborted");
  const timer = setTimeout(() => stop("read-failed"), PROFILE_LIMITS.deadlineMs + 12_000);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > PROFILE_LIMITS.outputBytes) stop("read-failed");
    else if (failure === null) chunks.push(chunk);
  });
  child.on("error", () => { failure ??= new ProfileCatalogError("read-failed"); });
  child.on("close", code => {
    clearTimeout(timer); signal.removeEventListener("abort", abort);
    if (failure !== null) reject(failure);
    else if (code !== 0) reject(new ProfileCatalogError("read-failed"));
    else resolve(Buffer.concat(chunks).toString("utf8"));
  });
});

export class ClosedProfileMetadataReader implements ProfileMetadataReader {
  private readonly location: ProfileMetadataLocation;
  constructor(location: ProfileMetadataLocation, private readonly execute: ProfileMetadataExecutor = executeProfileMetadata) {
    const connection = parseControlCenterToken("connection", location.connection);
    const root = parseControlCenterToken("path", location.root);
    const sourceRoot = parseControlCenterToken("path", location.sourceRoot);
    if (!connection.ok || !root.ok || !sourceRoot.ok || [root.value, sourceRoot.value].some(path => path === "/" || path.endsWith("/"))) throw new ProfileCatalogError("invalid-scope");
    this.location = Object.freeze({ connection: connection.value, root: root.value, sourceRoot: sourceRoot.value });
  }
  async read(requested: ProfileKey, context: DashboardRequestContext): Promise<ProfileSkillMetadata> {
    const parsed = parseScopedIdentity(requested);
    if (!parsed.ok || parsed.value.kind !== "profile") throw new ProfileCatalogError("invalid-scope");
    const profile = parsed.value;
    if (profile.connection !== this.location.connection || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile.profile) || profile.profile === "all") throw new ProfileCatalogError("invalid-scope");
    const signal = context.signal ?? new AbortController().signal;
    if (signal.aborted) throw new ProfileCatalogError("aborted");
    if (context.isCurrent?.() === false) throw new ProfileCatalogError("stale");
    const payload = await this.execute({ ...this.location, profile: profile.profile, limits: PROFILE_LIMITS }, signal);
    if (signal.aborted) throw new ProfileCatalogError("aborted");
    if (context.isCurrent?.() === false) throw new ProfileCatalogError("stale");
    return parseProfileMetadata(payload, profile);
  }
}
