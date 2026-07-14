export interface RuntimeStopParticipant {
  stop(): Promise<void>;
}

export interface RuntimeSetupParticipant {
  beginDrain(): void;
  shutdown(): Promise<void>;
}

export interface RuntimeJournalParticipant {
  close(): void;
}

export interface DaemonRuntimeShutdownOptions {
  daemon: RuntimeStopParticipant;
  setup: RuntimeSetupParticipant;
  control: () => RuntimeStopParticipant | null;
  journal: RuntimeJournalParticipant;
}

/** Stop ingress and setup work before closing the journal they write to. */
export class DaemonRuntimeShutdown {
  private requestedValue = false;
  private readonly completion: Promise<void>;
  private resolveCompletion!: () => void;
  private rejectCompletion!: (error: unknown) => void;

  constructor(private readonly options: DaemonRuntimeShutdownOptions) {
    this.completion = new Promise<void>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    void this.completion.catch(() => undefined);
  }

  request(): Promise<void> {
    if (this.requestedValue) return this.completion;
    this.requestedValue = true;

    const failures: unknown[] = [];
    const operations: Promise<void>[] = [];
    const start = (operation: () => Promise<void>): void => {
      try {
        operations.push(Promise.resolve(operation()));
      } catch (error) {
        failures.push(error);
      }
    };

    try {
      this.options.setup.beginDrain();
    } catch (error) {
      failures.push(error);
    }
    try {
      const control = this.options.control();
      if (control) start(() => control.stop());
    } catch (error) {
      failures.push(error);
    }
    start(() => this.options.daemon.stop());
    start(() => this.options.setup.shutdown());

    void Promise.allSettled(operations).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      if (failures.length > 0) {
        this.rejectCompletion(new AggregateError(failures, "daemon runtime shutdown failed"));
        return;
      }
      try {
        this.options.journal.close();
        this.resolveCompletion();
      } catch (error) {
        this.rejectCompletion(error);
      }
    });
    return this.completion;
  }

  wait(): Promise<void> {
    return this.completion;
  }

  requested(): boolean {
    return this.requestedValue;
  }
}
