import { describe, expect, it } from "vitest";
import { AnswerAssembly } from "./answer-assembly.js";

describe("AnswerAssembly (F2.5 W-C1 typed finality)", () => {
  it("prefers the typed final message verbatim over joined narration", () => {
    const a = new AnswerAssembly();
    a.observe({ type: "message", text: "Working on it…" });
    a.observe({ type: "message", text: "Halfway there." });
    a.observe({ type: "message", text: "The answer is 42.", final: true });
    expect(a.text()).toBe("The answer is 42.");
  });

  it("falls back to joined narration when no final marker arrives", () => {
    const a = new AnswerAssembly();
    a.observe({ type: "message", text: "Part one." });
    a.observe({ type: "message", text: "Part one." }); // adjacent repeat dedupes
    a.observe({ type: "message", text: "Part two." });
    expect(a.text()).toBe("Part one.\nPart two.");
  });

  it("a later final wins (last-wins), and empty finals do not erase narration", () => {
    const a = new AnswerAssembly();
    a.observe({ type: "message", text: "narration" });
    a.observe({ type: "message", text: "first final", final: true });
    a.observe({ type: "message", text: "second final", final: true });
    expect(a.text()).toBe("second final");

    const b = new AnswerAssembly();
    b.observe({ type: "message", text: "kept narration" });
    b.observe({ type: "message", text: "   ", final: true });
    expect(b.text()).toBe("kept narration");
  });

  it("a whitespace final never erases a REAL earlier final, and finals are verbatim (sol #3)", () => {
    const a = new AnswerAssembly();
    a.observe({ type: "message", text: "the real answer", final: true });
    a.observe({ type: "message", text: "   \n  ", final: true });
    expect(a.text()).toBe("the real answer");

    // The accepted final keeps its exact whitespace (documented verbatim
    // contract) — no trimming.
    const b = new AnswerAssembly();
    b.observe({ type: "message", text: "  indented answer  ", final: true });
    expect(b.text()).toBe("  indented answer  ");
  });

  it("never joins display-stream delta chunks into the answer (W-C4)", () => {
    const a = new AnswerAssembly();
    a.observe({ type: "message", text: "The ", payload: { delta: true } });
    a.observe({ type: "message", text: "answer.", payload: { delta: true } });
    a.observe({ type: "message", text: "The answer." });
    expect(a.text()).toBe("The answer.");
  });

  it("ignores non-message events and auth_switched disclosures", () => {
    const a = new AnswerAssembly();
    a.observe({ type: "thinking", text: "reasoning" });
    a.observe({ type: "status", text: "api_retry: overloaded" });
    a.observe({ type: "message", text: "route switched", payload: { auth_switched: true } });
    a.observe({ type: "message", text: "real answer" });
    expect(a.text()).toBe("real answer");
  });

  it("QA-009: machineText() yields the raw envelope while text() stays the unwrapped display", () => {
    // codex constrained route: the final message DISPLAY text is the unwrapped
    // output; the raw `{work_report, output}` envelope rides a typed payload
    // field. text() is display truth (answer bubble / twin-removal); machineText()
    // is the envelope the orchestrator un-nests.
    const raw = JSON.stringify({
      work_report: { state: "completed", required_inputs: [] },
      output: "the unwrapped answer",
    });
    const a = new AnswerAssembly();
    a.observe({
      type: "message",
      text: "the unwrapped answer",
      final: true,
      payload: { final_source: "last_agent_message", work_report_envelope: raw },
    });
    expect(a.text()).toBe("the unwrapped answer");
    expect(a.machineText()).toBe(raw);
  });

  it("machineText() falls back to text() when no raw envelope is attached (claude/plain finals)", () => {
    const a = new AnswerAssembly();
    a.observe({ type: "message", text: "plain final", final: true });
    expect(a.machineText()).toBe("plain final");
    expect(a.machineText()).toBe(a.text());
  });
});
