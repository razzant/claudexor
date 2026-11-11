import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeRemaining,
  inAppSidecarFacts,
  preferCapturedSidecars,
  probeFailure,
  readInAppSidecars,
  remainingProcesses,
} from "./win32-agy-acceptance-diagnostics.mjs";

const vocabulary = {
  errorCodes: ["spawn_failed", "terminal_transport_failed"],
  stages: ["awaiting_permit", "running"],
};
const oneShot = "one-shot-win32-code-77";
const oauthUrl = "https://accounts.google.com/o/oauth2/auth?state=claudexor-conpty-fixture";
const read = (value) => ({ exists: true, value });
const missing = { exists: false, value: null };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Win32 agy acceptance sidecar facts", () => {
  it("keep only allowlisted, typed receipt, input and state facts", () => {
    const facts = inAppSidecarFacts(
      {
        input: read({ value: oneShot, consumed: "yes" }),
        state: read({ stage: oauthUrl, processGroup: { pgid: 7 } }),
        receipt: read({
          commandStarted: "yes",
          exitCode: 1.5,
          signal: `SIGTERM ${oauthUrl}`,
          errorCode: `${oauthUrl}&code=${oneShot}`,
          outputTail: `CODE: ${oneShot}`,
        }),
      },
      vocabulary,
    );
    expect(facts).toEqual({
      input: { exists: true, readable: true, consumed: false, valueRetained: true },
      state: { exists: true, readable: true, stage: "unrecognized" },
      receipt: {
        exists: true,
        readable: true,
        commandStarted: null,
        exitCode: null,
        signal: "unrecognized",
        errorCode: "unrecognized",
      },
    });
    expect(JSON.stringify(facts)).not.toContain(oneShot);
    expect(JSON.stringify(facts)).not.toContain("accounts.google.com");
  });

  it("pass recognized values and treat non-object JSON as unreadable", () => {
    const facts = inAppSidecarFacts(
      {
        input: read([oneShot]),
        state: read({ stage: "running" }),
        receipt: read({
          commandStarted: true,
          exitCode: 0,
          signal: "SIGTERM",
          errorCode: "terminal_transport_failed",
        }),
      },
      vocabulary,
    );
    expect(facts.input).toEqual({
      exists: true,
      readable: false,
      consumed: false,
      valueRetained: false,
    });
    expect(facts.state.stage).toBe("running");
    expect(facts.receipt).toMatchObject({
      commandStarted: true,
      exitCode: 0,
      signal: "SIGTERM",
      errorCode: "terminal_transport_failed",
    });
    expect(
      inAppSidecarFacts({ input: missing, state: read(null), receipt: missing }, vocabulary),
    ).toMatchObject({
      input: { exists: false, readable: false },
      state: { exists: true, readable: false, stage: null },
      receipt: { exists: false, readable: false, errorCode: null },
    });
  });

  it("read missing, malformed and valid sidecars without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "claudexor-agy-sidecars-"));
    try {
      writeFileSync(join(dir, "runner-state.json"), '{"stage":"run');
      writeFileSync(join(dir, "runner-result.json"), '{"exitCode":1}');
      expect(
        readInAppSidecars({
          input: join(dir, "runner-input.json"),
          state: join(dir, "runner-state.json"),
          receipt: join(dir, "runner-result.json"),
        }),
      ).toEqual({
        input: { exists: false, value: null },
        state: { exists: true, value: null },
        receipt: { exists: true, value: { exitCode: 1 } },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never let a later read replace what the worker captured", () => {
    const captured = inAppSidecarFacts(
      { input: read({ consumed: true }), state: missing, receipt: read({ exitCode: 1 }) },
      vocabulary,
    );
    const late = inAppSidecarFacts(
      { input: missing, state: read({ stage: "running" }), receipt: missing },
      vocabulary,
    );
    expect(preferCapturedSidecars(captured, late)).toEqual({
      input: { source: "worker", ...captured.input },
      state: { source: "worker", ...captured.state },
      receipt: { source: "worker", ...captured.receipt },
    });
    expect(preferCapturedSidecars(undefined, late)).toEqual({
      input: { source: "test", ...late.input },
      state: { source: "test", ...late.state },
      receipt: { source: "test", ...late.receipt },
    });
  });
});

describe("Win32 agy acceptance remaining processes", () => {
  it("name only the processes not proven gone, with every role", () => {
    const kill = vi.spyOn(process, "kill");
    const probes = new Map([
      [101, { state: "gone" }],
      [202, { state: "alive" }],
      [303, probeFailure(Object.assign(new Error("denied"), { code: "EPERM" }))],
    ]);
    const probed = [];
    const remaining = remainingProcesses(
      [
        { pid: 101, role: "in-app runner" },
        { pid: 202, role: "ConPTY helper" },
        { pid: 202, role: "in-app descendant" },
        { pid: 202, role: "ConPTY helper" },
        { pid: 303, role: "process snapshot observer" },
        { pid: 0, role: "unassigned" },
        { pid: Number.NaN, role: "malformed evidence" },
      ],
      (pid) => {
        probed.push(pid);
        return probes.get(pid);
      },
    );
    expect(probed).toEqual([101, 202, 303]);
    expect(kill).not.toHaveBeenCalled();
    expect(remaining).toEqual([
      { pid: 202, roles: ["ConPTY helper", "in-app descendant"], state: "alive" },
      { pid: 303, roles: ["process snapshot observer"], state: "unknown", code: "EPERM" },
    ]);
    expect(describeRemaining(remaining)).toBe(
      "202 alive (ConPTY helper, in-app descendant); 303 unknown EPERM (process snapshot observer)",
    );
  });

  it("treat only ESRCH as gone", () => {
    expect(probeFailure(Object.assign(new Error("gone"), { code: "ESRCH" }))).toEqual({
      state: "gone",
    });
    expect(probeFailure(Object.assign(new Error("denied"), { code: "EPERM" }))).toEqual({
      state: "unknown",
      code: "EPERM",
    });
    expect(probeFailure(new Error("no code"))).toEqual({ state: "unknown", code: "unknown" });
    expect(probeFailure(undefined)).toEqual({ state: "unknown", code: "unknown" });
  });
});
