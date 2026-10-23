import { DashboardClientError } from "../types/dashboard-client";
import type { DashboardJson, DashboardObject, DashboardReadRoute } from "../types/dashboard-client";
import { object, parseDashboardTask, requireObject } from "./dashboard-response";

export function validateDashboardRead(route: DashboardReadRoute, data: DashboardObject): DashboardObject {
  const list = (field: string) => { if (!Array.isArray(data[field])) throw new DashboardClientError("malformed-response"); return data[field]; };
  const text = (field: string) => { if (typeof data[field] !== "string") throw new DashboardClientError("malformed-response"); };
  const flag = (field: string) => { if (typeof data[field] !== "boolean") throw new DashboardClientError("malformed-response"); };
  switch (route) {
    case "GET /tasks/{task_id}": parseDashboardTask(data); break;
    case "GET /board":
      for (const raw of list("columns")) {
        const column = requireObject(raw);
        if (typeof column["name"] !== "string" || !Array.isArray(column["tasks"])) throw new DashboardClientError("malformed-response");
        for (const task of column["tasks"]) parseDashboardTask({ task });
      }
      list("tenants"); list("assignees"); break;
    case "GET /workflow": {
      const columns = list("columns").map((raw: DashboardJson) => requireObject(raw)["key"]);
      const expected = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done"];
      if (JSON.stringify(columns) !== JSON.stringify(expected)) throw new DashboardClientError("malformed-response");
      const manual = requireObject(data["manual"] ?? null);
      if (expected.some(key => !Array.isArray(manual[key]) || manual[key].some(value => typeof value !== "string" || !expected.includes(value)))) throw new DashboardClientError("malformed-response");
      break;
    }
    case "GET /profiles":
      for (const raw of list("profiles")) { const profile = requireObject(raw); if (typeof profile["name"] !== "string") throw new DashboardClientError("malformed-response"); }
      break;
    case "GET /boards":
      for (const raw of list("boards")) { const board = requireObject(raw); if (typeof board["slug"] !== "string" || typeof board["name"] !== "string") throw new DashboardClientError("malformed-response"); }
      break;
    case "GET /tasks/{task_id}/attachments": list("attachments"); break;
    case "GET /diagnostics": list("diagnostics"); if (typeof data["count"] !== "number") throw new DashboardClientError("malformed-response"); break;
    case "GET /runs/{run_id}": requireObject(data["run"] ?? null); break;
    case "GET /config": text("default_tenant"); flag("lane_by_profile"); flag("include_archived_by_default"); flag("render_markdown"); break;
    case "GET /home-channels": list("home_channels"); break;
    case "GET /stats": if (!object(data["by_status"] ?? null) || !object(data["by_assignee"] ?? null)) throw new DashboardClientError("malformed-response"); break;
    case "GET /assignees": list("assignees"); break;
    case "GET /tasks/{task_id}/log": text("task_id"); text("content"); flag("exists"); flag("truncated"); break;
    case "GET /model-options": list("providers"); break;
    case "GET /orchestration": text("orchestrator_profile"); text("default_assignee"); text("resolved_orchestrator_profile"); text("resolved_default_assignee"); flag("auto_decompose"); flag("auto_promote_children"); break;
    case "GET /attachments/{attachment_id}": throw new DashboardClientError("unsupported-operation");
    default: return unreachable(route);
  }
  return data;
}
function unreachable(value: never): never { throw new DashboardClientError("unsupported-operation", 0, String(value)); }
