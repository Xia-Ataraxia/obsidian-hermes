import { buildActivityCommand, parseActivityReadRequest } from "../domain/task-activity-command";
import { failedActivitySnapshot, parseActivityResponse } from "../domain/task-activity-response";
import type { BoundaryResult } from "../types/control-center";
import { ACTIVITY_LIMITS } from "../types/task-activity";
import type { BoardActivitySnapshot } from "../types/task-activity";
import type { ActivityReadInput, ActivityRunner, TaskActivityReader } from "../types/task-activity-read";
import { activityProcessRunner } from "./task-activity-runner";

export class TaskActivityCollector implements TaskActivityReader {
  private readonly active = new Set<AbortController>();
  private readonly waiting = new Set<() => void>();
  private readonly successful = new Map<string, BoardActivitySnapshot>();
  private readonly generations = new Map<string, number>();
  private disposed = false;

  constructor(private readonly runner: ActivityRunner = activityProcessRunner) {}

  async read(input: ActivityReadInput, signal: AbortSignal): Promise<BoundaryResult<BoardActivitySnapshot>> {
    const parsed = parseActivityReadRequest(input);
    if (!parsed.ok) return parsed;
    const request = parsed.value;
    const key = JSON.stringify([request.board.connection, request.root, request.board.board, request.window.preset]);
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    while (this.active.size >= ACTIVITY_LIMITS.concurrentBoards && !signal.aborted && !this.disposed) {
      await new Promise<void>((resolve) => {
        const ready = () => { this.waiting.delete(ready); signal.removeEventListener("abort", ready); resolve(); };
        this.waiting.add(ready);
        signal.addEventListener("abort", ready, { once: true });
        if (signal.aborted) ready();
      });
    }
    if (signal.aborted || this.disposed) return { ok: true, value: this.retain(key, failedActivitySnapshot(request, "transport-failure")) };
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.active.add(controller);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let snapshot: BoardActivitySnapshot;
    try {
      const outcome = await this.runner(buildActivityCommand(request), controller.signal);
      snapshot = outcome.ok ? parseActivityResponse(outcome.stdout, request) : failedActivitySnapshot(request, outcome.reason);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      snapshot = failedActivitySnapshot(request, "transport-failure");
    } finally {
      signal.removeEventListener("abort", abort);
      this.active.delete(controller);
      for (const ready of [...this.waiting]) ready();
    }
    if (controller.signal.aborted || this.disposed || generation !== this.generations.get(key)) snapshot = failedActivitySnapshot(request, "transport-failure");
    if (snapshot.coverage.kind === "complete") this.successful.set(key, snapshot);
    return { ok: true, value: this.retain(key, snapshot) };
  }

  private retain(key: string, snapshot: BoardActivitySnapshot): BoardActivitySnapshot {
    const previous = this.successful.get(key);
    if (snapshot.coverage.kind === "complete" || previous === undefined) return snapshot;
    return { ...previous, coverage: snapshot.coverage,
      freshness: { kind: "stale", lastSuccessAt: previous.snapshotAt, reason: "transport-failure" } };
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.active) controller.abort();
    for (const ready of [...this.waiting]) ready();
    this.successful.clear();
    this.generations.clear();
  }
}
