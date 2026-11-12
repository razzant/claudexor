import { describe, expect, it } from "vitest";
import { redactSecrets } from "@claudexor/util";
import { unrenderedResultNotice } from "./resultNotice.js";
import { resultSummaryLines } from "./secretDiff.js";

const result = {
  schema: "git_objects/v1" as const,
  object_format: "sha1" as const,
  base_tree: "1".repeat(40),
  candidate_tree: "2".repeat(40),
  base_commit: null,
  store_boundary_commit: null,
  digest: `sha256:${"a".repeat(64)}`,
};
const view = (reason: "exceeds_view_limit" | "render_failed") => ({
  reason,
  limitBytes: 100,
  estimatedBytes: 10,
});

describe("what a result with no patch view says about why", () => {
  it("is too large only when it exceeded the limit", () => {
    const run = { result, patchViewUnavailable: view("exceeds_view_limit") };
    expect(unrenderedResultNotice(run)).toContain("too large to render as one patch");
    expect(resultSummaryLines(run)).toContain("too large to show as one patch");
  });

  it("failed to render when that is what happened, and stays exact and deliverable", () => {
    const run = { result, patchViewUnavailable: view("render_failed") };
    const notice = unrenderedResultNotice(run);
    expect(notice).toContain("could not be rendered");
    expect(notice).not.toContain("too large");
    const summary = resultSummaryLines(run);
    expect(summary).toContain("its patch view could not be rendered");
    expect(summary).not.toContain("too large");
    expect(summary).toContain("It can still be verified, applied and reverted.");
  });
});

// #535 round 9: the notice review and synthesis read for an unrendered result is
// working content (INV-146): every changed path in it is exact.
describe("the notice of an unrendered result", () => {
  it("names a credential-shaped changed path exactly", () => {
    const name = `${"ghp_"}${"a1".repeat(18)}.txt`;
    // The fixture really is a name the diagnostic mask rewrites.
    expect(redactSecrets(name)).not.toBe(name);

    const notice = unrenderedResultNotice({
      patchViewUnavailable: {
        reason: "exceeds_view_limit",
        limitBytes: 4096,
        estimatedBytes: 4097,
      },
      inventory: {
        exact: false,
        changedFiles: 1,
        largest: [{ path: name, change: "added", sizeBytes: 4 }],
      },
      changedPaths: [name],
    });

    expect(notice).toContain(`# - added ${name} · `);
    expect(notice).not.toContain("[redacted]");
  });
});
