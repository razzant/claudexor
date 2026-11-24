import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "@claudexor/workspace";
import { DecisionRecord, WorkProduct, makeOutcomeFacts } from "@claudexor/schema";
import { validateApplyGate, verifyAndDeliverFiles } from "./index.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claudexor-files-delivery-test-"));
  roots.push(root);
  const source = join(root, "source"),
    artifactRoot = join(root, "run");
  await mkdir(source);
  await writeFile(join(source, "a.txt"), "original");
  await writeFile(join(source, "context.txt"), "unchanged input");
  const manager = new WorkspaceManager(source, { runtimeRoot: join(root, "runtime") });
  const env = await manager.create({
    taskId: "t",
    attemptId: "a",
    workspaceKind: "directory",
    scopePaths: ["."],
  });
  await writeFile(join(env.worktree_path, "a.txt"), "prepared");
  await writeFile(join(env.worktree_path, "output.bin"), Buffer.from([0, 255, 1]));
  const captured = await manager.captureFiles(env, artifactRoot);
  await manager.dispose(env);
  return {
    root,
    source,
    candidate: {
      manifest: captured.manifest,
      manifestSha256: captured.manifestSha256,
      artifactRoot,
    },
  };
}

describe("directory delivery", () => {
  it("fresh-verifies the retained selected baseline and bytes, then shares normal idempotent delivery", async () => {
    const f = await fixture();
    const delivered = await verifyAndDeliverFiles(
      f.source,
      f.candidate,
      {},
      [
        {
          id: "check-retained-input-and-output",
          program: process.execPath,
          args: [
            "-e",
            "const fs=require('node:fs');if(fs.readFileSync('context.txt','utf8')!=='unchanged input'||fs.readFileSync('a.txt','utf8')!=='prepared'||fs.readFileSync('output.bin')[1]!==255)process.exit(3)",
          ],
        },
      ],
      (finalVerify) =>
        validateApplyGate({
          state: "succeeded",
          decision: DecisionRecord.parse({
            winner: "a",
            facts: makeOutcomeFacts("succeeded", { review: "not_run", review_requested: false }),
          }),
          workProduct: WorkProduct.parse({
            id: "wp",
            kind: "files",
            source_task_id: "t",
            files: { manifest: "final/files/manifest.json" },
            meta: { manifest_sha256: f.candidate.manifestSha256 },
          }),
          patch: "",
          filesManifest: f.candidate.manifest,
          manifestSha256: f.candidate.manifestSha256,
          originalRepoRoot: f.source,
          targetRepoRoot: f.source,
          finalVerify,
        }),
    );
    expect(delivered).toMatchObject({
      applied: true,
      treeMutated: true,
      finalVerify: { attempted: true, applied_cleanly: true, gates_passed: true },
    });
    expect(delivered.targetPreimageSha).toMatch(/^sha256:/);
    expect(await readFile(join(f.source, "a.txt"), "utf8")).toBe("prepared");
    expect(await verifyAndDeliverFiles(f.source, f.candidate)).toMatchObject({
      applied: true,
      alreadyApplied: true,
      treeMutated: false,
    });
  });

  it("honors selected changes without overwriting another output", async () => {
    const f = await fixture();
    const delivered = await verifyAndDeliverFiles(f.source, f.candidate, { paths: ["output.bin"] });
    expect(delivered).toMatchObject({ applied: true, appliedPaths: ["output.bin"] });
    expect(await readFile(join(f.source, "a.txt"), "utf8")).toBe("original");
  });

  it("catches an edit between verification and mutation while retaining the later bytes", async () => {
    const f = await fixture();
    const delivered = await verifyAndDeliverFiles(f.source, f.candidate, {}, [], () => {
      writeFileSync(join(f.source, "a.txt"), "owner edited during verify");
      return null;
    });
    expect(delivered).toMatchObject({ applied: false, treeMutated: false, refused: true });
    expect(await readFile(join(f.source, "a.txt"), "utf8")).toBe("owner edited during verify");
  });

  it("retains verifier failure and refuses a changed manifest digest", async () => {
    const f = await fixture();
    expect(
      await verifyAndDeliverFiles(f.source, f.candidate, {}, [
        { id: "failure", program: process.execPath, args: ["-e", "process.exit(9)"] },
      ]),
    ).toMatchObject({ applied: false, treeMutated: false, finalVerify: { gates_passed: false } });
    expect(
      await verifyAndDeliverFiles(f.source, {
        ...f.candidate,
        manifestSha256: `sha256:${"0".repeat(64)}`,
      }),
    ).toMatchObject({ applied: false, treeMutated: false, finalVerify: { applied_cleanly: null } });
    expect(await readFile(join(f.source, "a.txt"), "utf8")).toBe("original");
  });

  it("a run stopped before its final verification launches no gate and delivers nothing", async () => {
    const f = await fixture();
    const marker = join(f.root, "gate-ran");
    const stop = new AbortController();
    stop.abort("run_deadline_expired");
    const delivered = await verifyAndDeliverFiles(f.source, f.candidate, { signal: stop.signal }, [
      {
        id: "would-run",
        program: process.execPath,
        args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
      },
    ]);
    expect(delivered).toMatchObject({
      applied: false,
      treeMutated: false,
      finalVerify: {
        applied_cleanly: null,
        reason: "the run was stopped during final verification",
      },
    });
    expect(await readFile(marker, "utf8").catch(() => "never ran")).toBe("never ran");
    expect(await readFile(join(f.source, "a.txt"), "utf8")).toBe("original");
  });
});
