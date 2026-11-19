import { describe, expect, it, vi } from "vitest";
import { dispatchShutdownRpc } from "./daemon-shutdown-rpc.js";

describe("ordinary Stop diagnostic fields", () => {
  it.each([
    [null, {}],
    [
      { name: "Acme.runner-2", version: "1.2.3", pid: 42, ppid: 7, uid: 0 },
      { name: "Acme.runner-2", version: "1.2.3", pid: 42, ppid: 7 },
    ],
    [{ name: "client\nforged line", version: "non-version", pid: -1, ppid: 0 }, {}],
    [{ name: "x".repeat(65), pid: 42 }, { pid: 42 }],
    [{ name: "ghp_" + "a".repeat(36), version: "1.2.3" }, { version: "1.2.3" }],
    [
      { name: "claudexor-cli", version: "1".repeat(33), pid: 42, extra: "ignored" },
      { name: "claudexor-cli", pid: 42 },
    ],
  ])("drops unusable fields without changing admission", async (sender, expected) => {
    vi.useFakeTimers();
    try {
      const stop = vi.fn(async () => {});
      const records = vi.fn(() => []);
      const replacement = vi.fn(async () => {});
      const ack = dispatchShutdownRpc(
        "claudexor.shutdown",
        { sender },
        1,
        records,
        stop,
        replacement,
      );
      expect(ack).toEqual({ ok: true });
      expect(stop).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(stop).toHaveBeenCalledExactlyOnceWith(expected);
      expect(records).not.toHaveBeenCalled();
      expect(replacement).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
