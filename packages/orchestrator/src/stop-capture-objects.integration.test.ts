import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { CaptureOutputExceeded, type HarnessAdapter } from "@claudexor/core";
// The same module instance @claudexor/core's dist uses (its buffer owner is not re-exported).
import { CaptureBuffers } from "../../core/dist/capture-buffer.js";
import { createFakeHarness } from "@claudexor/harness-fake";
import type { ReviewerSpec } from "@claudexor/review";
import { ConformanceReport, HarnessManifest, RunFacts, type HarnessEvent } from "@claudexor/schema";
import { sha256 } from "@claudexor/util";
import { objectStorePath, storeEnv, WorkspaceManager } from "@claudexor/workspace";
import { Orchestrator, type RunInput } from "./orchestrator.js";

/**
 * Stop (#337) over #535's object results, through the real `Orchestrator.run`
 * and real Git capture. After Stop the attempt loop keeps reading the source to
 * record it (never to use it), so each test presses Stop from the harness
 * callback mid-stream and keeps emitting after it:
 *  (a) a capture fault after Stop ends cancelled, never failed/capture_refused,
 *      with no retry advice, the pre-Stop answer and produced media kept;
 *  (b) a raw patch accepted before Stop materializes as the exact object
 *      result (also unrendered), while one first seen after Stop leaves no
 *      store custody behind;
 *  (c) Stop during synthesis still disposes every kept candidate workspace;
 *  (d) files written before Stop in a Git workspace are the exact object result.
 */
const STOP = "STOP_NOW";
const answer = "The requested work is complete.";
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "cx-stop-objects-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "README.md"), "# repo\n");
  git("add", ".");
  git("-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "-qm", "base");
  return root;
}

/** Force every rendered patch VIEW past a 4 KiB buffer; all other Git reads stay real. */
function forceUnrenderedViews(): void {
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

async function runStopped(
  adapter: HarnessAdapter,
  input: Partial<RunInput> & { repoRoot: string },
  deps: { stop?: AbortController; reviewers?: ReviewerSpec[] } = {},
) {
  const stop = deps.stop ?? new AbortController();
  const result = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: deps.reviewers ?? [],
  }).run({
    mode: "agent",
    prompt: "edit",
    harnesses: [adapter.id],
    n: 1,
    review: false,
    signal: stop.signal,
    // The status event's own callback presses Stop; later events are drained.
    onHarnessEvent: (event: { text?: string }) => {
      if (event.text === STOP) stop.abort();
    },
    ...input,
  });
  return { result, store: new ArtifactStore(result.runDir) };
}

const yaml = (store: ArtifactStore, path: string) => store.readYaml<Record<string, any>>(path);

/** The store's custody records (root records with their optional pair, and pending leases). */
function storeCustody(projectRoot: string): { roots: Record<string, any>[]; pending: string[] } {
  const control = join(objectStorePath(projectRoot), "claudexor");
  const list = (name: string) =>
    existsSync(join(control, name)) ? readdirSync(join(control, name)) : [];
  return {
    roots: list("roots").map((name) =>
      JSON.parse(readFileSync(join(control, "roots", name), "utf8")),
    ),
    pending: list("pending"),
  };
}

/** `tree:path` is present in the project object store, read through the store alone. */
function inStore(projectRoot: string, spec: string): boolean {
  const store = objectStorePath(projectRoot);
  return (
    spawnSync("git", ["-C", store, "cat-file", "-e", spec], {
      env: { ...process.env, ...storeEnv(store) },
    }).status === 0
  );
}

/** A remote raw-API implementer that emits its patch envelope before or only after Stop. */
function rawPatchAfterStatus(patchAfterStop: boolean, newLine: string): HarnessAdapter {
  return {
    id: "raw-patch",
    async discover() {
      return HarnessManifest.parse({
        id: "raw-patch",
        display_name: "raw-patch",
        kind: "remote_api",
        provider_family: "openai",
        capabilities: { implement: true, implementation_transport: "git_patch_envelope" },
        access_profiles_supported: ["readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: "raw-patch",
        status: "ok",
        enabled_intents: ["implement"],
      });
    },
    async *run(spec) {
      const context = spec.raw_context_packet;
      if (!context) throw new Error("missing raw context packet");
      const readme = context.readable_files.find((file) => file.path === "README.md")!;
      const patch = [
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1 +1 @@",
        "-# repo",
        `+${newLine}`,
        "",
      ].join("\n");
      const envelope: HarnessEvent = {
        type: "patch_produced",
        session_id: spec.session_id,
        ts: new Date().toISOString(),
        patch_envelope: {
          schema_version: 1,
          context_packet_hash: context.packet_hash,
          base_tree_sha: context.base_tree_sha,
          patch,
          patch_hash: sha256(patch),
          touched_paths: [{ path: "README.md", expected_blob_oid: readme.blob_oid }],
        },
      };
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started" };
      if (!patchAfterStop) yield envelope;
      yield { ...common, type: "status", text: STOP };
      if (patchAfterStop) yield envelope;
      yield { ...common, type: "completed" };
    },
  };
}

describe("Stop over #535 object results (#337 x #535)", () => {
  it("(a) a capture fault after Stop ends cancelled with the pre-Stop answer and media kept, no retry", async () => {
    const root = repo();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    let shot = "";
    const base = createFakeHarness("fake-success");
    const adapter: HarnessAdapter = {
      ...base,
      async discover() {
        const manifest = await base.discover();
        return { ...manifest, capabilities: { ...manifest.capabilities, browser_tool: true } };
      },
      async *run(spec) {
        const common = { session_id: spec.session_id, ts: new Date().toISOString() };
        yield { ...common, type: "started", observed_model: "stop-fixture" };
        mkdirSync(spec.browser!.output_dir!, { recursive: true });
        shot = join(spec.browser!.output_dir!, "screenshot.png");
        writeFileSync(shot, png);
        writeFileSync(join(spec.cwd, "file.txt"), "after\n");
        yield { ...common, type: "message", text: answer, final: true };
        yield { ...common, type: "status", text: STOP };
        // Read only after Stop: recorded, never the answer.
        yield { ...common, type: "message", text: "AFTER_STOP_ANSWER", final: true };
        yield { ...common, type: "completed", exit_code: 0 };
      },
    };
    vi.spyOn(WorkspaceManager.prototype, "captureDiff").mockRejectedValue(
      new CaptureOutputExceeded("stdout"),
    );
    const { result, store } = await runStopped(adapter, {
      repoRoot: root,
      attempts: null,
      inPlace: true,
      browser: true,
      web: "auto",
    });
    expect(result.lifecycle).toBe("cancelled");
    expect(result.facts.reason).not.toBe("capture_refused");
    const facts = RunFacts.parse(yaml(store, join(result.runDir, "final/run_facts.yaml")));
    expect(facts.outcome.lifecycle).toBe("cancelled");
    // The live effects keep the capture-refused receipt under the cancellation's facts.
    const workProduct = yaml(store, join(result.runDir, "final/work_product.yaml"))!;
    expect(workProduct.meta).toMatchObject({ capture_refused: true, lifecycle: "cancelled" });
    // Capture runs after the work: nothing advises replaying it.
    expect(readFileSync(join(result.runDir, "final/summary.md"), "utf8")).not.toMatch(/retry/i);
    expect(JSON.stringify(workProduct.meta.recovery_detail)).not.toMatch(/retry/i);
    const failure = join(result.runDir, "final/failure.yaml");
    if (existsSync(failure))
      expect(JSON.stringify(yaml(store, failure)?.nextActions ?? [])).not.toMatch(/retry/i);
    // The pre-Stop answer and the produced media stay; the drained message is not the answer.
    const kept = readFileSync(join(result.runDir, "attempts/a01/answer.md"), "utf8");
    expect(kept).toContain(answer);
    expect(kept).not.toContain("AFTER_STOP_ANSWER");
    const produced = yaml(store, join(result.runDir, "attempts/a01/attempt.yaml"))!
      .produced_files as string[];
    expect(produced).toHaveLength(1);
    expect(readFileSync(join(result.runDir, "attempts/a01/produced", produced[0]!))).toEqual(png);
    expect(readFileSync(shot)).toEqual(png);
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("after\n");
  });

  it("(b) a raw patch accepted before Stop is the exact object result, unrendered when too large", async () => {
    const root = repo();
    forceUnrenderedViews();
    const line = `raw ${"x".repeat(8 * 1024)}`;
    const { result, store } = await runStopped(rawPatchAfterStatus(false, line), {
      repoRoot: root,
    });
    expect(result.lifecycle).toBe("cancelled");
    const workProduct = yaml(store, join(result.runDir, "final/work_product.yaml"))!;
    expect(workProduct.meta.git_result.schema).toBe("git_objects/v1");
    expect(workProduct.meta.patch_view).toMatchObject({
      available: false,
      reason: "exceeds_view_limit",
    });
    expect(existsSync(join(result.runDir, "final/patch.diff"))).toBe(false);
    // The materialized bytes are in the project store under this run's custody.
    const tree = workProduct.meta.git_result.candidate_tree as string;
    expect(inStore(root, `${tree}:README.md`)).toBe(true);
    const blob = execFileSync(
      "git",
      ["-C", objectStorePath(root), "cat-file", "-p", `${tree}:README.md`],
      {
        env: { ...process.env, ...storeEnv(objectStorePath(root)) },
      },
    ).toString("utf8");
    expect(blob).toBe(`${line}\n`);
    const custody = storeCustody(root);
    expect(custody.roots.some((record) => record.roots.includes(tree))).toBe(true);
    expect(custody.pending).toEqual([]);
    // The live project was never touched by an isolated result.
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("# repo\n");
  });

  it("(b) a raw patch first seen after Stop is never applied or kept: no store custody, pair or lease", async () => {
    const root = repo();
    const line = "LATE_RAW_PATCH_LINE";
    const { result } = await runStopped(rawPatchAfterStatus(true, line), { repoRoot: root });
    expect(result.lifecycle).toBe("cancelled");
    // Nothing of the late patch became a result, a root, a delivery pair or a lease.
    const custody = storeCustody(root);
    expect(custody.roots).toEqual([]);
    expect(custody.pending).toEqual([]);
    expect(existsSync(join(result.runDir, "final/work_product.yaml"))).toBe(false);
    // Nor is it stored as evidence anywhere in the run.
    for (const name of readdirSync(result.runDir, { recursive: true }).map(String)) {
      const path = join(result.runDir, name);
      if (statSync(path).isFile()) expect(readFileSync(path).includes(line), name).toBe(false);
    }
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("# repo\n");
  });

  it("(c) Stop pressed during synthesis still disposes every kept candidate workspace", async () => {
    const root = repo();
    const candidateRoots: string[] = [];
    let synthesisRoot = "";
    const base = createFakeHarness("fake-success");
    const adapter: HarnessAdapter = {
      ...base,
      async *run(spec) {
        const common = { session_id: spec.session_id, ts: new Date().toISOString() };
        yield { ...common, type: "started", observed_model: "fixture" };
        if (spec.intent === "synthesize") {
          synthesisRoot = spec.cwd;
          writeFileSync(join(spec.cwd, "merged.txt"), "merged\n");
          yield { ...common, type: "status", text: STOP };
          yield { ...common, type: "message", text: "Merged after Stop.", final: true };
        } else {
          candidateRoots.push(spec.cwd);
          writeFileSync(join(spec.cwd, "unique.txt"), `unique-${candidateRoots.length}\n`);
          writeFileSync(join(spec.cwd, "big.txt"), "x".repeat(64 * 1024));
          yield { ...common, type: "message", text: "Done.", final: true };
        }
        yield { ...common, type: "completed", exit_code: 0 };
      },
    };
    forceUnrenderedViews();
    // Best-of keeps its default review; with no reviewers configured it is skipped.
    const { result } = await runStopped(adapter, {
      repoRoot: root,
      n: 2,
      synthesis: "always",
      review: undefined,
    });
    expect(result.lifecycle).toBe("cancelled");
    expect(candidateRoots).toHaveLength(2);
    expect(synthesisRoot).not.toBe("");
    // Kept only until synthesis ended, then disposed on the Stop path too.
    for (const candidate of [...candidateRoots, synthesisRoot])
      expect(existsSync(candidate), candidate).toBe(false);
    expect(storeCustody(root).pending).toEqual([]);
  });

  it("(c) Stop pressed during review disposes the kept candidate workspace before the cancelled terminal", async () => {
    const root = repo();
    const stop = new AbortController();
    let candidateRoot = "";
    let reviewed = false;
    const base = createFakeHarness("fake-success");
    const adapter: HarnessAdapter = {
      ...base,
      async *run(spec) {
        const common = { session_id: spec.session_id, ts: new Date().toISOString() };
        candidateRoot = spec.cwd;
        yield { ...common, type: "started", observed_model: "fixture" };
        writeFileSync(join(spec.cwd, "big.txt"), "z".repeat(64 * 1024));
        yield { ...common, type: "message", text: "Done.", final: true };
        yield { ...common, type: "completed", exit_code: 0 };
      },
    };
    // The reviewer presses Stop while it reviews the unrendered result.
    const model = "stop-reviewer-model";
    const stopper: ReviewerSpec = {
      providerFamily: "openai",
      requestedModel: model,
      adapter: {
        id: "stop-reviewer",
        async discover() {
          return HarnessManifest.parse({
            id: "stop-reviewer",
            display_name: "stop-reviewer",
            kind: "local_cli",
            provider_family: "openai",
            access_profiles_supported: ["readonly"],
            capabilities: { review: true, known_models: [model] },
          });
        },
        async doctor() {
          return ConformanceReport.parse({
            harness_id: "stop-reviewer",
            status: "ok",
            enabled_intents: ["review"],
          });
        },
        async *run(spec) {
          reviewed = true;
          stop.abort();
          const common = { session_id: spec.session_id, ts: new Date().toISOString() };
          yield {
            ...common,
            type: "started",
            observed_model: model,
            credential_route: "managed_api_key",
          };
          yield { ...common, type: "message", text: "```json\n[]\n```" };
          yield { ...common, type: "completed" };
        },
      },
    };
    forceUnrenderedViews();
    const { result } = await runStopped(
      adapter,
      { repoRoot: root, review: true },
      { stop, reviewers: [stopper] },
    );
    expect(reviewed).toBe(true);
    expect(result.lifecycle).toBe("cancelled");
    expect(candidateRoot).not.toBe("");
    expect(existsSync(candidateRoot), candidateRoot).toBe(false);
    expect(storeCustody(root).pending).toEqual([]);
  });

  it("(d) files written before Stop are the exact object result of a Git workspace, unrendered too", async () => {
    const root = repo();
    forceUnrenderedViews();
    const base = createFakeHarness("fake-success");
    const adapter: HarnessAdapter = {
      ...base,
      async *run(spec) {
        const common = { session_id: spec.session_id, ts: new Date().toISOString() };
        yield { ...common, type: "started", observed_model: "fixture" };
        writeFileSync(join(spec.cwd, "big.txt"), "y".repeat(64 * 1024));
        writeFileSync(join(spec.cwd, "small.txt"), "small\n");
        yield { ...common, type: "status", text: STOP };
        // The file events are read only after Stop; Git capture reads the tree itself.
        for (const path of ["big.txt", "small.txt"])
          yield { ...common, type: "file_change", payload: { path } };
        yield { ...common, type: "completed", exit_code: 0 };
      },
    };
    const { result, store } = await runStopped(adapter, { repoRoot: root });
    expect(result.lifecycle).toBe("cancelled");
    const workProduct = yaml(store, join(result.runDir, "final/work_product.yaml"))!;
    expect(workProduct.meta.lifecycle).toBe("cancelled");
    expect(workProduct.meta.git_result.schema).toBe("git_objects/v1");
    expect(workProduct.meta.patch_view).toMatchObject({
      available: false,
      reason: "exceeds_view_limit",
    });
    expect(existsSync(join(result.runDir, "final/patch.diff"))).toBe(false);
    const tree = workProduct.meta.git_result.candidate_tree as string;
    for (const path of ["big.txt", "small.txt"])
      expect(inStore(root, `${tree}:${path}`)).toBe(true);
    expect(storeCustody(root).pending).toEqual([]);
  });
});
