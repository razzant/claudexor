import { describe, expect, it } from "vitest";
import { ReviewFinding, type HarnessEvent } from "@claudexor/schema";
import {
  harnessEventPayload,
  promptWithEngineConstraints,
  promptWithGateArgvDisclosure,
  redactHarnessEvent,
  safeErrorMessage,
  winnerNeedsHuman,
} from "./runSupport.js";

describe("safeErrorMessage (a thrown value never reports as no error)", () => {
  it("keeps a real message verbatim", () => {
    expect(safeErrorMessage(new Error("adapter exploded"))).toBe("adapter exploded");
    expect(safeErrorMessage("plain string throw")).toBe("plain string throw");
  });

  it("substitutes a generic message for a blank one, so the throw stays visible", () => {
    // Every error axis downstream folds with `??=` or tests `if (error)`, so an
    // empty message would read as "nothing went wrong".
    for (const thrown of [new Error(""), new Error("   \n\t "), "", "  "]) {
      const message = safeErrorMessage(thrown);
      expect(message.trim().length).toBeGreaterThan(0);
      expect(message).toBe("thrown error carried no message");
    }
  });

  it("still redacts secrets in a non-blank message", () => {
    // Assembled at run time: a token-shaped LITERAL in a tracked file trips the
    // repo's own secret scan (CI step 1), which is the same convention the
    // redaction tests below and in attemptFinalize.test.ts already follow.
    const fakeToken = ["sk-ant", "1234567890abcdefghij"].join("-");
    expect(safeErrorMessage(new Error(`token ${fakeToken}`))).not.toContain(fakeToken);
  });
});

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
    // Assembled at runtime so the source (and any sealed review diff of it)
    // never contains a contiguous secret-like token at rest.
    const fakeToken = ["sk-ant", "1234567890abcdefghij"].join("-");
    const out = promptWithGateArgvDisclosure("x", [
      { program: "deploy", args: ["--token", fakeToken] },
    ]);
    expect(out).not.toContain(fakeToken);
  });
});

describe("redactHarnessEvent (INV-062 deep payload redaction)", () => {
  it("deep-redacts secret-like tokens in nested payload string VALUES, not just text/error", () => {
    // Assembled at runtime so the source (and any sealed review diff of it)
    // never contains a contiguous secret-like token at rest.
    const token = ["sk-or-v1", "c".repeat(40)].join("-");
    const ev: HarnessEvent = {
      type: "message",
      session_id: "ses-1",
      ts: "2026-07-17T00:00:00Z",
      text: `leaking ${token}`,
      final: true,
      // A codex constrained route carries the RAW {work_report, output} envelope
      // on this payload key; AnswerAssembly.machineText() reads it verbatim, so a
      // token in it must be redacted BEFORE it can become a candidate deliverable.
      payload: {
        work_report_envelope: JSON.stringify({
          output: token,
          work_report: { summary: token },
        }),
      },
    };
    const safe = redactHarnessEvent(ev);
    // Whole-event proof: no secret survives ANYWHERE in the redacted event.
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain(token);
    expect(serialized).toContain("[redacted]");
    // The nested payload STRING VALUE is redacted in place (deep), not merely the
    // top-level text/error fields and not dropped wholesale.
    const envelope = String((safe.payload as Record<string, unknown>)["work_report_envelope"]);
    expect(envelope).not.toContain(token);
    expect(envelope).toContain("[redacted]");
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

describe("harnessEventPayload hoists adapter ignored_settings (INV-105 from inside the run)", () => {
  it("lifts payload.ignored_settings to the projection top level, where the timeline reads it", () => {
    const disclosure: HarnessEvent = {
      type: "message",
      session_id: "ses-1",
      ts: "2026-07-25T00:00:00Z",
      text: "[effort] ignored: effort=ultra (not accepted by the resolved catalog)",
      payload: { ignored_settings: ["effort=ultra (not accepted by the resolved catalog)"] },
    };
    const projected = harnessEventPayload("codex", "a01", disclosure);
    // The timeline/live channel reads the TOP-LEVEL key (QA-070) — nested-only
    // would render a benign info row over a knob that silently went nowhere.
    expect(projected["ignored_settings"]).toEqual([
      "effort=ultra (not accepted by the resolved catalog)",
    ]);
  });

  it("adds no ignored_settings key for ordinary events", () => {
    const plain: HarnessEvent = {
      type: "message",
      session_id: "ses-1",
      ts: "2026-07-25T00:00:00Z",
      text: "working",
      payload: { note: "nothing ignored" },
    };
    expect("ignored_settings" in harnessEventPayload("codex", "a01", plain)).toBe(false);
  });
});

describe("winnerNeedsHuman (D9: winner-only NEEDS_HUMAN, fail-closed)", () => {
  const escalation = (id: string) =>
    ReviewFinding.parse({
      id,
      severity: "NEEDS_HUMAN",
      category: "security",
      claim: "high-risk change needs a human decision",
      reviewer: { harness_id: "claude" },
      status: "accepted",
    });

  it("blocks on the winner's own accepted NEEDS_HUMAN escalation", () => {
    expect(
      winnerNeedsHuman("a01", [{ attemptId: "a01", findings: [escalation("f1")] }]),
    ).toBe(true);
  });

  it("does not let a losing candidate's escalation veto a clean winner", () => {
    expect(
      winnerNeedsHuman("a01", [
        { attemptId: "a01", findings: [] },
        { attemptId: "a02", findings: [escalation("f2")] },
      ]),
    ).toBe(false);
  });

  it("ignores a proposed (non-accepted) escalation on the winner", () => {
    const proposed = ReviewFinding.parse({
      id: "f3",
      severity: "NEEDS_HUMAN",
      category: "security",
      claim: "maybe risky",
      reviewer: { harness_id: "claude" },
      status: "proposed",
    });
    expect(winnerNeedsHuman("a01", [{ attemptId: "a01", findings: [proposed] }])).toBe(false);
  });

  it("fails closed when the winner has no review evidence record at all", () => {
    expect(winnerNeedsHuman("a01", [{ attemptId: "a02", findings: [] }])).toBe(true);
    expect(winnerNeedsHuman("a01", [])).toBe(true);
  });

  it("has nothing to gate when there is no winner", () => {
    expect(winnerNeedsHuman(null, [{ attemptId: "a01", findings: [escalation("f4")] }])).toBe(
      false,
    );
  });
});
