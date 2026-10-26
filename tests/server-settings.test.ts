import { expect, test } from "bun:test";
import { serverDefinitions } from "../src/ui/server-settings-section";

test("one settings row per server, so Obsidian's name keys never collide", () => {
  const noop = (): void => undefined;
  const rows = serverDefinitions({
    servers: ["a", "b"],
    statusOf: () => ({ text: "", failed: false }),
    isBusy: () => false,
    onAdd: noop, onEdit: noop, onCheck: noop, onRemove: noop, onKanban: noop, onProfiles: noop,
  });
  const names = rows.map(row => row.name);
  expect(names).toEqual(["Add SSH host alias", "a", "b"]);
});
