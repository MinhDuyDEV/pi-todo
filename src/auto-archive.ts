import type { TodoPhase } from "./types.js";

export class AutoArchiveScheduler {
  private scheduled = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly enabled: () => boolean,
    private readonly archive: () => Promise<unknown>,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  schedule(phases: readonly Pick<TodoPhase, "status">[]): void {
    if (!this.enabled() || !phases.some((phase) => phase.status !== "active") || this.scheduled) {
      return;
    }
    this.scheduled = true;
    this.pending = this.pending
      .then(() => new Promise<void>((resolve) => queueMicrotask(resolve)))
      .then(async () => {
        if (!this.enabled()) return;
        try {
          await this.archive();
        } catch (error) {
          this.onError(error);
        }
      })
      .finally(() => {
        this.scheduled = false;
      });
  }

  /** Deterministic test/shutdown hook; normal callers do not need to await it. */
  async flush(): Promise<void> {
    await this.pending;
  }
}
