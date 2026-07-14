import { describe, expect, it } from "vitest";
import { JournalRecoveryRequiredError } from "@claudexor/journal";
import { SetupLifecycleBinding, type SetupLifecycleHandle } from "./setup-lifecycle-binding.js";

interface FakeStore {
  generation: number;
}

class FakeHandle implements SetupLifecycleHandle {
  readonly events: string[];

  constructor(
    readonly generation: number,
    events: string[],
  ) {
    this.events = events;
  }

  async start(): Promise<void> {
    this.events.push(`start:${this.generation}`);
  }

  beginDrain(): void {
    this.events.push(`drain:${this.generation}`);
  }

  async shutdown(): Promise<void> {
    this.events.push(`shutdown:${this.generation}`);
  }
}

describe("SetupLifecycleBinding", () => {
  it("starts degraded and preserves the journal recovery problem until replacement", async () => {
    let generation = 0;
    const slot = {
      current(): FakeStore {
        if (generation === 0) {
          throw new JournalRecoveryRequiredError({
            status: "recovery_required",
            location: { kind: "byte", byteOffset: 7 },
            reason: "checksum mismatch",
            discardedTailBytes: 0,
          });
        }
        return { generation };
      },
      generation: () => generation,
    };
    const events: string[] = [];
    const binding = new SetupLifecycleBinding(
      slot,
      (store) => new FakeHandle(store.generation, events),
    );

    await binding.start();
    expect(() => binding.current()).toThrowError(/checksum mismatch/);
    await binding.replaceAfter(() => {
      generation = 1;
      events.push("quarantine");
      return "receipt";
    });

    expect(binding.current().generation).toBe(1);
    expect(binding.generation()).toBe(1);
    expect(events).toEqual(["quarantine", "start:1"]);
  });

  it("drains the old generation before replacement and starts the new one", async () => {
    let generation = 1;
    const events: string[] = [];
    const slot = {
      current: () => ({ generation }),
      generation: () => generation,
    };
    const binding = new SetupLifecycleBinding(
      slot,
      (store) => new FakeHandle(store.generation, events),
    );
    await binding.start();

    const receipt = await binding.replaceAfter(() => {
      events.push("quarantine");
      generation = 2;
      return "receipt";
    });

    expect(receipt).toBe("receipt");
    expect(events).toEqual(["start:1", "drain:1", "shutdown:1", "quarantine", "start:2"]);
    expect(binding.current().generation).toBe(2);
  });

  it("serializes concurrent replacement and fences it once shutdown begins", async () => {
    let generation = 1;
    const events: string[] = [];
    const slot = {
      current: () => ({ generation }),
      generation: () => generation,
    };
    const binding = new SetupLifecycleBinding(
      slot,
      (store) => new FakeHandle(store.generation, events),
    );
    await binding.start();

    binding.beginDrain();
    await expect(
      binding.replaceAfter(() => {
        generation = 2;
      }),
    ).rejects.toMatchObject({ code: "daemon_stopping" });
    await binding.shutdown();
    expect(generation).toBe(1);
    expect(events).toEqual(["start:1", "drain:1", "shutdown:1"]);
  });

  it("drains a generation created by a replacement that races permanent shutdown", async () => {
    let generation = 1;
    const events: string[] = [];
    let operationStarted!: () => void;
    let releaseOperation!: () => void;
    const started = new Promise<void>((resolve) => {
      operationStarted = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const slot = {
      current: () => ({ generation }),
      generation: () => generation,
    };
    const binding = new SetupLifecycleBinding(
      slot,
      (store) => new FakeHandle(store.generation, events),
    );
    await binding.start();

    const replacing = binding.replaceAfter(async () => {
      events.push("quarantine-start");
      operationStarted();
      await barrier;
      generation = 2;
      events.push("quarantine-complete");
      return "receipt";
    });
    await started;
    binding.beginDrain();
    releaseOperation();

    await expect(replacing).rejects.toMatchObject({ code: "daemon_stopping" });
    await binding.shutdown();
    expect(events).toEqual([
      "start:1",
      "drain:1",
      "shutdown:1",
      "quarantine-start",
      "quarantine-complete",
      "start:2",
      "drain:2",
      "shutdown:2",
    ]);
  });

  it("rebinds the current healthy generation when the replacement operation is refused", async () => {
    const events: string[] = [];
    const slot = {
      current: () => ({ generation: 1 }),
      generation: () => 1,
    };
    const binding = new SetupLifecycleBinding(
      slot,
      (store) => new FakeHandle(store.generation, events),
    );
    await binding.start();

    await expect(
      binding.replaceAfter(() => {
        throw Object.assign(new Error("fingerprint changed"), {
          code: "recovery_fingerprint_mismatch",
        });
      }),
    ).rejects.toMatchObject({ code: "recovery_fingerprint_mismatch" });
    expect(binding.isBoundToCurrentGeneration()).toBe(true);
    expect(events).toEqual(["start:1", "drain:1", "shutdown:1", "start:1"]);
  });

  it("does not advertise a generation whose replacement supervisor failed to start", async () => {
    let generation = 1;
    const events: string[] = [];
    const slot = {
      current: () => ({ generation }),
      generation: () => generation,
    };
    const binding = new SetupLifecycleBinding(slot, (store) => ({
      beginDrain: () => {
        events.push(`drain:${store.generation}`);
      },
      shutdown: async () => {
        events.push(`shutdown:${store.generation}`);
      },
      start: async () => {
        events.push(`start:${store.generation}`);
        if (store.generation === 2) throw new Error("reconcile failed");
      },
    }));
    await binding.start();

    await expect(
      binding.replaceAfter(() => {
        generation = 2;
      }),
    ).rejects.toThrow(/reconcile failed/);
    expect(binding.isBoundToCurrentGeneration()).toBe(false);
    expect(() => binding.current()).toThrowError(/unavailable/);
  });
});
