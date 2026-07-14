import { describe, expect, it } from "vitest";
import { DaemonRuntimeShutdown } from "./daemon-runtime-shutdown.js";

describe("DaemonRuntimeShutdown", () => {
  it("fences setup, stops every writer, then closes the journal once", async () => {
    const events: string[] = [];
    const runtime = new DaemonRuntimeShutdown({
      daemon: { stop: async () => void events.push("daemon-stop") },
      setup: {
        beginDrain: () => void events.push("setup-fence"),
        shutdown: async () => void events.push("setup-stop"),
      },
      control: () => ({ stop: async () => void events.push("control-stop") }),
      journal: { close: () => void events.push("journal-close") },
    });

    const first = runtime.request();
    expect(runtime.request()).toBe(first);
    expect(events).toEqual(["setup-fence", "control-stop", "daemon-stop", "setup-stop"]);
    await first;
    expect(events).toEqual([
      "setup-fence",
      "control-stop",
      "daemon-stop",
      "setup-stop",
      "journal-close",
    ]);
  });

  it("keeps the journal open when any writer fails to stop", async () => {
    let journalClosed = false;
    const runtime = new DaemonRuntimeShutdown({
      daemon: {
        stop: async () => {
          throw new Error("final persist failed");
        },
      },
      setup: { beginDrain: () => undefined, shutdown: async () => undefined },
      control: () => null,
      journal: { close: () => void (journalClosed = true) },
    });

    await expect(runtime.request()).rejects.toThrow(/shutdown failed/);
    await expect(runtime.wait()).rejects.toThrow(/shutdown failed/);
    expect(journalClosed).toBe(false);
  });
});
