export const STATUSES = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"] as const;
export type Status = typeof STATUSES[number];

/** One board card; times are epoch seconds. */
export interface Card {
  readonly id: string; title: string; status: Status; priority: number; readonly createdAt: number;
  assignee?: string; tenant?: string; startedAt?: number; completedAt?: number; blockKind?: string; blockRecurrences?: number;
  failures?: number; lastError?: string; heartbeatAt?: number; maxRuntime?: number; pid?: number; claimExpires?: number;
  comments?: number; parents?: number; openParents?: number; children?: number; childrenDone?: number; text?: string; reason?: string;
}
export interface BoardMeta { slug: string; name: string; description?: string; icon?: string; color?: string; workdir?: string; project?: string; archived: boolean; counts: Partial<Record<Status, number>> }
/** One board pull; `tasks` is the previous list when the token showed nothing changed. */
export interface BoardRead { board: string; token: string | null; boards: BoardMeta[]; profiles: string[]; config: Record<string, string>; tasks: Card[] }

export interface TaskRow {
  id: string; title: string; status: Status; priority: number; createdAt: number; body?: string; assignee?: string; tenant?: string;
  workspaceKind?: string; workspacePath?: string; branch?: string; project?: string; skills?: string[]; model?: string; provider?: string;
  reasoning?: string; goalMode?: number; goalMaxTurns?: number; createdBy?: string; startedAt?: number; completedAt?: number; result?: string;
  blockKind?: string; blockRecurrences?: number; failures?: number; lastError?: string; claimLock?: string; claimExpires?: number; pid?: number;
  heartbeatAt?: number; runId?: number; maxRuntime?: number; maxRetries?: number; contract?: string; idempotencyKey?: string;
}
export interface Ref { id: string; title: string; status: Status }
export interface ChildRef extends Ref { result?: string; summary?: string }
export interface TaskComment { id: number; author?: string; body: string; at: number }
export interface TaskEvent { id: number; kind: string; payload?: unknown; at: number }
export interface Run { id: number; profile?: string; status?: string; outcome?: string; summary?: string; error?: string; metadata?: unknown; startedAt?: number; endedAt?: number }
export interface Attachment { id: number; name: string; size?: number; type?: string; by?: string; at: number; path?: string }
export interface Detail {
  task: TaskRow; parents: Ref[]; children: ChildRef[]; comments: TaskComment[]; eventCount: number; events: TaskEvent[]; runs: Run[];
  attachments: Attachment[]; log?: { size: number; text: string };
  /** The board's attachments folder as the host resolves it (`pwd -P`); downloads must sit under it. */
  attachRoot?: string;
}
/** A notification target: a platform's home channel, or a task's subscription. */
export interface NotifyTarget { platform: string; chat: string; thread: string; name?: string }
export interface Diagnostic {
  kind: string; severity: string; title: string; detail?: string;
  actions: { kind: string; label: string; payload?: unknown; suggested?: boolean }[]; count?: number; last_seen_at?: number;
}

export interface FeedRow { id: number; task: string; title?: string; kind: string; reason?: string }
export type Feed = Record<string, { name?: string; archived: boolean; max: number; rows: FeedRow[] }>;
export interface Alert { board: string; boardName: string; task: string; title: string; kind: string; reason: string; id: number }

export interface NewTask {
  title: string; body?: string; assignee?: string; parents?: string[]; workspace?: string; branch?: string; tenant?: string; priority?: number;
  status?: "triage" | "blocked"; maxRuntime?: string; maxRetries?: number; skills?: string[]; model?: string; provider?: string;
  goal?: boolean; goalMaxTurns?: number; project?: string;
}
export type Verb =
  | { verb: "promote" | "archive" | "purge" | "specify" | "decompose"; id: string }
  | { verb: "unblock" | "reopen-review" | "reclaim" | "schedule"; id: string; reason?: string }
  | { verb: "block"; id: string; kind?: "capability" | "dependency" | "needs_input" | "transient"; reason: string }
  | { verb: "complete"; id: string; summary?: string; result?: string; force?: boolean }
  | { verb: "request-review"; id: string; force?: boolean }
  | { verb: "assign" | "reassign"; id: string; profile: string | null; reason?: string; reclaim?: boolean }
  | { verb: "set-model"; id: string; model: string | null; provider?: string }
  | { verb: "edit"; id: string; title?: string; body?: string; priority?: number }
  | { verb: "link" | "unlink"; id: string; child: string }
  | { verb: "comment"; id: string; text: string }
  | { verb: "attach-rm"; id: string; attachment: number }
  | { verb: "attach"; id: string; name: string; type?: string; bytes: Uint8Array }
  | { verb: "notify-subscribe" | "notify-unsubscribe"; id: string; platform: string; chat: string; thread?: string };
/** `settings` rewrites a live board through `boards create` (there is no edit verb); `rm` archives it, or with `delete` removes its folder. */
export type BoardVerb =
  | { verb: "create" | "settings"; slug: string; name: string; description: string; icon: string; color: string; workdir: string }
  | { verb: "rm"; slug: string; delete?: boolean };
export type Drop = "promote" | "unblock" | "reopen-review" | "reclaim" | "block" | "complete" | "archive";
