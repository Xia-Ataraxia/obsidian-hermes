import { ACTIVITY_LIMITS } from "../types/task-activity";
import type { ActivityCommand, ActivityReadInput, ActivityReadRequest } from "../types/task-activity-read";
import type { BoundaryResult } from "../types/control-center";
import { parseControlCenterToken } from "./control-center-validation";
import { posixSingleQuote } from "./posix-single-quote";
import { TASK_ACTIVITY_PYTHON } from "./task-activity-python";

export function parseActivityReadRequest(input: ActivityReadInput): BoundaryResult<ActivityReadRequest> {
  const connection = parseControlCenterToken("connection", input.connection);
  const board = parseControlCenterToken("board", input.board);
  const root = parseControlCenterToken("path", input.root);
  if (!connection.ok || !board.ok || !root.ok || root.value === "/" || root.value.endsWith("/")) return { ok: false, code: "invalid-token" };
  if (!Number.isSafeInteger(input.end) || input.end < 0 || input.end > 8_640_000_000_000_000) return { ok: false, code: "invalid-shape" };
  const preset = input.preset ?? 30;
  const scope = { board: { kind: "board", connection: connection.value, board: board.value }, root: root.value } as const;
  switch (preset) {
    case "all": return { ok: true, value: { ...scope, window: { preset, start: null, end: input.end } } };
    case 7: case 30: case 90:
      return { ok: true, value: { ...scope, window: { preset, start: input.end - preset * 86_400_000, end: input.end } } };
    default: return { ok: false, code: "invalid-shape" };
  }
}

/** One closed program; only validated root, board and window are passed as data. */
export function buildActivityCommand(request: ActivityReadRequest): ActivityCommand {
  const encoded = Buffer.from(TASK_ACTIVITY_PYTHON, "utf8").toString("base64");
  const program = `import base64;exec(base64.b64decode('${encoded}'))`;
  const data = JSON.stringify({ root: request.root, board: request.board.board, window: request.window, limits: ACTIVITY_LIMITS });
  const remote = ["python3", "-c", program, data].map(posixSingleQuote).join(" ");
  return { kind: "read-board-activity", request, file: "ssh", args: ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "RequestTTY=no", "-o", "ConnectTimeout=10", "--", request.board.connection, remote] };
}
