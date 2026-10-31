import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
// The same module instance @claudexor/core's dist uses (its buffer owner is not re-exported).
import { CaptureBuffers } from "../../core/dist/capture-buffer.js";
import { createFakeHarness } from "@claudexor/harness-fake";
import type { ReviewerSpec } from "@claudexor/review";
import { ConformanceReport, HarnessManifest, type ProviderFamily } from "@claudexor/schema";
import { objectStorePath, storeEnv } from "@claudexor/workspace";
import { Orchestrator } from "./orchestrator.js";

// #535 R15: the copy of an unrendered result's saved files fails typed, and its
// directory then is gone, cannot be listed, or holds what could not be removed. Review
// and synthesis still get the copy's own cause and never read what it left behind, and
// a copy that cannot be removed afterwards ends no run. node:fs and node:fs/promises are
// wrapped once for this file and pass everything through unless a fault is armed.
const SAVED = "saved-files";
let faults: {
  /** ENOSPC where the copy makes its scratch: its directory is never created. */
  scratch?: boolean;
  /** No room once the copy directory exists. */
  full?: boolean;
  /** A file found in the copy directory at that moment (an earlier leftover). */
  leftover?: string;
  /** The copy directory then cannot be listed (EIO), though it can be removed whole. */
  list?: boolean;
  /** The copy directory then turns unlistable for real (mode 000). */
  lock?: boolean;
  /** A file with this name under a copy directory cannot be removed (EBUSY). */
  stuck?: string;
  /** No room for a reviewer's own workspace either. */
  reviewerFull?: boolean;
} = {};
const stuckHits: string[] = [];
const locked: string[] = [];
const errno = (code: string, path: string) =>
  Object.assign(new Error(`${code}: injected, ${path}`), { code });
/** Whether removing `path` meets the stuck file: it is that file, or a directory holding it. */
function holdsStuck(path: string): boolean {
  const name = faults.stuck;
  if (!name || !path.includes(SAVED)) return false;
  if (path.endsWith(`${sep}${name}`)) return true;
  try {
    return readdirSync(path, { recursive: true }).some((entry) => String(entry).endsWith(name));
  } catch {
    return false;
  }
}
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    mkdtempSync: (...args: Parameters<typeof fs.mkdtempSync>) => {
      if (faults.scratch && String(args[0]).includes("claudexor-saved-files-"))
        throw errno("ENOSPC", String(args[0]));
      return fs.mkdtempSync(...args);
    },
    statfsSync: (...args: Parameters<typeof fs.statfsSync>) => {
      const real = fs.statfsSync(...args);
      const path = String(args[0]);
      if (!faults.full || !path.includes(SAVED) || !fs.existsSync(path)) return real;
      if (faults.leftover)
        fs.writeFileSync(join(path, faults.leftover), "left by an earlier copy\n");
      if (faults.lock && !locked.includes(path)) {
        fs.chmodSync(path, 0o000);
        locked.push(path);
      }
      return { ...real, bavail: 1, bsize: 1024 };
    },
    readdirSync: ((...args: Parameters<typeof fs.readdirSync>) => {
      if (faults.list && String(args[0]).includes(SAVED)) throw errno("EIO", String(args[0]));
      return (fs.readdirSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof fs.readdirSync,
    rmSync: (...args: Parameters<typeof fs.rmSync>) => {
      if (holdsStuck(String(args[0]))) {
        stuckHits.push(String(args[0]));
        throw errno("EBUSY", String(args[0]));
      }
      return fs.rmSync(...args);
    },
  };
});
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rm: (...args: Parameters<typeof fs.rm>) =>
      holdsStuck(String(args[0]))
        ? Promise.reject(errno("EBUSY", String(args[0])))
        : fs.rm(...args),
    mkdir: (...args: Parameters<typeof fs.mkdir>) =>
      faults.reviewerFull && String(args[0]).includes(`-reviewers${sep}workspaces${sep}`)
        ? Promise.reject(errno("ENOSPC", String(args[0])))
        : fs.mkdir(...args),
  };
});

const roots: string[] = [];
afterEach(() => {
  faults = {};
  stuckHits.splice(0);
  vi.restoreAllMocks();
  for (const path of locked.splice(0)) if (existsSync(path)) chmodSync(path, 0o700);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "cx-saved-failure-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "file.txt"), "before\n");
  git("add", ".");
  git("-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "-qm", "base");
  return root;
}

function overflowEveryRender() {
  const append = CaptureBuffers.prototype.append;
  vi.spyOn(CaptureBuffers.prototype, "append").mockImplementation(function (
    this: CaptureBuffers,
    stream,
    chunk,
  ) {
    if (stream === "stdout" && chunk.includes("diff --git"))
      (this as unknown as { budget: number }).budget = 4096;
    return append.call(this, stream, chunk);
  });
}

/** An executor that writes `files`; a synthesizer that records its input and merges. */
function executor(files: (attempt: number) => Record<string, string>, synthesis?: string[]) {
  let attempt = 0;
  const base = createFakeHarness("fake-success");
  const adapter: HarnessAdapter = {
    ...base,
    async *run(spec) {
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started", observed_model: "fixture" };
      if (spec.intent === "synthesize") {
        synthesis?.push(readFileSync(join(spec.cwd, ".claudexor-synthesis-input.md"), "utf8"));
        writeFileSync(join(spec.cwd, "merged.txt"), "merged\n");
      } else {
        attempt += 1;
        for (const [path, content] of Object.entries(files(attempt)))
          writeFileSync(join(spec.cwd, path), content);
      }
      yield {
        ...common,
        type: "message",
        text: "Done.",
        final: true,
        payload: { final_source: "fake" },
      };
      yield { ...common, type: "completed", exit_code: 0 };
    },
  };
  return adapter;
}

interface Reading {
  prompt: string;
  /** What the reviewer's candidate root holds besides its evidence and Git. */
  entries: string[];
}

/** A reviewer that records its prompt and what its candidate root holds, then finds nothing. */
function reviewer(id: string, providerFamily: ProviderFamily, readings: Reading[]): ReviewerSpec {
  const model = `${id}-model`;
  return {
    providerFamily,
    requestedModel: model,
    adapter: {
      id,
      async discover() {
        return HarnessManifest.parse({
          id,
          display_name: id,
          kind: "local_cli",
          provider_family: providerFamily,
          access_profiles_supported: ["readonly"],
          capabilities: { review: true, known_models: [model] },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: id,
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        readings.push({
          prompt: spec.prompt,
          entries: readdirSync(spec.cwd)
            .filter((entry) => entry !== ".git" && entry !== ".claudexor-review-evidence")
            .sort(),
        });
        const base = { session_id: spec.session_id, ts: new Date().toISOString() };
        const route = { credential_route: "managed_api_key" as const };
        yield { ...base, ...route, type: "started", observed_model: model };
        yield { ...base, type: "message", text: "```json\n[]\n```" };
        yield { ...base, type: "completed" };
      },
    },
  };
}

const BIG = "x".repeat(64 * 1024);

async function reviewRun(
  root: string,
  files: Record<string, string>,
  readings: Reading[],
  tests: { program: string; args: string[]; envAllowlist: string[] }[] = [],
) {
  overflowEveryRender();
  const adapter = executor(() => files);
  return new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [reviewer("rev-o", "openai", readings), reviewer("rev-g", "google", readings)],
  }).run({
    repoRoot: root,
    mode: "agent",
    prompt: "edit",
    harnesses: [adapter.id],
    n: 1,
    review: true,
    tests,
  });
}

type RunResult = Awaited<ReturnType<typeof reviewRun>>;

const savedBlob = (root: string, tree: string, path: string) => {
  const store = objectStorePath(root);
  return execFileSync("git", ["-C", store, "cat-file", "-p", `${tree}:${path}`], {
    env: { ...process.env, ...storeEnv(store) },
  }).toString("utf8");
};

/** The review ran, named each file with the copy's own cause, read none of them and
 * could not pass clean; the run and its exact result stand. */
function expectTypedIncompleteReview(
  result: RunResult,
  root: string,
  named: { path: string; reason: string }[],
  readings: Reading[],
  saved: Record<string, string>,
) {
  expect(result.lifecycle, result.summary).toBe("succeeded");
  const store = new ArtifactStore(result.runDir);
  const review = store.readYaml<Record<string, any>>(join(result.runDir, "reviews/a01.yaml"))!;
  expect(review.final_review_clean).toBe(false);
  const claims = (review.findings as { severity: string; claim: string }[]).map((f) => f.claim);
  expect(claims.join("\n")).not.toContain("candidate root does not exist");
  expect(claims.join("\n")).not.toContain("Reviewer setup failed");
  expect(review.uninspectable_files).toEqual(named);
  for (const file of named)
    expect(
      (review.findings as { severity: string; claim: string }[]).some(
        (f) =>
          f.severity === "INSUFFICIENT_EVIDENCE" &&
          f.claim.includes(`"${file.path}" (${file.reason})`),
      ),
    ).toBe(true);
  expect(readings).toHaveLength(2);
  for (const reading of readings) {
    for (const file of named) expect(reading.prompt).toContain(`"${file.path}" (${file.reason})`);
    // Nothing of a failed copy is read: no partial file, no leftover.
    expect(reading.entries).toEqual([]);
  }
  expect(result.facts.review).not.toBe("approved");
  const meta = store.readYaml<Record<string, any>>(
    join(result.runDir, "final/work_product.yaml"),
  )!.meta;
  expect(meta.patch_view.available).toBe(false);
  for (const [path, content] of Object.entries(saved))
    expect(savedBlob(root, meta.git_result.candidate_tree, path)).toBe(content);
}

const cleanupRecord = (path: string) =>
  JSON.parse(readFileSync(`${path}.cleanup-error.json`, "utf8")) as Record<string, string>;

it("#535 R15: a copy whose scratch cannot be allocated, its directory never made, still reaches each reviewer with its cause", async () => {
  const root = repo();
  const readings: Reading[] = [];
  faults = { scratch: true };

  const result = await reviewRun(root, { "big.txt": BIG }, readings);

  expectTypedIncompleteReview(
    result,
    root,
    [{ path: "big.txt", reason: "space_insufficient" }],
    readings,
    { "big.txt": BIG },
  );
  expect(existsSync(join(result.runDir, "reviews/a01-saved-files"))).toBe(false);
});

it("#535 R15: a copy that runs out of room, cannot list its directory and removes it whole still reaches each reviewer with its cause", async () => {
  const root = repo();
  const readings: Reading[] = [];
  faults = { full: true, list: true };

  const result = await reviewRun(root, { "big.txt": BIG }, readings);

  expectTypedIncompleteReview(
    result,
    root,
    [{ path: "big.txt", reason: "space_insufficient" }],
    readings,
    { "big.txt": BIG },
  );
  expect(existsSync(join(result.runDir, "reviews/a01-saved-files"))).toBe(false);
});

it("#535 R15: a copy that wrote part of the files and cannot remove them: reviewers read none, the leftover is recorded, the run stands", async () => {
  const root = repo();
  const readings: Reading[] = [];
  // checkout-index writes a-kept.txt, then meets z-big.txt, whose blob a configured
  // check deleted from the project store after the capture (a Git fault).
  const big = "z".repeat(64 * 1024);
  const blob = execFileSync("git", ["hash-object", "--stdin"], { input: big })
    .toString("utf8")
    .trim();
  const lost = join(objectStorePath(root), "objects", blob.slice(0, 2), blob.slice(2));
  faults = { stuck: "a-kept.txt" };

  const result = await reviewRun(root, { "a-kept.txt": "kept\n", "z-big.txt": big }, readings, [
    {
      program: process.execPath,
      args: ["-e", `require('node:fs').rmSync(${JSON.stringify(lost)})`],
      envAllowlist: [],
    },
  ]);

  expect(existsSync(lost)).toBe(false);
  // The failed copy really left a-kept.txt, and emptying it met the stuck file.
  expect(stuckHits.some((path) => path.endsWith(`a01-saved-files${sep}a-kept.txt`))).toBe(true);
  expectTypedIncompleteReview(
    result,
    root,
    [
      { path: "a-kept.txt", reason: "git_failed" },
      { path: "z-big.txt", reason: "git_failed" },
    ],
    readings,
    { "a-kept.txt": "kept\n" },
  );
  const copy = join(result.runDir, "reviews/a01-saved-files");
  expect(existsSync(join(copy, "a-kept.txt"))).toBe(true);
  expect(cleanupRecord(copy)).toMatchObject({ saved_copy_cleanup: "failed", dir: copy });
  expect(cleanupRecord(copy).error).toContain("EBUSY");
});

// A mode-000 directory is a POSIX fixture: Windows does not enforce those bits, and root
// reads through them.
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "#535 R15: a copy directory that can be neither listed nor removed is not read, and stays recorded",
  async () => {
    const root = repo();
    const readings: Reading[] = [];
    faults = { full: true, leftover: "left.bin", lock: true };

    const result = await reviewRun(root, { "big.txt": BIG }, readings);

    expectTypedIncompleteReview(
      result,
      root,
      [{ path: "big.txt", reason: "space_insufficient" }],
      readings,
      { "big.txt": BIG },
    );
    const copy = join(result.runDir, "reviews/a01-saved-files");
    expect(locked).toEqual([copy]);
    expect(existsSync(copy)).toBe(true);
    expect(cleanupRecord(copy)).toMatchObject({ saved_copy_cleanup: "failed", dir: copy });
    expect(cleanupRecord(copy).error).toContain("EACCES");
  },
);

it("#535 R15: a disk still full when the reviewers' own workspaces are made keeps the copy's typed files on the review", async () => {
  const root = repo();
  const readings: Reading[] = [];
  faults = { scratch: true, reviewerFull: true };

  const result = await reviewRun(root, { "big.txt": BIG }, readings);

  expect(result.lifecycle, result.summary).toBe("succeeded");
  const review = new ArtifactStore(result.runDir).readYaml<Record<string, any>>(
    join(result.runDir, "reviews/a01.yaml"),
  )!;
  expect(review.final_review_clean).toBe(false);
  expect(review.uninspectable_files).toEqual([{ path: "big.txt", reason: "space_insufficient" }]);
  expect(readings).toEqual([]);
  expect(result.facts.review).not.toBe("approved");
});

it("#535 R15: a copy that fits is reviewed from the saved bytes and removed (the control)", async () => {
  const root = repo();
  const readings: Reading[] = [];

  const result = await reviewRun(root, { "big.txt": BIG }, readings);

  expect(result.lifecycle, result.summary).toBe("succeeded");
  const review = new ArtifactStore(result.runDir).readYaml<Record<string, any>>(
    join(result.runDir, "reviews/a01.yaml"),
  )!;
  expect(review.final_review_clean).toBe(true);
  expect(review.uninspectable_files).toBeUndefined();
  expect(readings.map((reading) => reading.entries)).toEqual([["big.txt"], ["big.txt"]]);
  expect(readdirSync(join(result.runDir, "reviews")).join(" ")).not.toContain("saved-files");
});

async function synthesisRun(root: string, synthesis: string[]) {
  overflowEveryRender();
  const adapter = executor(
    (attempt) => ({ "unique.txt": `unique ${attempt}\n`, "big.txt": BIG }),
    synthesis,
  );
  return new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [],
  }).run({
    repoRoot: root,
    mode: "agent",
    prompt: "edit",
    harnesses: [adapter.id],
    n: 2,
    synthesis: "always",
  });
}

/** Synthesis got each candidate's files named with the copy's cause, as unknown content,
 * and no directory to read for them. */
function expectTypedSynthesisInput(synthesis: string[]) {
  expect(synthesis).toHaveLength(1);
  const input = synthesis[0]!;
  expect(input).toContain("too large to render as one patch");
  const named = JSON.stringify([
    { path: "big.txt", reason: "space_insufficient" },
    { path: "unique.txt", reason: "space_insufficient" },
  ]);
  expect(input.split(named)).toHaveLength(3);
  expect(input).toContain("their content is unknown");
  expect(input).not.toContain("(kept until synthesis ends)");
}

it("#535 R15: synthesis of candidates whose copies ran out of room and lost their directories gets each cause, not a directory", async () => {
  const root = repo();
  const synthesis: string[] = [];
  faults = { full: true, list: true };

  const result = await synthesisRun(root, synthesis);

  expect(result.lifecycle, result.summary).toBe("succeeded");
  expectTypedSynthesisInput(synthesis);
  expect(existsSync(join(result.runDir, "synthesis-saved-files"))).toBe(false);
});

it("#535 R15: synthesis copies that cannot be removed afterwards stay recorded and end no run", async () => {
  const root = repo();
  const synthesis: string[] = [];
  faults = { full: true, leftover: "left.bin", stuck: "left.bin" };

  const result = await synthesisRun(root, synthesis);

  expect(result.lifecycle, result.summary).toBe("succeeded");
  expectTypedSynthesisInput(synthesis);
  const parent = join(result.runDir, "synthesis-saved-files");
  for (const attempt of ["a01", "a02"]) {
    expect(existsSync(join(parent, attempt, "left.bin"))).toBe(true);
    expect(cleanupRecord(join(parent, attempt))).toMatchObject({ saved_copy_cleanup: "failed" });
  }
  expect(cleanupRecord(parent)).toMatchObject({ saved_copy_cleanup: "failed", dir: parent });
});
