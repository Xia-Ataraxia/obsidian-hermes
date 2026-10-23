import { DashboardClientError } from "../types/dashboard-client";
import type { DashboardJson, DashboardObject, DashboardTask, DashboardEventBatch, DashboardEvent, DashboardSkill, DashboardSkillContent } from "../types/dashboard-client";

export function object(value: DashboardJson): value is DashboardObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function jsonValue(value: unknown, depth: number): DashboardJson {
  if (depth > 32) throw new DashboardClientError("malformed-response");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map((entry: unknown) => jsonValue(entry, depth + 1)));
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).map(([key, entry]: [string, unknown]): [string, DashboardJson] => [key, jsonValue(entry, depth + 1)]);
    return Object.freeze(Object.fromEntries(entries));
  }
  throw new DashboardClientError("malformed-response");
}
export function parseDashboardJson(text: string): DashboardJson {
  try { const value: unknown = JSON.parse(text); return jsonValue(value, 0); }
  catch (error) { if (error instanceof SyntaxError) throw new DashboardClientError("malformed-response"); throw error; }
}
export function requireObject(value: DashboardJson): DashboardObject {
  if (!object(value)) throw new DashboardClientError("malformed-response");
  return value;
}
export function parseDashboardTask(value: DashboardJson): DashboardTask {
  const task = requireObject(requireObject(value)["task"] ?? null);
  if (typeof task["id"] !== "string" || typeof task["title"] !== "string" || typeof task["status"] !== "string" || !(task["assignee"] === null || typeof task["assignee"] === "string")) throw new DashboardClientError("malformed-response");
  return { ...task, id: task["id"], title: task["title"], status: task["status"], assignee: task["assignee"] };
}
export function parseDashboardEvents(text: string): DashboardEventBatch {
  const batch = requireObject(parseDashboardJson(text));
  if (!Array.isArray(batch["events"]) || !Number.isSafeInteger(batch["cursor"]) || typeof batch["cursor"] !== "number" || batch["cursor"] < 0 || batch["events"].length > 200) throw new DashboardClientError("malformed-response");
  const events: DashboardEvent[] = batch["events"].map((raw: DashboardJson) => {
    const event = requireObject(raw);
    const id = event["id"], task = event["task_id"], run = event["run_id"], kind = event["kind"], created = event["created_at"];
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || !(task === null || typeof task === "string") || !(run === null || typeof run === "number" && Number.isSafeInteger(run)) || typeof kind !== "string" || typeof created !== "number") throw new DashboardClientError("malformed-response");
    return { id, task_id: task, run_id: run, kind, payload: event["payload"] ?? null, created_at: created };
  });
  const cursor = batch["cursor"];
  if (events.some((event, index) => event.id > cursor || index > 0 && event.id <= (events[index - 1]?.id ?? 0))) throw new DashboardClientError("malformed-response");
  return { events, cursor };
}
export function parseSkills(value: DashboardJson): readonly DashboardSkill[] {
  if (!Array.isArray(value)) throw new DashboardClientError("malformed-response");
  return value.map((raw: DashboardJson) => {
    const skill = requireObject(raw);
    const name = skill["name"], description = skill["description"], category = skill["category"], enabled = skill["enabled"], usage = skill["usage"], provenance = skill["provenance"];
    if (typeof name !== "string" || typeof description !== "string" || !(category === null || typeof category === "string") || typeof enabled !== "boolean" || typeof usage !== "number" || !["hub", "bundled", "external", "agent"].includes(String(provenance))) throw new DashboardClientError("malformed-response");
    switch (provenance) {
      case "hub": case "bundled": case "external": case "agent": return { name, description, category, enabled, usage, provenance };
      default: throw new DashboardClientError("malformed-response");
    }
  });
}
export function parseSkillContent(value: DashboardJson): DashboardSkillContent {
  const data = requireObject(value);
  if (typeof data["name"] !== "string" || typeof data["content"] !== "string" || typeof data["path"] !== "string") throw new DashboardClientError("malformed-response");
  return { name: data["name"], content: data["content"], path: data["path"] };
}
