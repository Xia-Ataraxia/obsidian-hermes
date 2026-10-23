export const FIXTURE_TIME = "2026-10-22T00:00:00Z";
export const fixtureProfiles = ["default", "xia", "empty"] as const;
export const fixtureBoards = ["default", "xia-dev"] as const;
export type FixtureTask = { readonly id: string; readonly board: string; title: string; assignee: string; readonly created_by: string; readonly status: string };
export function fixtureTasks(): FixtureTask[] {
  return fixtureBoards.map(board => ({ id: "repeat-001", board, title: `Synthetic ${board}`, assignee: "xia", created_by: "default", status: "todo" }));
}
export function fixtureEvents(board: string) {
  return [
    { id: 1, task_id: "repeat-001", board, kind: "review_requested", payload: { from: "xia", assignee: "default" }, created_at: FIXTURE_TIME },
    { id: 2, task_id: "repeat-001", board, kind: "review_changes_requested", payload: { from: "default", assignee: "xia" }, created_at: FIXTURE_TIME },
    { id: 3, task_id: "repeat-001", board, kind: "review_requested", payload: { from: "xia", assignee: "default" }, created_at: FIXTURE_TIME },
    { id: 4, task_id: "repeat-001", board, kind: "reassigned", payload: { assignee: "xia" }, created_at: FIXTURE_TIME },
  ];
}
