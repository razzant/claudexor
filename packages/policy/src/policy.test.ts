import { describe, expect, it } from "vitest";
import { pathGuard, requireHuman } from "./policy.js";
import { classifyRisk, reviewDepthForRisk } from "./risk.js";

describe("classifyRisk", () => {
  it("flags credentials/secrets as critical", () => {
    expect(classifyRisk({ changedPaths: ["config/secrets/db.json"] }).level).toBe("critical");
  });
  it("flags auth/migrations as high", () => {
    expect(classifyRisk({ changedPaths: ["src/auth/login.ts"] }).level).toBe("high");
    expect(classifyRisk({ changedPaths: ["db/migrations/001.sql"] }).level).toBe("high");
  });
  it("dependency change + large diff is high", () => {
    expect(classifyRisk({ changedPaths: ["package.json"], additions: 600 }).level).toBe("high");
  });
  it("small isolated change is low", () => {
    expect(classifyRisk({ changedPaths: ["src/util.ts"], additions: 3, deletions: 1 }).level).toBe("low");
  });
  it("normal multi-file change is medium", () => {
    const r = classifyRisk({ changedPaths: ["a.ts", "b.ts", "c.ts"], additions: 120 });
    expect(r.level).toBe("medium");
  });
  it("review depth scales with risk", () => {
    expect(reviewDepthForRisk("critical")).toEqual({ reviewers: 2, crossFamily: true, humanApproval: true });
    expect(reviewDepthForRisk("low").crossFamily).toBe(false);
  });
});

describe("pathGuard", () => {
  it("allows writes inside the workspace and blocks escapes", () => {
    expect(pathGuard("/ws", "/ws/src/a.ts").allowed).toBe(true);
    expect(pathGuard("/ws", "src/a.ts").allowed).toBe(true);
    expect(pathGuard("/ws", "/etc/passwd").allowed).toBe(false);
    expect(pathGuard("/ws", "../outside.ts").allowed).toBe(false);
  });
});

describe("requireHuman", () => {
  it("requires human for protected paths, additional patterns escalate too", () => {
    expect(requireHuman(["src/auth/x.ts"]).required).toBe(true);
    expect(requireHuman(["src/util.ts"]).required).toBe(false);
    expect(requireHuman(["infra/prod.tf"], ["**/infra/**"]).required).toBe(true);
  });
});
