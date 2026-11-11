import { describe, expect, it } from "vitest";
import { validateRunControls } from "./validate.js";

describe("ACP run-control applicability", () => {
  it("accepts explicit soft or legacy hard limits and rejects malformed timer controls", () => {
    expect(validateRunControls({ maxSeconds: 60, timeLimitMode: "soft" })).toBeNull();
    expect(validateRunControls({ maxSeconds: 60 })).toBeNull();
    expect(validateRunControls({ maxSeconds: 0 })?.message).toContain("maxSeconds");
    expect(validateRunControls({ maxSeconds: 604801 })?.message).toContain("maxSeconds");
    expect(validateRunControls({ timeLimitMode: "forever" })?.message).toContain("timeLimitMode");
  });
  it("accepts the shared execution object and validates its complete shape", () => {
    expect(
      validateRunControls({
        mode: "agent",
        processingPreference: "standard",
        execution: { workspaceKind: "directory", scopePaths: ["data", "binary.dat"] },
        reviewerPanel: [{ harness: "claude", processingPreference: "fast" }],
      }),
    ).toBeNull();
    expect(
      validateRunControls({ execution: { auxiliaryWritableRoots: ["/srv/cache"] } }),
    ).toBeNull();
    expect(validateRunControls({ execution: { auxiliaryWritableRoots: [""] } })?.message).toContain(
      "auxiliaryWritableRoots",
    );
    expect(validateRunControls({ processingPreference: "fastest" })?.message).toContain(
      "processingPreference",
    );
    expect(validateRunControls({ execution: { workspaceKind: "folder" } })?.message).toContain(
      "execution",
    );
    expect(
      validateRunControls({ execution: { workspaceKind: "directory", scopePaths: ["../other"] } })
        ?.message,
    ).toContain("scopePaths");
  });
  it.each(["ask", "plan"] as const)("rejects Agent-only controls on %s", (mode) => {
    expect(validateRunControls({ mode, reviewerPanel: [{ harness: "codex" }] })?.message).toMatch(
      /reviewerPanel.*Agent/i,
    );
    expect(
      validateRunControls({ mode, protectedPathApprovals: [{ path: "test/**" }] })?.message,
    ).toMatch(/protectedPathApprovals.*Agent/i);
    expect(validateRunControls({ mode, tests: [] })?.message).toMatch(/tests.*agent/i);
  });

  it("rejects cross-mode Ask and Plan strategy fields at the ACP boundary", () => {
    expect(validateRunControls({ mode: "agent", deepScan: true })?.message).toMatch(/ask strategy/);
    expect(validateRunControls({ mode: "ask", council: true })?.message).toMatch(/plan strategy/);
    expect(validateRunControls({ mode: "ask", deepScan: true })).toBeNull();
    expect(validateRunControls({ mode: "plan", council: true })).toBeNull();
    expect(validateRunControls({ mode: "ask", race: true })?.message).toMatch(/Agent strategy/);
    expect(validateRunControls({ mode: "plan", race: true })?.message).toMatch(/Agent strategy/);
    expect(validateRunControls({ mode: "agent", race: true })).toBeNull();
  });

  it("accepts reviewers and approvals on Agent", () => {
    expect(
      validateRunControls({
        mode: "agent",
        reviewerPanel: [{ harness: "codex", credentialProfileId: "reviewer-a" }],
        protectedPathApprovals: [{ path: "test/**" }],
      }),
    ).toBeNull();
  });

  it("accepts a strict per-turn credentialProfileId and rejects a blank one", () => {
    expect(validateRunControls({ mode: "ask", credentialProfileId: "work-secondary" })).toBeNull();
    expect(validateRunControls({ credentialProfileId: "   " })?.message).toMatch(
      /credentialProfileId.*non-empty/,
    );
  });

  it("accepts credential-shaped fixtures in the prompt exactly (INV-146)", () => {
    expect(
      validateRunControls({
        mode: "agent",
        prompt: `review: sk-${"a".repeat(32)} and Authorization: Bearer ${"b".repeat(32)}`,
      }),
    ).toBeNull();
  });
});
