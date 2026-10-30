import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { WorkspaceError } from "@claudexor/core";
import type { WorkspaceEnvelope } from "@claudexor/schema";
import { projectRuntimeDir, sha256, prunePatchObjects } from "@claudexor/util";
import {
  createRevertAnchorFromPatchOrNull,
  readRevertAnchor,
  type WorkspaceManager,
} from "@claudexor/workspace";

import { attemptDisclosure, captureCandidateWorkspace, persistFinalPatch } from "./secretDiff.js";

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
    binarySecretPaths: string[];
    captureIncomplete: boolean;
    excludedNestedRepositories?: string[];
  }>,
  retained: string[] = [],
): WorkspaceManager {
  return {
    captureDiff: capture,
    ownedArtifactRelativeDirectory: () => null,
    retainEnvelope: (env: WorkspaceEnvelope) => retained.push(env.id),
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
    ...extra,
  });

describe("capture refusal is the only capture-time refusal", () => {
  it.each([
    { inPlace: true, disposition: "manual_cleanup" },
    { inPlace: false, disposition: "retained" },
  ] as const)(
    "names a capture exception honestly for inPlace=$inPlace without echoing it",
    async ({ inPlace, disposition }) => {
      const wsm = fakeManager(async () => {
        throw new Error("sensitive capture sentinel");
      });

      const result = await capture(wsm, inPlace);

      expect(result.diff).toBe("");
      expect(result.captureRefusal?.disposition).toBe(disposition);
      expect(result.captureRefusal?.detail).not.toContain("sensitive capture sentinel");
      expect(result.captureRefusal?.detail).toMatch(
        inPlace ? /changed files are untouched/ : /retained/,
      );
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
      binarySecretPaths: [],
      captureIncomplete: true,
    }));

    const result = await capture(wsm, true);

    expect(result.diff).toBe("");
    expect(result.captureRefusal).toMatchObject({ disposition: "manual_cleanup" });
    expect(result.captureRefusal?.detail).toMatch(/could not be captured as a complete patch/);
  });
});

describe("credential-shaped content is ordinary exact work (#555)", () => {
  it("keeps the exact in-place diff, with no saved-copy mask or disclosure", async () => {
    const secret = fakeKey("r");
    const patch = textPatch("LEAK.txt", secret);
    const wsm = fakeManager(async () => ({
      diff: patch,
      binarySecretPaths: [],
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
        binarySecretPaths: [],
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
      fakeManager(async () => ({ diff: patch, binarySecretPaths: [], captureIncomplete: false })),
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
    expect(() => readRevertAnchor(repo, saved.patchSha256)).toThrow();
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
