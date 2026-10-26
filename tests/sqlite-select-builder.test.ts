import { describe, expect, test } from "bun:test";
import { buildQueryExecutions } from "../src/domain/sqlite-select-builder";

function remoteCommand(home: string): string {
  const built = buildQueryExecutions(home, { limit: 5 });
  if (!built.ok) throw new Error(built.detail);
  return built.command.remoteCommand;
}

describe("buildQueryExecutions", () => {
  test("tries read-only first, then one immutable retry, quoting the path in both", () => {
    const cmd = remoteCommand("/home/o'x");
    const [first, second] = cmd.split(" 2>/dev/null || ");
    expect(first).toContain(`-readonly -json '/home/o'\\''x/cron/executions.db'`);
    expect(second).toContain(`-json 'file:/home/o'\\''x/cron/executions.db?immutable=1'`);
    expect(second).not.toContain("-readonly");
  });

  test("percent-encodes URI metacharacters in the immutable path", () => {
    expect(remoteCommand("/h/a?b#c%d")).toContain("'file:/h/a%3Fb%23c%25d/cron/executions.db?immutable=1'");
  });
});
