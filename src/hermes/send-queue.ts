/** Messages typed while a turn is still running, sent one by one in order once it ends. */
export interface Queued {
  readonly id: number;
  readonly alias: string;
  readonly profile: string;
  /** What was typed (`/name rest` for a skill), shown in the queue and handed back to the composer on edit. */
  readonly draft: string;
  /** What the CLI is asked, and the skill it preloads ("" for none). */
  readonly query: string;
  readonly skill: string;
}

export class SendQueue {
  private items: Queued[] = [];
  private seq = 0;
  /** After a failed or stopped turn nothing leaves until the user resumes or clears. */
  paused = false;

  get list(): readonly Queued[] { return this.items; }

  push(item: Omit<Queued, "id">): Queued {
    if (!this.items.length) this.paused = false;
    const queued = { ...item, id: ++this.seq };
    this.items.push(queued);
    return queued;
  }

  remove(id: number): Queued | undefined {
    const at = this.items.findIndex(item => item.id === id);
    return at < 0 ? undefined : this.items.splice(at, 1)[0];
  }

  /** The next message to send; none while paused. */
  take(): Queued | undefined {
    return this.paused ? undefined : this.items.shift();
  }

  /** A message that failed before the CLI took it goes back to the front, so resuming retries it. */
  requeue(item: Queued): void {
    this.items.unshift(item);
  }

  clear(): void {
    this.items = [];
    this.paused = false;
  }
}

/** The raw failure stays in the tooltip; the header says what it means. */
export const isSshUnreachable = (error: string): boolean => /ssh|resolve|timed out|refused|unreachable|connection|host/i.test(error);

export function plainWhy(error: string): string {
  if (isSshUnreachable(error)) return "Can't reach Hermes";
  return "Hermes stopped with an error";
}
