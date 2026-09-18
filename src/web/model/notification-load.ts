/** Coalesces snapshot-triggered notification reads and keeps stale completions out of the board notification state. */

type NotificationLoad = (token: number) => Promise<void>;

/** Coalesces snapshot-driven reads while rejecting completions from older requests. */
export class NotificationLoadCoordinator {
  private generation = 0;
  private active = false;
  private snapshotInFlight: Promise<void> | null = null;
  private snapshotPending = false;

  activate(): void {
    this.active = true;
    this.generation += 1;
  }

  snapshotArrived(_snapshot: object, load: NotificationLoad): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.snapshotInFlight !== null) {
      this.snapshotPending = true;
      return this.snapshotInFlight;
    }

    const operation = this.runSnapshotLoads(load);
    this.snapshotInFlight = operation;
    void operation.finally(() => {
      if (this.snapshotInFlight === operation) this.snapshotInFlight = null;
    });
    return operation;
  }

  async refresh(load: NotificationLoad): Promise<void> {
    if (!this.active) return;
    const token = this.nextToken();
    await load(token);
  }

  invalidate(): void {
    this.generation += 1;
  }

  isLatest(token: number): boolean {
    return this.active && token === this.generation;
  }

  deactivate(): void {
    this.active = false;
    this.snapshotPending = false;
    this.generation += 1;
  }

  private async runSnapshotLoads(load: NotificationLoad): Promise<void> {
    do {
      this.snapshotPending = false;
      const token = this.nextToken();
      await load(token);
    } while (this.active && this.snapshotPending);
  }

  private nextToken(): number {
    this.generation += 1;
    return this.generation;
  }
}
