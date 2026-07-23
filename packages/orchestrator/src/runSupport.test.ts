import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "@claudexor/schema";
import {
  harnessEventPayload,
  promptWithEngineConstraints,
  promptWithGateArgvDisclosure,
} from "./runSupport.js";

describe("promptWithEngineConstraints (QA-022: protected paths + gate argv in one seam)", () => {
  it("appends the gate argv even when there are no protected paths", () => {
    const out = promptWithEngineConstraints(
      "task",
      [],
      [],
      [],
      [{ program: "node", args: ["--test"] }],
    );
    expect(out).toContain('- ["node","--test"]');
  });

  it("renders protected-path constraints AND the gate argv together", () => {
    const out = promptWithEngineConstraints(
      "task",
      ["config/**"],
      ["test/**"],
      [],
      [{ program: "make", args: ["check"] }],
    );
    expect(out).toContain("Protected paths:");
    expect(out).toContain("- config/**");
    expect(out).toContain("Auto-protected paths:");
    expect(out).toContain('- ["make","check"]');
  });

  it("is a no-op when there are neither constraints nor gates", () => {
    expect(promptWithEngineConstraints("task", [])).toBe("task");
  });
});

describe("promptWithGateArgvDisclosure (QA-022 FIX B: candidate sees the exact gate argv)", () => {
  it("returns the prompt unchanged when there are no gates", () => {
    expect(promptWithGateArgvDisclosure("do the task", [])).toBe("do the task");
  });

  it("appends each gate as an exact JSON argv list (no shell string)", () => {
    const out = promptWithGateArgvDisclosure("do the task", [
      {
        program: "/Applications/Claudexor.app/Contents/Resources/node",
        args: ["--test", "test/counter.test.js"],
      },
    ]);
    expect(out).toContain("do the task");
    expect(out).toContain(
      '- ["/Applications/Claudexor.app/Contents/Resources/node","--test","test/counter.test.js"]',
    );
    // The exact program the deterministic gate runs must be reusable verbatim.
    expect(out).toContain("do not substitute a bare `node`/`npm`");
  });

  it("renders a program with no args as a single-element argv", () => {
    const out = promptWithGateArgvDisclosure("x", [{ program: "make", args: [] }]);
    expect(out).toContain('- ["make"]');
  });

  it("redacts a secret-like argv token with the same fence as the contract", () => {
    const out = promptWithGateArgvDisclosure("x", [
      { program: "deploy", args: ["--token", "sk-ant-1234567890abcdefghij"] },
    ]);
    expect(out).not.toContain("sk-ant-1234567890abcdefghij");
  });
});

describe("harnessEventPayload (run-event projection)", () => {
  it("carries typed finality and status through to the live stream (F2.5 E2E gap)", () => {
    // The F2.5 live smoke caught this: the projection dropped `final`, so the
    // app never saw the typed answer marker on the live path (attempt-level
    // events had it; the run-level stream did not).
    const finalEvent: HarnessEvent = {
      type: "message",
      session_id: "ses-1",
      ts: "2026-07-17T00:00:00Z",
      text: "the answer",
      final: true,
      payload: { final_source: "last_agent_message" },
    };
    const finalMsg = harnessEventPayload("codex", "a01", finalEvent);
    expect(finalMsg["final"]).toBe(true);
    expect((finalMsg["payload"] as Record<string, unknown>)["final_source"]).toBe(
      "last_agent_message",
    );

    const statusEvent: HarnessEvent = {
      type: "status",
      session_id: "ses-1",
      ts: "2026-07-17T00:00:01Z",
      text: "api_retry: overloaded",
      status: { kind: "api_retry", retry_delay_ms: 2500 },
    };
    const statusMsg = harnessEventPayload("claude", "a01", statusEvent);
    expect((statusMsg["status"] as Record<string, unknown>)["kind"]).toBe("api_retry");

    // Plain narration stays unmarked — no fabricated finality.
    const narration: HarnessEvent = {
      type: "message",
      session_id: "ses-1",
      ts: "2026-07-17T00:00:02Z",
      text: "working on it",
    };
    expect(harnessEventPayload("codex", "a01", narration)["final"]).toBeUndefined();
  });
});
