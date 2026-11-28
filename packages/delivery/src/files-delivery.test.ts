import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  truncate,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileCopyHost, WorkspaceManager } from "@claudexor/workspace";
import {
  ControlDeliveryResponse,
  DecisionRecord,
  FinalVerifyRecord,
  WorkProduct,
  makeOutcomeFacts,
} from "@claudexor/schema";
import { validateApplyGate, verifyAndDeliverFiles } from "./index.js";
import {
  filesDeliverySpaceFailure,
  filesVerifyRefusal,
  finalVerifyFiles,
  finalVerifySpaceFailure,
} from "./files-verifier.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(big = false, hugeOutput = false) {
  const root = await mkdtemp(join(tmpdir(), "claudexor-files-delivery-test-"));
  roots.push(root);
  const source = join(root, "source"),
    artifactRoot = join(root, "run");
  await mkdir(source);
  await writeFile(join(source, "a.txt"), "original");
  await writeFile(join(source, "context.txt"), "unchanged input");
  if (big) {
    await writeFile(join(source, "big.bin"), "A".repeat(4096));
    await truncate(join(source, "big.bin"), 1024 * 1024);
  }
  const manager = new WorkspaceManager(source, { runtimeRoot: join(root, "runtime") });
  const env = await manager.create({
    taskId: "t",
    attemptId: "a",
    workspaceKind: "directory",
    scopePaths: ["."],
  });
  await writeFile(join(env.worktree_path, "a.txt"), "prepared");
  await writeFile(join(env.worktree_path, "output.bin"), Buffer.from([0, 255, 1]));
  if (hugeOutput) {
    await writeFile(join(env.worktree_path, "huge.bin"), "H".repeat(4096));
    await truncate(join(env.worktree_path, "huge.bin"), 2 * 1024 * 1024);
  }
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

describe("a final verification that cannot restore its baseline", () => {
  it("keeps the typed space cause beside the unproven verdict", async () => {
    const f = await fixture(true);
    vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
    vi.spyOn(fileCopyHost, "availableBytes").mockReturnValue(0);
    const record = await finalVerifyFiles(f.candidate, undefined, [], { emit: () => undefined });

    expect(record).toMatchObject({ attempted: true, applied_cleanly: null });
    expect(record.reason).toContain("full length");
    expect(finalVerifySpaceFailure(record)).toMatchObject({ code: "capture_space_insufficient" });
  });

  it("has no space cause for a verification that simply passed", async () => {
    const f = await fixture(true);
    const record = await finalVerifyFiles(f.candidate, undefined, [], { emit: () => undefined });
    expect(record.applied_cleanly).toBe(true);
    expect(finalVerifySpaceFailure(record)).toBeUndefined();
  });
});

describe("a directory delivery that runs out of room", () => {
  it("states a verification copy that could not fit as a typed public refusal", async () => {
    const f = await fixture(true);
    vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
    vi.spyOn(fileCopyHost, "availableBytes").mockReturnValue(0);
    const receipt = await verifyAndDeliverFiles(f.source, f.candidate);

    expect(ControlDeliveryResponse.parse(receipt)).toMatchObject({
      applied: false,
      refused: true,
      appliedPaths: [],
      treeMutated: false,
      refusal: { code: "space_insufficient", paths: [] },
    });
    expect(receipt).not.toHaveProperty("captureFailure");
    expect(filesDeliverySpaceFailure(receipt)).toMatchObject({
      code: "capture_space_insufficient",
    });
    expect(await readFile(join(f.source, "a.txt"), "utf8")).toBe("original");
  });

  it("names the paths written before the target ran out of room and the one it stopped at", async () => {
    const f = await fixture(false, true);
    vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
    const real = fileCopyHost.availableBytes;
    vi.spyOn(fileCopyHost, "availableBytes").mockImplementation((dir) =>
      dir.startsWith(f.source) ? 0 : real(dir),
    );
    const receipt = await verifyAndDeliverFiles(f.source, f.candidate);

    expect(ControlDeliveryResponse.parse(receipt)).toMatchObject({
      applied: false,
      refused: true,
      treeMutated: true,
      appliedPaths: ["a.txt"],
      refusal: { code: "space_insufficient", paths: ["huge.bin"], pathCount: 1 },
    });
    expect(receipt.finalVerify.applied_cleanly).toBe(true);
    expect(filesDeliverySpaceFailure(receipt)).toMatchObject({
      code: "capture_space_insufficient",
    });
    expect(await readFile(join(f.source, "a.txt"), "utf8")).toBe("prepared");
    await expect(readFile(join(f.source, "huge.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a clean delivery's public receipt as before", async () => {
    const f = await fixture(false, true);
    const receipt = await verifyAndDeliverFiles(f.source, f.candidate);
    const parsed = ControlDeliveryResponse.parse(receipt);
    expect(parsed).toMatchObject({ applied: true, refused: false });
    expect(parsed.refusal).toBeUndefined();
    expect(parsed.appliedPaths?.sort()).toEqual(["a.txt", "huge.bin", "output.bin"]);
    expect(filesDeliverySpaceFailure(receipt)).toBeUndefined();
  });

  it("types a verification whose temporary directory cannot be made", async () => {
    const f = await fixture();
    const previous = process.env["TMPDIR"];
    process.env["TMPDIR"] = join(f.root, "missing", "tmp");
    try {
      const record = await finalVerifyFiles(f.candidate, undefined, [], { emit: () => undefined });
      expect(record).toMatchObject({ attempted: true, applied_cleanly: null });
      expect(record.reason).toContain("ENOENT");
    } finally {
      if (previous === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previous;
    }
  });
});

describe("one rule for a files verification's verdict", () => {
  const verifyCopy = (dir: string) => dir.includes("claudexor-verify-files-");

  it("records a postimage that cannot fit in the verification copy as unproven, not a conflict", async () => {
    const f = await fixture(false, true);
    vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
    const real = fileCopyHost.availableBytes;
    vi.spyOn(fileCopyHost, "availableBytes").mockImplementation((dir) =>
      verifyCopy(dir) ? 0 : real(dir),
    );
    const record = await finalVerifyFiles(f.candidate, undefined, [], { emit: () => undefined });
    expect(record).toMatchObject({ attempted: true, applied_cleanly: null });
    expect(record.reason).toContain("full length");
    expect(finalVerifySpaceFailure(record)).toMatchObject({ code: "capture_space_insufficient" });

    // An accepted risk does not authorize it: Apply refuses with the typed cause.
    const receipt = await verifyAndDeliverFiles(f.source, f.candidate, {}, [], () => null);
    expect(ControlDeliveryResponse.parse(receipt)).toMatchObject({
      applied: false,
      refused: true,
      appliedPaths: [],
      refusal: { code: "space_insufficient" },
    });
    expect(await readFile(join(f.source, "a.txt"), "utf8")).toBe("original");
  });

  it("authorizes only a materialized copy", () => {
    // Complete records, as the verifier writes them.
    const record = (fields: Partial<FinalVerifyRecord>) =>
      FinalVerifyRecord.parse({ attempted: true, duration_ms: 1, ...fields });
    const authorize = () => null;
    expect(
      filesVerifyRefusal(record({ applied_cleanly: null, reason: "no room" }), authorize),
    ).toBe("no room");
    expect(
      filesVerifyRefusal(record({ applied_cleanly: false, reason: "conflict" }), authorize),
    ).toBe("conflict");
    expect(filesVerifyRefusal(record({ applied_cleanly: true }), authorize)).toBeNull();
    expect(filesVerifyRefusal(record({ applied_cleanly: true }), () => "blocked")).toBe("blocked");
  });
});

describe("a files verification's own cost", () => {
  async function syncs<T>(work: () => Promise<T>): Promise<{ result: T; count: number }> {
    const probe = await open(__filename, "r");
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const sync = vi.spyOn(prototype, "sync");
    const result = await work();
    const count = sync.mock.calls.length;
    sync.mockRestore();
    return { result, count };
  }

  it("never flushes its disposable copy, while the real Apply target stays durable", async () => {
    const f = await fixture(false, true);
    const verified = await syncs(() =>
      finalVerifyFiles(f.candidate, undefined, [], { emit: () => undefined }),
    );
    expect(verified.result.applied_cleanly).toBe(true);
    expect(verified.count).toBe(0);
    const delivered = await syncs(() => verifyAndDeliverFiles(f.source, f.candidate));
    expect(delivered.result.applied).toBe(true);
    // One flush per file written at the target; none for the verification copy.
    expect(delivered.count).toBe(delivered.result.appliedPaths.length);
  });

  it("hashes each immutable blob once per check for integrity, however many states name it", async () => {
    const f = await fixture(true);
    const reads = vi.spyOn(fileCopyHost, "digest");
    const record = await finalVerifyFiles(f.candidate, undefined, [], { emit: () => undefined });
    expect(record.applied_cleanly).toBe(true);
    const blobs = reads.mock.calls
      .map(([path]) => String(path))
      .filter((path) => path.startsWith(f.candidate.artifactRoot));
    const named = new Set(
      f.candidate.manifest.entries.flatMap((entry) =>
        [entry.before, entry.after].flatMap((state) =>
          state && state !== "unknown" && state.kind === "file" && state.artifactPath
            ? [join(f.candidate.artifactRoot, state.artifactPath)]
            : [],
        ),
      ),
    );
    // An unchanged file's before and after are one blob, hashed once; building the
    // verification copy reads the bytes again, which this digest count does not see.
    expect(blobs.sort()).toEqual([...named].sort());
  });
});
