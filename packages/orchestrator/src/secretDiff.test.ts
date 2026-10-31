import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { WorkspaceError } from "@claudexor/core";
import type { GitObjectResult, WorkspaceEnvelope } from "@claudexor/schema";
import { projectRuntimeDir, sha256, prunePatchObjects } from "@claudexor/util";
import {
  createRevertAnchorFromPatchOrNull,
  readRevertAnchor,
  type WorkspaceManager,
} from "@claudexor/workspace";

import {
  attemptDisclosure,
  captureCandidateWorkspace,
  persistFinalPatch,
  resultSummaryDisclosure,
  resultSummaryLines,
} from "./secretDiff.js";

const envelope = {
  id: "env-test",
  repo_root: "/tmp/project",
  worktree_path: "/tmp/project",
  base_sha: null,
  base_ref: null,
} as WorkspaceEnvelope;

const roots: string[] = [];
function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Fake credentials are assembled at runtime; no secret-shaped literal lives here. */
const fakeKey = (fill: string): string => ["sk", fill.repeat(24)].join("-");

function textPatch(path: string, line: string): string {
  return (
    `diff --git a/${path} b/${path}\n` +
    "new file mode 100644\n" +
    "--- /dev/null\n" +
    `+++ b/${path}\n` +
    "@@ -0,0 +1 @@\n" +
    `+${line}\n`
  );
}

function fakeManager(
  capture: () => Promise<{
    diff: string;
    captureIncomplete: boolean;
    excludedNestedRepositories?: string[];
  }>,
  retained: string[] = [],
  keptArtifacts: string[] = [],
): WorkspaceManager {
  return {
    captureDiff: capture,
    ownedArtifactRelativeDirectory: () => null,
    retainEnvelope: (env: WorkspaceEnvelope) => retained.push(env.id),
    keepArtifactDirectory: (env: WorkspaceEnvelope) => keptArtifacts.push(env.id),
  } as unknown as WorkspaceManager;
}

const capture = (
  wsm: WorkspaceManager,
  inPlace: boolean,
  extra: Partial<Parameters<typeof captureCandidateWorkspace>[0]> = {},
) =>
  captureCandidateWorkspace({
    wsm,
    envelope: (() => {
      const root = tempRoot("cx-secret-envelope-");
      mkdirSync(join(root, "home"));
      mkdirSync(join(root, "tree"));
      return {
        ...envelope,
        id: "env-test",
        task_id: "task-test",
        attempt_id: "a01",
        home_dir: join(root, "home"),
        worktree_path: join(root, "tree"),
        branch_name: null,
        created_at: new Date().toISOString(),
        workspace_kind: "git",
        policy_profile: "workspace_write",
        harness_config_dirs: {},
      } as WorkspaceEnvelope;
    })(),
    inPlace,
    holder: { runId: "run-test", runDir: tempRoot("cx-capture-run-") },
    contract: { tests: { commands: [] }, review_requested: false },
    ...extra,
  });

describe("capture refusal is the only capture-time refusal", () => {
  it.each([
    { inPlace: true, disposition: "manual_cleanup" },
    { inPlace: false, disposition: "retained" },
  ] as const)(
    "names a capture exception honestly for inPlace=$inPlace without echoing a secret",
    async ({ inPlace, disposition }) => {
      const retained: string[] = [];
      const keptArtifacts: string[] = [];
      const secret = fakeKey("s");
      const wsm = fakeManager(
        async () => {
          throw new Error(`sensitive capture sentinel ${secret}`);
        },
        retained,
        keptArtifacts,
      );

      const result = await capture(wsm, inPlace);

      expect(result.diff).toBe("");
      expect(result.captureRefusal?.disposition).toBe(disposition);
      // #535 F11: the prose carries the typed failure's diagnostic, masked: an
      // engine diagnostic is not working content (INV-146).
      expect(result.captureRefusal?.detail).toContain(
        "Detail: sensitive capture sentinel [redacted].",
      );
      expect(result.captureRefusal?.detail).not.toContain(secret);
      // The receipt names what was not recorded and what is kept, never a retry.
      expect(result.captureRefusal?.detail).toMatch(/^The changes could not be captured exactly/);
      expect(result.captureRefusal?.detail).toContain(
        inPlace
          ? "Not recorded: the exact result; a revert point; apply eligibility."
          : "Not recorded: the exact result; apply eligibility.",
      );
      expect(result.captureRefusal?.detail).toMatch(
        inPlace
          ? /changed files in .* \(already in place, not reviewed\)/
          : /retained isolated source/,
      );
      // Live media keep their run-owned directory; an isolated envelope is kept whole.
      expect(keptArtifacts).toEqual(inPlace ? ["env-test"] : []);
      expect(retained).toEqual(inPlace ? [] : ["env-test"]);
    },
  );

  it("requires manual cleanup when isolated capture scratch cleanup is unproven", async () => {
    const error = new WorkspaceError("transient diff scratch cleanup failed", {
      cause: new Error("sensitive cleanup error"),
    });
    Object.defineProperty(error, "cleanupError", {
      value: new Error("sensitive cleanup error"),
      enumerable: false,
    });
    const wsm = fakeManager(async () => {
      throw error;
    });

    const result = await capture(wsm, false);

    expect(result.captureRefusal).toMatchObject({
      disposition: "retained",
      failure: { cleanup: { message: "sensitive cleanup error" } },
    });
    expect(result.captureRefusal?.detail).not.toContain("sensitive");
  });

  it("turns an incomplete capture into a refusal instead of a fabricated empty result", async () => {
    const wsm = fakeManager(async () => ({
      diff: "",
      captureIncomplete: true,
    }));

    const result = await capture(wsm, true);

    expect(result.diff).toBe("");
    expect(result.captureRefusal).toMatchObject({ disposition: "manual_cleanup" });
    expect(result.captureRefusal?.detail).toMatch(/could not be captured exactly/);
  });
});

describe("credential-shaped content is ordinary exact work (#555)", () => {
  it("keeps the exact in-place diff, with no saved-copy mask or disclosure", async () => {
    const secret = fakeKey("r");
    const patch = textPatch("LEAK.txt", secret);
    const wsm = fakeManager(async () => ({
      diff: patch,
      captureIncomplete: false,
    }));

    const result = await capture(wsm, true);

    expect(result).toEqual({ diff: patch });
  });

  it("discloses the nested repositories a capture left out, exactly", async () => {
    const patch = textPatch("notes.txt", "plain text");
    const name = `.review-evidence/${fakeKey("n")}`;
    const kept = await capture(
      fakeManager(async () => ({
        diff: patch,
        captureIncomplete: false,
        excludedNestedRepositories: [name, ".review-evidence/base-copy"],
      })),
      true,
    );
    expect(kept.diff).toBe(patch);
    expect(attemptDisclosure(kept)).toEqual({
      excluded_nested_repositories: [".review-evidence/base-copy", name].sort(),
    });
    const plain = await capture(
      fakeManager(async () => ({ diff: patch, captureIncomplete: false })),
      true,
    );
    expect(attemptDisclosure(plain)).not.toHaveProperty("excluded_nested_repositories");
  });
});

describe("persistFinalPatch", () => {
  function storeFor(prefix: string) {
    const repo = tempRoot(prefix);
    const store = new ArtifactStore(repo, { claudexorDir: join(repo, "runtime") });
    roots.push(projectRuntimeDir(repo));
    return { repo, store, paths: store.createRun("run-v4c") };
  }

  it("shares the real attempt, final and anchor writers without changing their readers", async () => {
    const repo = tempRoot("claudexor-shared-patch-");
    const store = new ArtifactStore(repo);
    roots.push(store.claudexorDir);
    const paths = store.createRun("run-shared");
    const diff = textPatch("SAFE.txt", "ordinary output");
    const attempt = join(paths.attemptsDir, "a01", "patch.diff");
    store.writePatch(attempt, diff);
    const final = persistFinalPatch(store, paths.finalDir, { diff });
    const anchor = createRevertAnchorFromPatchOrNull(repo, diff)!;
    const anchorPath = join(store.claudexorDir, "anchors", "objects", `${anchor.slice(7)}.patch`);
    expect(
      new Set(
        [attempt, join(paths.finalDir, "patch.diff"), anchorPath].map(
          (path) => lstatSync(path).ino,
        ),
      ).size,
    ).toBe(1);
    expect(readRevertAnchor(repo, anchor)).toBe(diff);
    expect(final.patchSha256).toBe(anchor);
    rmSync(paths.root, { recursive: true });
    expect(await prunePatchObjects(store.claudexorDir, false)).toBe(0);
    expect(readRevertAnchor(repo, anchor)).toBe(diff);
  });

  it("saves the exact patch and binds the digest to those same bytes", () => {
    const { repo, store, paths } = storeFor("claudexor-v4c-final-");
    const secret = fakeKey("p");
    const diff = textPatch("LEAK.txt", secret);

    const saved = persistFinalPatch(store, paths.finalDir, { diff });

    expect(readFileSync(join(paths.finalDir, "patch.diff"), "utf8")).toBe(diff);
    expect(saved).toEqual({ patchSha256: sha256(diff), meta: {} });
    // No parallel exact-object store is written for the final patch.
    expect(() => readRevertAnchor(repo, saved.patchSha256!)).toThrow();
  });

  it("records the nested repositories the patch left out", () => {
    const { store, paths } = storeFor("claudexor-v4c-final-nested-");
    const diff = textPatch("SAFE.txt", "safe");

    const saved = persistFinalPatch(store, paths.finalDir, {
      diff,
      excludedNestedRepositories: [".review-evidence/copy", ".review-evidence/copy"],
    });

    expect(readFileSync(join(paths.finalDir, "patch.diff"), "utf8")).toBe(diff);
    expect(saved.meta).toEqual({ excluded_nested_repositories: [".review-evidence/copy"] });
  });
});

describe("work-product summary lines (#535 composed with #555)", () => {
  const result: GitObjectResult = {
    schema: "git_objects/v1",
    object_format: "sha1",
    base_tree: "a".repeat(40),
    candidate_tree: "b".repeat(40),
    base_commit: null,
    store_boundary_commit: null,
    digest: `sha256:${"c".repeat(64)}`,
  };
  const omitted = [
    { path: "big.png", reason: "over_file_cap" as const, bytes: 16 * 1024 * 1024 + 1 },
  ];
  const imagesLine =
    "- Images not saved: 1 (big.png: over the 16 MiB per-image cap, 16777217 bytes)";

  it("names unsaved images exactly as main's summary did, and nothing for a clean run", () => {
    expect(resultSummaryLines({ result, producedOmitted: omitted })).toBe(imagesLine);
    expect(resultSummaryDisclosure({ result, producedOmitted: omitted })).toBe(`\n${imagesLine}`);
    expect(resultSummaryDisclosure({ result, producedOmitted: [] })).toBe("");
    expect(resultSummaryLines(undefined)).toBeNull();
  });

  it("keeps both the unsaved images and the unrendered result, images first", () => {
    const lines = resultSummaryLines({
      result,
      patchViewUnavailable: {
        reason: "exceeds_view_limit",
        limitBytes: 268_435_456,
        estimatedBytes: 300_000_000,
      },
      inventory: { exact: false, changedFiles: 1, largest: [] },
      producedOmitted: omitted,
    })?.split("\n");
    expect(lines).toEqual([
      imagesLine,
      `- Result: kept exactly as Git objects (sha256:${"c".repeat(64)}); too large to show as one patch` +
        " (estimated 300000000 bytes, view limit 268435456). It can still be verified, applied and reverted.",
      "  Largest changed files (inventory, not exact, not a patch): 1 changed, 1 not listed",
    ]);
  });
});
