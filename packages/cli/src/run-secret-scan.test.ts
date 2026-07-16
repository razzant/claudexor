import { describe, expect, it } from "vitest";
import { assertCliRunParamsHaveNoInlineSecrets } from "./run-secret-scan.js";

describe("assertCliRunParamsHaveNoInlineSecrets", () => {
  it("rejects secret-like reviewer panel models before CLI run artifacts can persist them", () => {
    const secret = "sk-" + "a".repeat(24);

    expect(() =>
      assertCliRunParamsHaveNoInlineSecrets({
        reviewerPanel: [{ harness: "claude", model: secret }],
      }),
    ).toThrow(/CLI run params/);
  });

  it("rejects secret-like protected path approvals before TaskContract persistence", () => {
    const secret = "sk-or-v1-" + "b".repeat(40);

    expect(() =>
      assertCliRunParamsHaveNoInlineSecrets({
        protectedPathApprovals: [{ path: secret }],
      }),
    ).toThrow(/CLI run params/);
  });

  it("HARD-BLOCKS a secret-like value inside the prompt itself (prompts are durable artifacts; no bypass)", () => {
    const jwt = "eyJ" + "a".repeat(12) + "." + "b".repeat(12) + "." + "c".repeat(8);
    let err: unknown;
    try {
      assertCliRunParamsHaveNoInlineSecrets({ prompt: `use this token: ${jwt}`, mode: "agent" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    // Typed error with actionable remediation, not a generic refusal.
    expect((err as Error).message).toContain("$.prompt");
    expect((err as Error).message).toContain("durable run artifacts");
    expect((err as Error).message).toContain("claudexor secrets set");
    expect((err as { code?: string }).code).toBe("inline_secret_rejected");
    expect((err as { status?: number }).status).toBe(400);
  });

  it("HARD-BLOCKS a secret-like value inside per-run instructions (durable like the prompt; W5/INV-062)", () => {
    const jwt = "eyJ" + "a".repeat(12) + "." + "b".repeat(12) + "." + "c".repeat(8);
    let err: unknown;
    try {
      assertCliRunParamsHaveNoInlineSecrets({
        prompt: "do it",
        instructions: `always send with header: ${jwt}`,
        mode: "agent",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("$.instructions");
    expect((err as { code?: string }).code).toBe("inline_secret_rejected");
    expect((err as { status?: number }).status).toBe(400);
  });

  it("still accepts prose that merely talks about tokens (patterns are value-shaped) — across modes", () => {
    for (const mode of ["ask", "plan", "audit", "agent", "orchestrate"]) {
      expect(() =>
        assertCliRunParamsHaveNoInlineSecrets({
          prompt: "find where Bearer tokens are parsed and how the api key env var is read",
          mode,
        }),
      ).not.toThrow();
    }
  });

  it("a secret in a non-prompt field named like 'prompter' gets the GENERIC remediation (path detection is exact)", () => {
    const secret = "sk-" + "m".repeat(24);
    let err: unknown;
    try {
      assertCliRunParamsHaveNoInlineSecrets({ prompter: secret });
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toContain("refs/profiles");
    expect((err as Error).message).not.toContain("durable run artifacts");
  });

  it("rejects a secret-like value in attachment-adjacent prompt arrays too", () => {
    const key = "sk-ant-" + "k".repeat(24);
    expect(() =>
      assertCliRunParamsHaveNoInlineSecrets({
        prompt: ["part one", `part two ${key}`],
      }),
    ).toThrow(/\$\.prompt\[1\]/);
  });
});
