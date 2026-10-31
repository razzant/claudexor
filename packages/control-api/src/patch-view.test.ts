import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { readArtifact } from "./artifact-read.js";
import { unrenderedPatchView } from "./patch-view.js";

// A disk that answers an I/O error from the second read of one file on.
let failingAfterFirstRead: string | null = null;
let reads = 0;
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const read = fs.readFileSync as (...args: unknown[]) => unknown;
  return {
    ...fs,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      if (failingAfterFirstRead && fs.existsSync(String(path)))
        if (fs.realpathSync(String(path)) === failingAfterFirstRead && ++reads > 1)
          throw Object.assign(new Error(`EIO: i/o error, read '${String(path)}'`), {
            code: "EIO",
          });
      return read(path, ...rest);
    }) as typeof fs.readFileSync,
  };
});

const dirs: string[] = [];
afterEach(() => {
  failingAfterFirstRead = null;
  reads = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runWithView(reason: string) {
  const root = mkdtempSync(join(tmpdir(), "cx-patch-view-"));
  dirs.push(root);
  mkdirSync(join(root, "final"));
  writeFileSync(
    join(root, "final/work_product.yaml"),
    stringify({
      meta: { patch_view: { available: false, reason, limitBytes: 100, estimatedBytes: 10 } },
    }),
  );
  return root;
}

describe("the typed answer for an absent patch view", () => {
  it("says a result is too large only when it is", () => {
    expect(
      unrenderedPatchView(runWithView("exceeds_view_limit"), "final/patch.diff"),
    ).toMatchObject({
      code: "patch_view_unavailable",
      reason: "exceeds_view_limit",
      error: expect.stringContaining("too large to render as one patch"),
    });
  });

  it("says a failed render failed", () => {
    const answer = unrenderedPatchView(runWithView("render_failed"), "final/patch.diff");
    expect(answer).toMatchObject({
      code: "patch_view_unavailable",
      reason: "render_failed",
      error: expect.stringContaining("could not be rendered"),
    });
    expect(answer!["error"]).not.toContain("too large");
    expect(answer!["error"]).toContain("can still be applied, verified and reverted");
  });
});

/** A Git result's run whose patch view is not rendered, as the route reads it. */
function unrenderedRun() {
  const root = mkdtempSync(join(tmpdir(), "cx-patch-view-run-"));
  dirs.push(root);
  mkdirSync(join(root, "final"));
  writeFileSync(
    join(root, "final/work_product.yaml"),
    stringify({
      id: "wp",
      kind: "patch",
      source_task_id: "task-1",
      producer_attempt_id: "a01",
      meta: {
        result_kind: "patch",
        patch_view: {
          available: false,
          reason: "exceeds_view_limit",
          limitBytes: 100,
          estimatedBytes: 1000,
        },
      },
    }),
  );
  return root;
}

const patchOf = (root: string) =>
  readArtifact({ kind: "fetch", root, relative: "final/patch.diff", runArtifact: true });

// #535 R5 E1: the route reads the record twice (strictly, then for its view). A read
// error the second time was swallowed into "no such artifact", which the macOS app
// shows as "No changes in this run". Only a record that is not there is no view.
describe("the patch artifact of a result through the artifact read", () => {
  it("answers an unrendered result's typed 413 (the control)", () => {
    expect(patchOf(unrenderedRun())).toMatchObject({
      kind: "error",
      status: 413,
      body: { code: "patch_view_unavailable", reason: "exceeds_view_limit" },
    });
  });

  it("fails with the read error when the record cannot be read, never a 404", () => {
    const root = unrenderedRun();
    failingAfterFirstRead = realpathSync(join(root, "final/work_product.yaml"));
    expect(() => patchOf(root)).toThrow(/EIO/);
  });

  it("still answers 404 for a directory result, which has no patch view", () => {
    const root = mkdtempSync(join(tmpdir(), "cx-patch-view-files-"));
    dirs.push(root);
    mkdirSync(join(root, "final/files"), { recursive: true });
    const manifest = JSON.stringify({
      version: 1,
      sourceRoot: root,
      executionRoot: join(root, "execution"),
      isolation: "envelope",
      scopePaths: [],
      complete: true,
      entries: [],
    });
    writeFileSync(join(root, "final/files/manifest.json"), manifest);
    writeFileSync(
      join(root, "final/work_product.yaml"),
      stringify({
        id: "wp",
        kind: "files",
        source_task_id: "task-1",
        producer_attempt_id: "a01",
        files: { manifest: "final/files/manifest.json" },
        meta: {
          manifest_sha256: `sha256:${createHash("sha256").update(manifest).digest("hex")}`,
        },
      }),
    );
    expect(patchOf(root)).toMatchObject({ kind: "error", status: 404 });
  });
});
