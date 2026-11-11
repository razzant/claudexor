import { describe, expect, it } from "vitest";
import {
  continuationNotice,
  evidenceIndexPointer,
  packetContinuationPrompt,
} from "./continuity-notice.js";

describe("continuation notice", () => {
  it("is one constant notice naming the cause, never the original prompt", () => {
    const notice = continuationNotice({
      cause: "vendor_limit",
      uncertainInput: null,
      callerText: null,
    });
    expect(notice).toContain(
      "The previous process stopped (a usage limit on the previous account).",
    );
    expect(notice).toContain("Continue the task from where it stopped.");
    expect(notice).toContain("A tool call that was cut off may or may not have taken effect");
    expect(notice).toContain("self-contained final message");
    expect(notice).not.toContain("may not have been delivered");
  });

  it("carries an uncertain last input as a reference to reconcile, then the caller's text", () => {
    const notice = continuationNotice({
      cause: "transport",
      uncertainInput: "  Also rename the helper.  ",
      callerText: "Then run the tests.",
    });
    expect(notice).toContain("(an error without a typed cause)");
    expect(notice).not.toContain("died");
    expect(notice).toContain(
      "may not have been delivered. It was:\n\nAlso rename the helper.\n\nReconcile it",
    );
    expect(notice.endsWith("Then run the tests.")).toBe(true);
    expect(notice.indexOf("may not have been delivered")).toBeLessThan(
      notice.indexOf("Then run the tests."),
    );
  });

  it("builds the packet prompt from the original prompt, the notice and the evidence index", () => {
    const prompt = packetContinuationPrompt({
      originalPrompt: "WORK ORDER\n\nEngine constraints: none",
      notice: "NOTICE",
      evidencePath: "/runs/r1/attempts/a01/continuation/evidence-index.md",
      evidenceMarkdown: "# Evidence index\n\n- tool calls: 2",
    });
    expect(prompt.startsWith("WORK ORDER\n\nEngine constraints: none\n\nNOTICE\n\n")).toBe(true);
    expect(prompt).toContain(
      evidenceIndexPointer(
        "/runs/r1/attempts/a01/continuation/evidence-index.md",
        "# Evidence index\n\n- tool calls: 2",
      ),
    );
  });
});
