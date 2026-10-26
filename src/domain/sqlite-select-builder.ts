import type { CommandBuildResult } from "../types/remote-command";
import { BYTE_CAPS } from "../types/remote-command";
import { isQuotable, posixSingleQuote } from "./posix-single-quote";
import type { HistoryCursor } from "../types/view";
import { checkJobId, checkLimit, checkWithinRoot } from "./remote-token-validator";

const COLUMNS =
  "id, job_id, status, source, claimed_at, started_at, finished_at, error, delivery_outcome, scheduled_instant";

/** SQL string literal escaping: a single quote doubles. The whole SQL is POSIX-quoted after. */
function sqlLiteral(value: string): string {
  return `'${value.split("'").join("''")}'`;
}

/**
 * R7 - read the execution ledger.
 *
 * The first attempt passes the database as a plain absolute path with `-readonly`. Only if that
 * fails (a WAL database without sidecar files that an older sqlite3 cannot open) does one retry
 * open it as a `file:` URI with `immutable=1`, the same fallback as the `ro` helper in
 * hermes/remote.ts. The path is percent-encoded for `?`, `#` and `%` so it cannot be reinterpreted
 * as URI query syntax; `nolock` and `vfs` are not expressible. `-json` is a fixed part of the
 * contract: bodies containing newlines, pipes or quotes stay structured.
 */
export function buildQueryExecutions(
  home: string,
  options: { readonly jobId?: string; readonly limit: number; readonly before?: HistoryCursor },
): CommandBuildResult {
  const dbPath = `${home}/cron/executions.db`;
  const pathCheck = checkWithinRoot(dbPath, `${home}/cron`);
  if (!pathCheck.ok) return { ok: false, code: pathCheck.code, detail: pathCheck.detail };

  const limitCheck = checkLimit(options.limit);
  if (!limitCheck.ok) return { ok: false, code: limitCheck.code, detail: limitCheck.detail };

  const clauses: string[] = [];
  if (options.jobId !== undefined) {
    const jobCheck = checkJobId(options.jobId);
    if (!jobCheck.ok) return { ok: false, code: jobCheck.code, detail: jobCheck.detail };
    clauses.push(`job_id = ${sqlLiteral(options.jobId)}`);
  }
  if (options.before !== undefined) {
    const { claimedAt, id } = options.before;
    const idCheck = checkJobId(id);
    if (!idCheck.ok) return { ok: false, code: idCheck.code, detail: idCheck.detail };
    // The cursor comes back from a remote row, so it is validated like any other remote token:
    // refuse to assemble rather than throwing out of the builder.
    if (!isQuotable(claimedAt) || claimedAt.length > 64) {
      return {
        ok: false,
        code: "control-character",
        detail: "cursor timestamp contains a control character or is too long",
      };
    }
    clauses.push(
      `(claimed_at, id) < (${sqlLiteral(claimedAt)}, ${sqlLiteral(id)})`,
    );
  }

  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const sql =
    `SELECT ${COLUMNS} FROM executions${where} ORDER BY claimed_at DESC, id DESC LIMIT ${options.limit}`;
  const sqlArg = posixSingleQuote(sql);
  const uri = `file:${dbPath.replace(/[%?#]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}?immutable=1`;
  const readonly = `"$s" -readonly -json ${posixSingleQuote(dbPath)} ${sqlArg}`;
  const immutable = `"$s" -json ${posixSingleQuote(uri)} ${sqlArg}`;

  return {
    ok: true,
    command: {
      kind: "queryExecutions",
      // The observed Apple CLI cannot open WAL databases without sidecars: prefer the Homebrew
      // CLI, then fall back to immutable once if the read-only open fails.
      remoteCommand:
        `s=sqlite3; if test -x /opt/homebrew/opt/sqlite/bin/sqlite3; then s=/opt/homebrew/opt/sqlite/bin/sqlite3; fi; ${readonly} 2>/dev/null || ${immutable}`,
      byteCap: BYTE_CAPS.sqlResult,
      nulSeparated: false,
    },
  };
}
