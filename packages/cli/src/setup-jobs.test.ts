import { describe, expect, it } from "vitest";
import { createSetupJobManager, type SetupDoctorStatus } from "./setup-jobs.js";

async function waitForTerminal(manager: ReturnType<typeof createSetupJobManager>, jobId: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const job = manager.status({ jobId });
    if (!["queued", "running"].includes(job.state)) return job.state;
    if (Date.now() > deadline) throw new Error(`job stuck in ${job.state}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const okStatus = (id: string): SetupDoctorStatus => ({
  id,
  status: "ok",
  checks: [
    { id: "installed", status: "pass" },
    { id: "isolated_api_smoke", status: "pass" },
  ],
});

describe("setup jobs in-process doctor", () => {
  it("runs store_key verification in-process (no shell, no PATH dependency) and succeeds on ok", async () => {
    const probed: string[] = [];
    const manager = createSetupJobManager({
      statusAll: async () => {
        probed.push("statusAll");
        return [okStatus("codex"), okStatus("claude")];
      },
    });
    const job = manager.create({ harness: "codex", action: "store_key" });
    expect(job.command).toContain("in-process doctor");
    expect(job.command).not.toContain("claudexor doctor"); // the exit-127 shell form is gone
    const state = await waitForTerminal(manager, job.jobId);
    expect(state).toBe("succeeded");
    expect(probed).toEqual(["statusAll"]);
    expect(manager.status({ jobId: job.jobId }).message).toContain("doctor passed (in-process)");
  });

  it("fails the job honestly with the doctor reasons when the harness is degraded", async () => {
    const manager = createSetupJobManager({
      statusAll: async () => [
        {
          id: "codex",
          status: "degraded",
          checks: [
            { id: "installed", status: "pass" },
            { id: "isolated_api_smoke", status: "fail" },
          ],
          reasons: ["isolated Codex API-key smoke failed: 401 Unauthorized"],
        },
      ],
    });
    const job = manager.create({ harness: "codex", action: "doctor" });
    const state = await waitForTerminal(manager, job.jobId);
    expect(state).toBe("failed");
    const message = manager.status({ jobId: job.jobId }).message;
    expect(message).toContain("degraded");
    expect(message).toContain("401 Unauthorized");
  });

  it("fails loudly when the doctor probe itself breaks (never silently green)", async () => {
    const manager = createSetupJobManager({
      statusAll: async () => {
        throw new Error("gateway exploded");
      },
    });
    const job = manager.create({ harness: "claude", action: "doctor" });
    const state = await waitForTerminal(manager, job.jobId);
    expect(state).toBe("failed");
    expect(manager.status({ jobId: job.jobId }).message).toContain("gateway exploded");
  });

  it("refuses Terminal-handoff login on non-darwin with a typed failure that discloses the manual command", () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const manager = createSetupJobManager({ statusAll: async () => [okStatus("codex")] });
      const job = manager.create({ harness: "codex", action: "login" });
      // Typed terminal state, no spawn of a missing `open` binary (whose
      // unhandled ENOENT 'error' event would crash the daemon).
      expect(job.state).toBe("failed");
      expect(job.message).toContain("macOS-only");
      expect(job.message).toContain("codex login");
      expect(job.finishedAt).not.toBeNull();
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  });

  it("a cancel during the in-flight doctor is never overwritten by the late verdict", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const manager = createSetupJobManager({
      statusAll: async () => {
        await gate; // doctor still probing while the user cancels
        return [okStatus("codex")];
      },
    });
    const job = manager.create({ harness: "codex", action: "doctor" });
    expect(manager.status({ jobId: job.jobId }).state).toBe("running");
    const cancelled = manager.cancel({ jobId: job.jobId });
    expect(cancelled.state).toBe("cancelled");
    release?.();
    await new Promise((r) => setTimeout(r, 30)); // let the late verdict race
    expect(manager.status({ jobId: job.jobId }).state).toBe("cancelled");
  });
});
