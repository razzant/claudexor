import { describe, expect, it } from "vitest";
import { validateSurfaceRunControls } from "./surface-run-controls.js";

describe("surface run-control applicability", () => {
  it("validates whole-run timer fields through their shared schema", () => {
    expect(validateSurfaceRunControls({ maxSeconds: 1, timeLimitMode: "soft" })).toBeNull();
    expect(validateSurfaceRunControls({ maxSeconds: 0 })).toContain("maxSeconds");
    expect(validateSurfaceRunControls({ timeLimitMode: "forever" })).toContain("timeLimitMode");
  });
  it("validates model-review opt-in and contradictions through the shared owner", () => {
    expect(validateSurfaceRunControls({ review: "false" })).toMatch(/boolean/);
    expect(validateSurfaceRunControls({ review: false, attempts: 3 })).toBeNull();
    expect(validateSurfaceRunControls({ review: true })).toBeNull();
    expect(
      validateSurfaceRunControls({ review: false, reviewerPanel: [{ harness: "codex" }] }),
    ).toMatch(/conflicts/);
  });
  it.each(["ask", "plan"] as const)("rejects Agent-only controls on %s", (mode) => {
    expect(validateSurfaceRunControls({ mode, review: false })).toMatch(/review only applies/);
    expect(validateSurfaceRunControls({ mode, reviewerPanel: [{ harness: "codex" }] })).toMatch(
      /reviewerPanel.*Agent/i,
    );
    expect(
      validateSurfaceRunControls({ mode, protectedPathApprovals: [{ path: "test/**" }] }),
    ).toMatch(/protectedPathApprovals.*Agent/i);
    expect(validateSurfaceRunControls({ mode, tests: [] })).toMatch(/tests.*agent/i);
  });

  it("projects Ask and Plan strategy applicability through the same owner", () => {
    expect(validateSurfaceRunControls({ mode: "agent", deepScan: true })).toMatch(/ask strategy/);
    expect(validateSurfaceRunControls({ mode: "ask", council: true })).toMatch(/plan strategy/);
    expect(validateSurfaceRunControls({ mode: "ask", deepScan: true })).toBeNull();
    expect(validateSurfaceRunControls({ mode: "plan", council: true })).toBeNull();
  });

  it("accepts the same controls on Agent", () => {
    expect(
      validateSurfaceRunControls({
        mode: "agent",
        reviewerPanel: [{ harness: "codex" }],
        protectedPathApprovals: [{ path: "test/**" }],
      }),
    ).toBeNull();
  });

  it("accepts and validates the optional strict reviewer profile identity", () => {
    expect(
      validateSurfaceRunControls({
        mode: "agent",
        reviewerPanel: [{ harness: "cursor", credentialProfileId: "work" }],
      }),
    ).toBeNull();
    expect(
      validateSurfaceRunControls({
        mode: "agent",
        reviewerPanel: [{ harness: "cursor", credentialProfileId: "   " }],
      }),
    ).toMatch(/credentialProfileId.*non-empty/i);
  });
});
