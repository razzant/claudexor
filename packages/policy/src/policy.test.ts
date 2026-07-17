import { describe, expect, it } from "vitest";
import { pathGuard, requireHuman } from "./policy.js";
import { classifyRisk, reviewDepthForRisk } from "./risk.js";

describe("classifyRisk", () => {
  it("flags credentials/secrets as critical", () => {
    expect(classifyRisk({ changedPaths: ["config/secrets/db.json"] }).level).toBe("critical");
    expect(classifyRisk({ changedPaths: ["certs/signing.key"] }).level).toBe("critical");
    expect(classifyRisk({ changedPaths: ["home/.ssh/id_ed25519"] }).level).toBe("critical");
    expect(classifyRisk({ changedPaths: [".env.example"], additions: 1 }).level).toBe("low");
  });
  it("flags auth/migrations as high", () => {
    expect(classifyRisk({ changedPaths: ["src/auth/login.ts"] }).level).toBe("high");
    expect(classifyRisk({ changedPaths: ["db/migrations/001.sql"] }).level).toBe("high");
  });
  it("dependency change + large diff is high", () => {
    expect(classifyRisk({ changedPaths: ["package.json"], additions: 600 }).level).toBe("high");
  });
  it("small isolated change is low", () => {
    expect(classifyRisk({ changedPaths: ["src/util.ts"], additions: 3, deletions: 1 }).level).toBe(
      "low",
    );
  });
  it("normal multi-file change is medium", () => {
    const r = classifyRisk({ changedPaths: ["a.ts", "b.ts", "c.ts"], additions: 120 });
    expect(r.level).toBe("medium");
  });
  it("matches BOTH ends of a rename — moving a sensitive file out stays critical (G1)", () => {
    // `git mv .env config/settings.txt`: the new side is innocuous, so a
    // new-side-only projection reads "low" and the human gate never fires.
    const moved = classifyRisk({
      changedPaths: ["config/settings.txt", ".env"],
      fileCount: 1,
    });
    expect(moved.level).toBe("critical");
    expect(moved.matchedPaths).toContain(".env");
  });
  it("counts FILES, not touched paths: renames do not inflate the size heuristic", () => {
    // 15 renames = 30 touched paths but 15 changed files: under LARGE_DIFF_FILES.
    const renames = Array.from({ length: 15 }, (_, i) => [`new/f${i}.ts`, `old/f${i}.ts`]).flat();
    const r = classifyRisk({ changedPaths: renames, fileCount: 15, additions: 10 });
    expect(r.level).toBe("medium");
    expect(r.reasons.join(" ")).not.toContain("large diff");
    // The count the caller declares is the one reported, not the touched total.
    const large = classifyRisk({ changedPaths: renames, fileCount: 25, additions: 10 });
    expect(large.reasons.join(" ")).toContain("large diff (25 files");
  });
  it("review depth scales with risk", () => {
    expect(reviewDepthForRisk("critical")).toEqual({
      reviewers: 2,
      crossFamily: true,
      humanApproval: true,
    });
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
