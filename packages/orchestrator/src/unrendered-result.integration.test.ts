import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
// The same module instance @claudexor/core's dist uses (its buffer owner is not re-exported).
import { CaptureBuffers } from "../../core/dist/capture-buffer.js";
import { createFakeHarness } from "@claudexor/harness-fake";
import type { ReviewerSpec } from "@claudexor/review";
import {
  ConformanceReport,
  HarnessManifest,
  RunFacts,
  type ProviderFamily,
} from "@claudexor/schema";
import { candidatesFor } from "../../control-api/src/candidates.js";
import { controlRunResult } from "../../control-api/src/run-delivery-state.js";
import { Orchestrator } from "./orchestrator.js";
import { objectStorePath, storeEnv } from "@claudexor/workspace";
import { redactSecrets } from "@claudexor/util";

// #535 phase 2: a result whose patch view cannot be rendered within today's
// limit is still an exact, reviewed, applyable result. The render limit is
// forced low by the same real-buffer seam the phase-1 probe used.
// #535 R3 B4: a disk that fills while a reviewer's copy of the saved files is made
// (node:fs/promises is wrapped once, passing everything through unless asked).
let reviewerCopyFull = false;
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    cp: (source: string, destination: string, options?: Parameters<typeof fs.cp>[2]) =>
      reviewerCopyFull && String(source).includes("-saved-files")
        ? Promise.reject(
            Object.assign(new Error("ENOSPC: no space left on device, write"), {
              code: "ENOSPC",
            }),
          )
        : fs.cp(source, destination, options),
  };
});
const roots: string[] = [];
afterEach(() => {
  reviewerCopyFull = false;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "cx-unrendered-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "file.txt"), "before\n");
  git("add", ".");
  git("-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "-qm", "base");
  return root;
}

/** A reviewer that does what its prompt says: every packet file the prompt names
 * must be there, and every changed path it lists must be readable in the copy. */
function followPrompt(spec: { prompt: string; cwd: string }) {
  const evidence = join(spec.cwd, ".claudexor-review-evidence");
  const named = [
    ...new Set(spec.prompt.match(/\b[A-Z][A-Z_]*\.(?:md|txt|patch|json|sha256)\b/g) ?? []),
  ];
  const list = join(evidence, "CHANGED_PATHS.json");
  const changedPaths = existsSync(list) ? (JSON.parse(readFileSync(list, "utf8")) as string[]) : [];
  return {
    named,
    missing: named.filter((name) => !existsSync(join(evidence, name))),
    changedPaths,
    contents: Object.fromEntries(
      changedPaths.map((path) => [path, readFileSync(join(spec.cwd, path), "utf8")]),
    ),
  };
}

function reviewer(
  id: string,
  providerFamily: ProviderFamily,
  seen: string[],
  inspect?: (spec: { prompt: string; cwd: string }) => void,
): ReviewerSpec {
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
        const packet = readdirSync(spec.cwd, { recursive: true }).find((path) =>
          String(path).endsWith("DIFF.patch"),
        );
        if (packet) seen.push(readFileSync(join(spec.cwd, String(packet)), "utf8"));
        inspect?.(spec);
        const base = { session_id: spec.session_id, ts: new Date().toISOString() };
        const route = { credential_route: "managed_api_key" as const };
        yield { ...base, ...route, type: "started", observed_model: model };
        yield { ...base, type: "message", text: "```json\n[]\n```" };
        yield { ...base, type: "completed" };
      },
    },
  };
}

it("an unrendered isolated result is reviewed with an explicit notice, verified and applyable", async () => {
  const root = repo();
  const seen: string[] = [];
  const followed: ReturnType<typeof followPrompt>[] = [];
  const prompts: string[] = [];
  const inspect = (spec: { prompt: string; cwd: string }) => {
    prompts.push(spec.prompt);
    followed.push(followPrompt(spec));
  };
  const base = createFakeHarness("fake-success");
  const adapter: HarnessAdapter = {
    ...base,
    async *run(spec) {
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started", observed_model: "fixture" };
      writeFileSync(join(spec.cwd, "file.txt"), "after\n");
      writeFileSync(join(spec.cwd, "big.txt"), "x".repeat(64 * 1024));
      writeFileSync(join(spec.cwd, "second.txt"), "second\n");
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
  // The patch VIEW render overflows a 4 KiB buffer; every other Git read is real.
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
  const result = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [
      reviewer("rev-o", "openai", seen, inspect),
      reviewer("rev-g", "google", seen, inspect),
    ],
  }).run({
    repoRoot: root,
    mode: "agent",
    prompt: "edit",
    harnesses: [adapter.id],
    n: 1,
    review: true,
  });

  expect(result.lifecycle).toBe("succeeded");
  // Both reviewers could do everything the prompt told them to.
  expect(followed).toHaveLength(2);
  for (const reading of followed) {
    expect(reading.missing).toEqual([]);
    expect(reading.named).toContain("CHANGED_PATHS.json");
    expect(reading.changedPaths.sort()).toEqual(["big.txt", "file.txt", "second.txt"]);
    expect(reading.contents["file.txt"]).toBe("after\n");
    expect(reading.contents["big.txt"]).toBe("x".repeat(64 * 1024));
  }
  for (const prompt of prompts) {
    expect(prompt).not.toContain("FILES.json");
    expect(prompt).toContain("no rendered patch");
  }
  const store = new ArtifactStore(result.runDir);
  const workProduct = store.readYaml<Record<string, any>>(
    join(result.runDir, "final/work_product.yaml"),
  )!;
  expect(workProduct.meta.git_result.schema).toBe("git_objects/v1");
  expect(workProduct.meta.patch_view).toMatchObject({
    available: false,
    reason: "exceeds_view_limit",
  });
  expect(workProduct.meta.patch_sha256).toBeNull();
  // F: never an empty or descriptor file named patch.diff.
  expect(existsSync(join(result.runDir, "final/patch.diff"))).toBe(false);
  expect(existsSync(join(result.runDir, "attempts/a01/patch.diff"))).toBe(false);
  // Reviewers saw an explicit bounded notice, never "(empty diff)".
  expect(seen.length).toBeGreaterThan(0);
  for (const packet of seen) {
    expect(packet).toContain("too large to render as one patch");
    expect(packet).not.toContain("(empty diff)");
  }
  const facts = RunFacts.parse(store.readYaml(join(result.runDir, "final/run_facts.yaml")));
  expect(facts.deliverable).toMatchObject({
    present: true,
    kind: "patch",
    path: "final/work_product.yaml",
  });
  expect(facts.apply.eligibility?.eligible).toBe(true);
  expect(readFileSync(join(result.runDir, "final/summary.md"), "utf8")).toContain(
    "kept exactly as Git objects",
  );
});

it.skipIf(process.getuid?.() === 0)(
  "#535 F10: a changed file review cannot inspect is recorded and keeps an unrendered review from passing clean",
  async () => {
    const root = repo();
    const seen: string[] = [];
    const base = createFakeHarness("fake-success");
    const adapter: HarnessAdapter = {
      ...base,
      async *run(spec) {
        const common = { session_id: spec.session_id, ts: new Date().toISOString() };
        yield { ...common, type: "started", observed_model: "fixture" };
        writeFileSync(join(spec.cwd, "file.txt"), "after\n");
        writeFileSync(join(spec.cwd, "locked.txt"), "changed\n");
        writeFileSync(join(spec.cwd, "big.txt"), "x".repeat(64 * 1024));
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
    // After the saved files are copied out for review, one of them turns unreadable
    // before the reviewer copy reads it (any read error, or a file once past the
    // runtime's string limit, took the same silent path).
    const lockedPaths: string[] = [];
    const review = (Orchestrator.prototype as any).reviewScoped;
    vi.spyOn(Orchestrator.prototype as any, "reviewScoped").mockImplementation(function (
      this: unknown,
      input: any,
    ) {
      const path = join(String(input.cwd), "locked.txt");
      if (existsSync(path)) {
        chmodSync(path, 0o000);
        lockedPaths.push(path);
      }
      return review.call(this, input);
    });
    try {
      const result = await new Orchestrator({
        registry: new Map([[adapter.id, adapter]]),
        reviewers: [reviewer("rev-o", "openai", seen), reviewer("rev-g", "google", seen)],
      }).run({
        repoRoot: root,
        mode: "agent",
        prompt: "edit",
        harnesses: [adapter.id],
        n: 1,
        review: true,
      });
      expect(lockedPaths).toHaveLength(1);
      const store = new ArtifactStore(result.runDir);
      const review = store.readYaml<Record<string, any>>(join(result.runDir, "reviews/a01.yaml"))!;
      expect(review.final_review_clean).toBe(false);
      expect(review.uninspectable_files).toEqual([{ path: "locked.txt", reason: "EACCES" }]);
      expect(
        review.findings.some(
          (f: { severity: string; claim: string }) =>
            f.severity === "INSUFFICIENT_EVIDENCE" && f.claim.includes('"locked.txt"'),
        ),
      ).toBe(true);
      expect(result.facts.review).not.toBe("approved");
    } finally {
      for (const path of lockedPaths) if (existsSync(path)) chmodSync(path, 0o600);
    }
  },
);

it("#535 F4: a changed file the reviewer copy excludes by rule keeps an unrendered review from passing clean", async () => {
  const root = repo();
  const seen: string[] = [];
  const prompts: string[] = [];
  const copied: boolean[] = [];
  const base = createFakeHarness("fake-success");
  const adapter: HarnessAdapter = {
    ...base,
    async *run(spec) {
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started", observed_model: "fixture" };
      writeFileSync(join(spec.cwd, "file.txt"), "after\n");
      mkdirSync(join(spec.cwd, "node_modules", "dep"), { recursive: true });
      writeFileSync(join(spec.cwd, "node_modules", "dep", "index.js"), "changed\n");
      writeFileSync(join(spec.cwd, "big.txt"), "x".repeat(64 * 1024));
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
  const inspect = (spec: { prompt: string; cwd: string }) => {
    prompts.push(spec.prompt);
    copied.push(existsSync(join(spec.cwd, "node_modules/dep/index.js")));
  };
  const result = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [
      reviewer("rev-o", "openai", seen, inspect),
      reviewer("rev-g", "google", seen, inspect),
    ],
  }).run({
    repoRoot: root,
    mode: "agent",
    prompt: "edit",
    harnesses: [adapter.id],
    n: 1,
    review: true,
  });
  expect(copied).toEqual([false, false]);
  for (const prompt of prompts) expect(prompt).toContain('"node_modules/dep/index.js"');
  const review = new ArtifactStore(result.runDir).readYaml<Record<string, any>>(
    join(result.runDir, "reviews/a01.yaml"),
  )!;
  expect(review.final_review_clean).toBe(false);
  expect(review.uninspectable_files).toEqual([
    { path: "node_modules/dep/index.js", reason: "excluded_from_review_copy" },
  ]);
  expect(
    review.findings.some(
      (f: { severity: string; claim: string }) =>
        f.severity === "INSUFFICIENT_EVIDENCE" && f.claim.includes('"node_modules/dep/index.js"'),
    ),
  ).toBe(true);
  expect(result.facts.review).not.toBe("approved");
});

it("#535 F9: synthesis reads each unrendered candidate's changed files in a copy kept until it ends", async () => {
  const root = repo();
  const candidateRoots: string[] = [];
  const named: string[] = [];
  const read: string[] = [];
  let synthesisInput = "";
  const base = createFakeHarness("fake-success");
  const adapter: HarnessAdapter = {
    ...base,
    async *run(spec) {
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started", observed_model: "fixture" };
      if (spec.intent === "synthesize") {
        // A synthesizer can only follow what its input names: each candidate it
        // is pointed at must still be readable while it works.
        synthesisInput = readFileSync(join(spec.cwd, ".claudexor-synthesis-input.md"), "utf8");
        for (const match of synthesisInput.matchAll(/ (\/\S+) \(kept until synthesis ends\)/g)) {
          named.push(match[1]!);
          read.push(readFileSync(join(match[1]!, "unique.txt"), "utf8"));
        }
        writeFileSync(join(spec.cwd, "file.txt"), "merged\n");
      } else {
        candidateRoots.push(spec.cwd);
        writeFileSync(join(spec.cwd, "unique.txt"), `unique-${candidateRoots.length}\n`);
        writeFileSync(join(spec.cwd, "big.txt"), "x".repeat(64 * 1024));
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
  // Each candidate's patch VIEW overflows a 4 KiB buffer; the merged result renders.
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
  const result = await new Orchestrator({
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

  expect(candidateRoots).toHaveLength(2);
  const store = new ArtifactStore(result.runDir);
  for (const attempt of ["a01", "a02"])
    expect(
      store.readYaml<Record<string, any>>(join(result.runDir, "attempts", attempt, "attempt.yaml"))
        ?.patch_view,
    ).toMatchObject({ available: false, reason: "exceeds_view_limit" });
  expect(synthesisInput).toContain("too large to render as one patch");
  // Every unrendered candidate's content reached the synthesizer.
  expect(read.sort()).toEqual(["unique-1\n", "unique-2\n"]);
  // Kept only until synthesis ended: no copy and no candidate workspace outlives the run.
  expect(named).toHaveLength(2);
  for (const dir of [...named, ...candidateRoots]) expect(existsSync(dir)).toBe(false);
});

it("a cancelled in-place run publishes its unrendered live result without a dangling patch.diff", async () => {
  const root = repo();
  const abort = new AbortController();
  const base = createFakeHarness("fake-success");
  const adapter: HarnessAdapter = {
    ...base,
    async *run(spec) {
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started", observed_model: "fixture" };
      writeFileSync(join(spec.cwd, "big.txt"), "y".repeat(64 * 1024));
      yield {
        ...common,
        type: "message",
        text: "Done.",
        final: true,
        payload: { final_source: "fake" },
      };
      yield { ...common, type: "completed", exit_code: 0 };
      abort.abort("user_cancelled");
    },
  };
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
  const result = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [],
  }).run({
    repoRoot: root,
    mode: "agent",
    prompt: "edit",
    harnesses: [adapter.id],
    n: 1,
    review: false,
    inPlace: true,
    signal: abort.signal,
  });
  expect(result.lifecycle).toBe("cancelled");
  const store = new ArtifactStore(result.runDir);
  const facts = RunFacts.parse(store.readYaml(join(result.runDir, "final/run_facts.yaml")));
  expect(existsSync(join(result.runDir, "final/patch.diff"))).toBe(false);
  const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8");
  expect(events).not.toContain('"path":"final/patch.diff"');
  expect(facts.outcome.lifecycle).toBe("cancelled");
  const workProduct = store.readYaml<Record<string, any>>(
    join(result.runDir, "final/work_product.yaml"),
  );
  expect(workProduct?.meta?.patch_view?.available ?? false).toBe(false);
});

it("#535 round 9: reviewers read a credential-shaped changed path exactly in the notice", async () => {
  const root = repo();
  const name = `${"ghp_"}${"a1".repeat(18)}.txt`;
  // The fixture really is a name the diagnostic mask rewrites.
  expect(redactSecrets(name)).not.toBe(name);
  const seen: string[] = [];
  const base = createFakeHarness("fake-success");
  const adapter: HarnessAdapter = {
    ...base,
    async *run(spec) {
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started", observed_model: "fixture" };
      writeFileSync(join(spec.cwd, name), "x".repeat(64 * 1024));
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
  const result = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [reviewer("rev-o", "openai", seen), reviewer("rev-g", "google", seen)],
  }).run({
    repoRoot: root,
    mode: "agent",
    prompt: "edit",
    harnesses: [adapter.id],
    n: 1,
    review: true,
  });

  expect(result.lifecycle).toBe("succeeded");
  expect(seen).toHaveLength(2);
  for (const packet of seen) {
    expect(packet).toContain("too large to render as one patch");
    expect(packet).toContain(`# - added ${name} · `);
    expect(packet).not.toContain("[redacted]");
  }
});

it("#535 round 8: an unrendered result projects no line counts, with its typed absence and inventory intact", async () => {
  const root = repo();
  const base = createFakeHarness("fake-success");
  const adapter: HarnessAdapter = {
    ...base,
    async *run(spec) {
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started", observed_model: "fixture" };
      writeFileSync(join(spec.cwd, "file.txt"), "after\n");
      writeFileSync(join(spec.cwd, "big.txt"), "x".repeat(64 * 1024));
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
  const result = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [],
  }).run({
    repoRoot: root,
    mode: "agent",
    prompt: "edit",
    harnesses: [adapter.id],
    n: 1,
    review: false,
  });

  const meta = new ArtifactStore(result.runDir).readYaml<Record<string, any>>(
    join(result.runDir, "final/work_product.yaml"),
  )!.meta;
  expect(meta.diffstat).toEqual({ files: 2, additions: null, deletions: null });
  expect(meta.patch_view).toMatchObject({ available: false, reason: "exceeds_view_limit" });
  expect(meta.change_inventory.changedFiles).toBe(2);
  const projected = controlRunResult({
    id: result.runId,
    runId: result.runId,
    state: result.lifecycle,
    runDir: result.runDir,
  });
  expect(projected.kind).toBe("patch");
  expect(projected.diffStat).toBeNull();
  expect(candidatesFor(result.runDir, null)[0]!.diffstat).toBeNull();
});

/** Force the patch view of one attempt past a 4 KiB render buffer. */
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

/** A configured check that rewrites what the attempt produced, as generators do. */
const rewritingGate = (script: string) => ({
  program: process.execPath,
  args: ["-e", script],
  envAllowlist: [],
});

const savedBlob = (root: string, tree: string, path: string) => {
  const store = objectStorePath(root);
  return execFileSync("git", ["-C", store, "cat-file", "-p", `${tree}:${path}`], {
    env: { ...process.env, ...storeEnv(store) },
  }).toString("utf8");
};

it("#535 A3: reviewers read the saved candidate tree, not what a configured gate rewrote after the capture", async () => {
  const root = repo();
  const original = "authored original result\n".repeat(4096);
  const generated = "gate regenerated fixture\n";
  const seen: string[] = [];
  const readings: { big: string; deleted: boolean; gateOnly: boolean; link?: string }[] = [];
  const inspect = (spec: { cwd: string }) => {
    readings.push({
      big: readFileSync(join(spec.cwd, "big.txt"), "utf8"),
      deleted: !existsSync(join(spec.cwd, "file.txt")),
      gateOnly: existsSync(join(spec.cwd, "gate-only.txt")),
      ...(process.platform === "win32" ? {} : { link: readlinkSync(join(spec.cwd, "link.txt")) }),
    });
  };
  const base = createFakeHarness("fake-success");
  const adapter: HarnessAdapter = {
    ...base,
    async *run(spec) {
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started", observed_model: "fixture" };
      writeFileSync(join(spec.cwd, "big.txt"), original);
      rmSync(join(spec.cwd, "file.txt"));
      if (process.platform !== "win32") symlinkSync("big.txt", join(spec.cwd, "link.txt"));
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
  overflowEveryRender();
  const result = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [
      reviewer("rev-o", "openai", seen, inspect),
      reviewer("rev-g", "google", seen, inspect),
    ],
  }).run({
    repoRoot: root,
    mode: "agent",
    prompt: "edit",
    harnesses: [adapter.id],
    n: 1,
    review: true,
    tests: [
      rewritingGate(
        `const fs=require('node:fs');fs.writeFileSync('big.txt',${JSON.stringify(generated)});fs.writeFileSync('file.txt','recreated by the gate\\n');fs.writeFileSync('gate-only.txt','x')`,
      ),
    ],
  });
  const store = new ArtifactStore(result.runDir);
  const meta = store.readYaml<Record<string, any>>(
    join(result.runDir, "final/work_product.yaml"),
  )!.meta;
  expect(meta.patch_view.available).toBe(false);
  expect(savedBlob(root, meta.git_result.candidate_tree, "big.txt")).toBe(original);
  // Both reviewers read exactly what apply consumes.
  expect(readings).toHaveLength(2);
  for (const reading of readings) {
    expect(reading.big).toBe(original);
    expect(reading.deleted).toBe(true);
    expect(reading.gateOnly).toBe(false);
    if (reading.link !== undefined) expect(reading.link).toBe("big.txt");
  }
  const review = store.readYaml<Record<string, any>>(join(result.runDir, "reviews/a01.yaml"))!;
  expect(review.final_review_clean).toBe(true);
  expect(review.uninspectable_files).toBeUndefined();
  // The materialized copy outlives no review.
  expect(readdirSync(join(result.runDir, "reviews")).join(" ")).not.toContain("saved-files");
});

it.skipIf(process.platform === "win32")(
  "#535 A3: a changed symlink to an unchanged file is exact content, and the review can pass clean",
  async () => {
    const root = repo();
    const seen: string[] = [];
    const links: string[] = [];
    const inspect = (spec: { cwd: string }) => links.push(readlinkSync(join(spec.cwd, "link.txt")));
    const base = createFakeHarness("fake-success");
    const adapter: HarnessAdapter = {
      ...base,
      async *run(spec) {
        const common = { session_id: spec.session_id, ts: new Date().toISOString() };
        yield { ...common, type: "started", observed_model: "fixture" };
        symlinkSync("file.txt", join(spec.cwd, "link.txt"));
        writeFileSync(join(spec.cwd, "big.txt"), "x".repeat(64 * 1024));
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
    overflowEveryRender();
    const result = await new Orchestrator({
      registry: new Map([[adapter.id, adapter]]),
      reviewers: [
        reviewer("rev-o", "openai", seen, inspect),
        reviewer("rev-g", "google", seen, inspect),
      ],
    }).run({
      repoRoot: root,
      mode: "agent",
      prompt: "edit",
      harnesses: [adapter.id],
      n: 1,
      review: true,
    });
    expect(links).toEqual(["file.txt", "file.txt"]);
    const review = new ArtifactStore(result.runDir).readYaml<Record<string, any>>(
      join(result.runDir, "reviews/a01.yaml"),
    )!;
    expect(review.uninspectable_files).toBeUndefined();
    expect(review.final_review_clean).toBe(true);
  },
);

it("#535 A3: a saved file that cannot be materialized is named, and the review cannot pass clean", async () => {
  const root = repo();
  const seen: string[] = [];
  const prompts: string[] = [];
  const inspect = (spec: { prompt: string }) => prompts.push(spec.prompt);
  // #535 R14 A2: the copy no longer reads the workspace's filter configuration, so a
  // failing configured filter cannot stop it; a blob lost from the project store
  // after the capture (a configured check deletes it here) is a Git fault it meets.
  const boom = "x".repeat(64 * 1024);
  const blob = execFileSync("git", ["hash-object", "--stdin"], { input: boom })
    .toString("utf8")
    .trim();
  const lost = join(objectStorePath(root), "objects", blob.slice(0, 2), blob.slice(2));
  const base = createFakeHarness("fake-success");
  const adapter: HarnessAdapter = {
    ...base,
    async *run(spec) {
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started", observed_model: "fixture" };
      writeFileSync(join(spec.cwd, "boom.txt"), boom);
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
  overflowEveryRender();
  const result = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [
      reviewer("rev-o", "openai", seen, inspect),
      reviewer("rev-g", "google", seen, inspect),
    ],
  }).run({
    repoRoot: root,
    mode: "agent",
    prompt: "edit",
    harnesses: [adapter.id],
    n: 1,
    review: true,
    tests: [rewritingGate(`require('node:fs').rmSync(${JSON.stringify(lost)})`)],
  });
  expect(existsSync(lost)).toBe(false);
  const review = new ArtifactStore(result.runDir).readYaml<Record<string, any>>(
    join(result.runDir, "reviews/a01.yaml"),
  )!;
  expect(review.final_review_clean).toBe(false);
  // #535 R5 B4: named with the copy's own typed cause (a Git fault here).
  expect(review.uninspectable_files).toContainEqual({ path: "boom.txt", reason: "git_failed" });
  for (const prompt of prompts) expect(prompt).toContain('"boom.txt"');
  expect(result.facts.review).not.toBe("approved");
});

it("#535 A3: synthesis reads each unrendered candidate's saved files, not what a gate rewrote", async () => {
  const root = repo();
  const original = (n: number) => `authored ${n}\n`;
  const read: string[] = [];
  const named: string[] = [];
  let attempt = 0;
  const base = createFakeHarness("fake-success");
  const adapter: HarnessAdapter = {
    ...base,
    async *run(spec) {
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started", observed_model: "fixture" };
      if (spec.intent === "synthesize") {
        // A synthesizer can only follow what its input names.
        const input = readFileSync(join(spec.cwd, ".claudexor-synthesis-input.md"), "utf8");
        for (const match of input.matchAll(/ (\/\S+) \(kept until synthesis ends\)/g)) {
          named.push(match[1]!);
          read.push(readFileSync(join(match[1]!, "unique.txt"), "utf8"));
        }
        writeFileSync(join(spec.cwd, "merged.txt"), "merged\n");
      } else {
        attempt += 1;
        writeFileSync(join(spec.cwd, "unique.txt"), original(attempt));
        writeFileSync(join(spec.cwd, "big.txt"), "x".repeat(64 * 1024));
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
  overflowEveryRender();
  const result = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [],
  }).run({
    repoRoot: root,
    mode: "agent",
    prompt: "edit",
    harnesses: [adapter.id],
    n: 2,
    synthesis: "always",
    tests: [
      rewritingGate(
        "const fs=require('node:fs');if(fs.existsSync('unique.txt'))fs.writeFileSync('unique.txt','rewritten by the gate\\n')",
      ),
    ],
  });
  expect(result.runDir).toBeTruthy();
  expect(read.sort()).toEqual([original(1), original(2)]);
  // Materialized for the synthesis only: nothing outlives it.
  expect(named).toHaveLength(2);
  for (const dir of named) expect(existsSync(dir)).toBe(false);
});

/** A configured check that, after the capture, adds an attribute rule re-encoding `path`. */
const reencodingGate = (path: string) =>
  rewritingGate(
    `require('node:fs').writeFileSync('.gitattributes',${JSON.stringify(`${path} working-tree-encoding=UTF-16LE\n`)})`,
  );

it("#535 R3 A3: reviewers read the saved bytes, whatever attribute rule a gate adds after the capture", async () => {
  const root = repo();
  const original = "plain utf-8 result\n".repeat(4096);
  const seen: string[] = [];
  const readings: Buffer[] = [];
  const base = createFakeHarness("fake-success");
  const adapter: HarnessAdapter = {
    ...base,
    async *run(spec) {
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started", observed_model: "fixture" };
      writeFileSync(join(spec.cwd, "big.txt"), original);
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
  overflowEveryRender();
  const result = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [
      reviewer("rev-o", "openai", seen, (spec) =>
        readings.push(readFileSync(join(spec.cwd, "big.txt"))),
      ),
      reviewer("rev-g", "google", seen, (spec) =>
        readings.push(readFileSync(join(spec.cwd, "big.txt"))),
      ),
    ],
  }).run({
    repoRoot: root,
    mode: "agent",
    prompt: "edit",
    harnesses: [adapter.id],
    n: 1,
    review: true,
    tests: [reencodingGate("big.txt")],
  });
  const store = new ArtifactStore(result.runDir);
  const meta = store.readYaml<Record<string, any>>(
    join(result.runDir, "final/work_product.yaml"),
  )!.meta;
  expect(meta.patch_view.available).toBe(false);
  expect(savedBlob(root, meta.git_result.candidate_tree, "big.txt")).toBe(original);
  expect(readings).toHaveLength(2);
  for (const reading of readings) expect(reading).toEqual(Buffer.from(original));
  const review = store.readYaml<Record<string, any>>(join(result.runDir, "reviews/a01.yaml"))!;
  expect(review.final_review_clean).toBe(true);
});

it("#535 R3 A3: synthesis reads the saved bytes, whatever attribute rule a gate adds after the capture", async () => {
  const root = repo();
  const original = (n: number) => `authored utf-8 ${n}\n`;
  const read: Buffer[] = [];
  let attempt = 0;
  const base = createFakeHarness("fake-success");
  const adapter: HarnessAdapter = {
    ...base,
    async *run(spec) {
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started", observed_model: "fixture" };
      if (spec.intent === "synthesize") {
        const input = readFileSync(join(spec.cwd, ".claudexor-synthesis-input.md"), "utf8");
        for (const match of input.matchAll(/ (\/\S+) \(kept until synthesis ends\)/g))
          read.push(readFileSync(join(match[1]!, "unique.txt")));
        writeFileSync(join(spec.cwd, "merged.txt"), "merged\n");
      } else {
        attempt += 1;
        writeFileSync(join(spec.cwd, "unique.txt"), original(attempt));
        writeFileSync(join(spec.cwd, "big.txt"), "x".repeat(64 * 1024));
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
  overflowEveryRender();
  await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [],
  }).run({
    repoRoot: root,
    mode: "agent",
    prompt: "edit",
    harnesses: [adapter.id],
    n: 2,
    synthesis: "always",
    tests: [reencodingGate("unique.txt")],
  });
  expect(read.map((bytes) => bytes.toString("utf8")).sort()).toEqual([original(1), original(2)]);
  expect(read.map((bytes) => bytes.toString("hex")).sort()).toEqual(
    [original(1), original(2)].map((text) => Buffer.from(text).toString("hex")).sort(),
  );
});

it("#535 R3 B4: a disk that fills while a reviewer's copy is made ends no run: the files are named and the result stays", async () => {
  const root = repo();
  const seen: string[] = [];
  const base = createFakeHarness("fake-success");
  const adapter: HarnessAdapter = {
    ...base,
    async *run(spec) {
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started", observed_model: "fixture" };
      writeFileSync(join(spec.cwd, "big.txt"), "x".repeat(64 * 1024));
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
  overflowEveryRender();
  reviewerCopyFull = true;
  const result = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [reviewer("rev-o", "openai", seen), reviewer("rev-g", "google", seen)],
  }).run({
    repoRoot: root,
    mode: "agent",
    prompt: "edit",
    harnesses: [adapter.id],
    n: 1,
    review: true,
  });
  const store = new ArtifactStore(result.runDir);
  const meta = store.readYaml<Record<string, any>>(
    join(result.runDir, "final/work_product.yaml"),
  )!.meta;
  // The captured result is kept, exact.
  expect(meta.patch_view.available).toBe(false);
  expect(savedBlob(root, meta.git_result.candidate_tree, "big.txt")).toBe("x".repeat(64 * 1024));
  // The review ran, named the file it could not hold, and could not pass clean.
  const review = store.readYaml<Record<string, any>>(join(result.runDir, "reviews/a01.yaml"))!;
  expect(review.final_review_clean).toBe(false);
  expect(JSON.stringify(review.uninspectable_files)).toContain("space_insufficient");
});
