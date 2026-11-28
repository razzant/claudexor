import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
import { EventLog, readRunEvents } from "@claudexor/event-log";
import { createFakeHarness } from "@claudexor/harness-fake";
import type { ReviewerSpec } from "@claudexor/review";
import {
  ConformanceReport,
  HarnessManifest,
  RunFacts,
  RunFailure,
  WorkspaceFilesManifest,
  RuntimeConcurrencyCaps,
  type HarnessRunSpec,
} from "@claudexor/schema";
import { fileCopyHost, WorkspaceManager } from "@claudexor/workspace";
import { captureDirectoryCandidate, prepareDirectoryReview } from "./directoryCandidate.js";
import { Orchestrator, type RunInput } from "./orchestrator.js";

// #783: the run's final files name the attempt's captured blobs a second time
// instead of writing them again. A publication that cannot complete records no
// file result, keeps the attempt's capture and the terminal's own cause.
const MiB = 1024 * 1024;
const posix = process.platform !== "win32";
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** A small file that is mostly holes wherever the filesystem keeps them. */
function writeImage(path: string): void {
  writeFileSync(path, "A".repeat(4096));
  truncateSync(path, MiB);
}

function author(
  act: (spec: HarnessRunSpec) => void | Promise<void>,
  ending?: "error",
  id = "writer",
  /** A work report the final message ends with (a validated footer). */
  report?: object,
): HarnessAdapter {
  const fake = createFakeHarness("fake-implement");
  return {
    ...fake,
    id,
    async discover() {
      return HarnessManifest.parse({
        ...(await fake.discover()),
        id,
        kind: "local_cli",
        capabilities: {
          ...(await fake.discover()).capabilities,
          review: false,
          synthesize: false,
          ...(report ? { work_report_transport: "validated" as const } : {}),
        },
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["implement", "repair"],
      });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield { type: "started", ts, session_id: spec.session_id };
      await act(spec);
      yield { type: "file_change", ts, session_id: spec.session_id, payload: { path: "disk.img" } };
      if (ending === "error") {
        yield { type: "error", ts, session_id: spec.session_id, error: "executor crashed" };
        return;
      }
      const footer = report
        ? `\n\n\`\`\`json\n${JSON.stringify({ work_report: report })}\n\`\`\``
        : "";
      yield {
        type: "message",
        ts,
        session_id: spec.session_id,
        text: `Done.${footer}`,
        final: true,
      };
      yield { type: "completed", ts, session_id: spec.session_id };
    },
  };
}

function project() {
  const root = temp("cx-dir-publish-project-");
  writeFileSync(join(root, "input.txt"), "selected source\n");
  return root;
}

function start(adapter: HarnessAdapter, extra: Partial<RunInput> = {}) {
  const repoRoot = project();
  return new Orchestrator({ registry: new Map([[adapter.id, adapter]]) }).run({
    repoRoot,
    prompt: "Create the image",
    harnesses: [adapter.id],
    workspaceKind: "directory",
    scopePaths: ["input.txt"],
    review: false,
    ...extra,
  });
}

const blobsIn = (root: string) =>
  readdirSync(join(root, "final/files/content")).map((name) =>
    join(root, "final/files/content", name),
  );

/** Refuse only the run's own final blob names (not an attempt's or a review
 * packet's), as a destination out of space does. */
const RUN_FINAL_BLOB = /runs[\\/]run-[^\\/]+[\\/]final[\\/]files[\\/]content[\\/]/;
function refusePublication() {
  const real = fileCopyHost.link;
  return vi
    .spyOn(fileCopyHost, "link")
    .mockImplementation((source, target) =>
      RUN_FINAL_BLOB.test(String(target))
        ? Promise.reject(Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" }))
        : real(source, target),
    );
}

function terminal(runDir: string) {
  const store = new ArtifactStore(runDir);
  const failurePath = join(runDir, "final/failure.yaml");
  return {
    facts: RunFacts.parse(store.readYaml(join(runDir, "final/run_facts.yaml"))),
    failure: existsSync(failurePath) ? RunFailure.parse(store.readYaml(failurePath)) : null,
    summary: readFileSync(join(runDir, "final/summary.md"), "utf8"),
    events: readRunEvents(join(runDir, "events.jsonl")).events.map((event) => event.type),
    failedPhase: readRunEvents(join(runDir, "events.jsonl")).events.find(
      (event) => event.type === "run.failed",
    )?.payload?.["phase"],
  };
}

const failedEvent = (runDir: string) =>
  readRunEvents(join(runDir, "events.jsonl")).events.find((event) => event.type === "run.failed")
    ?.payload;

/** No final result claims bytes it lacks, and the attempt's capture is whole. */
function expectOnlyAttemptCopy(runDir: string, attemptId: string) {
  expect(existsSync(join(runDir, "final/work_product.yaml"))).toBe(false);
  expect(existsSync(join(runDir, "final/files/manifest.json"))).toBe(false);
  expect(existsSync(join(runDir, "final/files/result.md"))).toBe(false);
  const attempt = join(runDir, "attempts", attemptId);
  const manifest = WorkspaceFilesManifest.parse(
    JSON.parse(readFileSync(join(attempt, "final/files/manifest.json"), "utf8")),
  );
  for (const entry of manifest.entries)
    if (entry.after?.kind === "file")
      expect(lstatSync(join(attempt, entry.after.artifactPath!)).size).toBe(entry.after.sizeBytes);
}

describe.each([
  ["one attempt", {}, "a01"],
  ["capped repair", { attempts: 2 }, "a01"],
])("a directory result: %s", (_name, extra: Partial<RunInput>, attemptId) => {
  it("publishes the attempt's blobs without a second payload", async () => {
    const result = await start(
      author((spec) => writeImage(join(spec.cwd, "disk.img"))),
      extra,
    );

    expect(result.lifecycle).toBe("succeeded");
    const final = blobsIn(result.runDir);
    expect(final.length).toBeGreaterThan(0);
    const attempt = join(result.runDir, "attempts", attemptId);
    for (const blob of final) {
      const twin = lstatSync(join(attempt, "final/files/content", blob.split(sep).at(-1)!));
      const published = lstatSync(blob);
      if (posix) {
        expect(published.ino).toBe(twin.ino);
        expect(published.mode & 0o777).toBe(0o600);
      }
    }
    expect(existsSync(join(result.runDir, "final/work_product.yaml"))).toBe(true);
  });

  it("fails a success it cannot publish, with the typed cause", async () => {
    refusePublication();
    const result = await start(
      author((spec) => writeImage(join(spec.cwd, "disk.img"))),
      extra,
    );

    const { facts, failure, summary, events, failedPhase } = terminal(result.runDir);
    expect(result.lifecycle).toBe("failed");
    // The event and final/failure.yaml name one phase.
    expect(failedPhase).toBe(failure!.phase);
    expect(facts.outcome).toMatchObject({ lifecycle: "failed", reason: "capture_refused" });
    expect(failure).toMatchObject({ phase: "workspace", category: "project" });
    expect(failure!.captureFailure).toMatchObject({ code: "capture_space_insufficient" });
    expect(failure!.safeMessage).toContain("could not be published");
    expect(failure!.nextActions).toContain(
      `Inspect the changed files at ${join(result.runDir, "attempts", attemptId, "final/files")}`,
    );
    expect(summary).toContain("could not be published");
    expect(events).not.toContain("work_product.emitted");
    const decision = new ArtifactStore(result.runDir).readYaml<{
      facts: { lifecycle: string };
      apply_recommendation: string;
    }>(join(result.runDir, "arbitration/decision.yaml"))!;
    expect(decision).toMatchObject({
      facts: { lifecycle: "failed" },
      apply_recommendation: "inspect",
    });
    expectOnlyAttemptCopy(result.runDir, attemptId);
  });

  it("keeps a cancellation as the cause", async () => {
    refusePublication();
    const controller = new AbortController();
    const result = await start(
      author((spec) => {
        writeImage(join(spec.cwd, "disk.img"));
        controller.abort();
      }),
      { ...extra, signal: controller.signal },
    );

    const { facts, failure } = terminal(result.runDir);
    expect(facts.outcome.lifecycle).toBe("cancelled");
    expect(failure).toMatchObject({ category: "cancelled" });
    expect(failure!.captureFailure).toMatchObject({ code: "capture_space_insufficient" });
    expectOnlyAttemptCopy(result.runDir, attemptId);
  });

  it("keeps an executor failure as the cause", async () => {
    refusePublication();
    const result = await start(
      author((spec) => writeImage(join(spec.cwd, "disk.img")), "error"),
      extra,
    );

    const { facts, failure } = terminal(result.runDir);
    expect(facts.outcome.lifecycle).toBe("failed");
    expect(facts.outcome.reason).not.toBe("capture_refused");
    expect(failure!.captureFailure).toMatchObject({ code: "capture_space_insufficient" });
    expect(failure!.safeMessage).toContain("executor crashed");
    // The executor's own cause leads; the refused publication is the second statement.
    const lines = failure!.safeMessage.split("\n");
    const published = lines.findIndex((line) => line.includes("could not be published"));
    expect(lines.findIndex((line) => line.includes("executor crashed"))).toBeLessThan(published);
    expect(published).toBeGreaterThan(-1);
    expectOnlyAttemptCopy(result.runDir, attemptId);
  });
});

/** A reviewer that reports what it was handed and finds nothing. */
function reviewer(
  id: string,
  providerFamily: "openai" | "anthropic",
  inspect: (spec: HarnessRunSpec) => void,
): ReviewerSpec {
  const adapter: HarnessAdapter = {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: providerFamily,
        access_profiles_supported: ["readonly"],
        capabilities: { review: true, read_files: true, known_models: [`${id}-model`] },
      });
    },
    async doctor() {
      return ConformanceReport.parse({ harness_id: id, status: "ok", enabled_intents: ["review"] });
    },
    async *run(spec) {
      inspect(spec);
      const ts = new Date().toISOString();
      yield {
        type: "started",
        session_id: spec.session_id,
        ts,
        observed_model: `${id}-model`,
        credential_route: "managed_api_key",
      };
      yield { type: "message", session_id: spec.session_id, ts, text: "```json\n[]\n```" };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
  return { adapter, providerFamily } as ReviewerSpec;
}

function reviewedRun(
  inspect: (spec: HarnessRunSpec) => void,
  options: { write?: (spec: HarnessRunSpec) => void; attempts?: number } = { attempts: 2 },
) {
  const writer = author(options.write ?? ((spec) => writeImage(join(spec.cwd, "disk.img"))));
  const reviewers = [
    reviewer("review-a", "openai", inspect),
    reviewer("review-b", "anthropic", inspect),
  ];
  const registry = new Map(
    [writer, ...reviewers.map((item) => item.adapter)].map((item) => [item.id, item]),
  );
  return new Orchestrator({ registry, reviewers }).run({
    repoRoot: project(),
    prompt: "Create the image",
    harnesses: [writer.id],
    workspaceKind: "directory",
    scopePaths: ["input.txt"],
    review: true,
    ...(options.attempts ? { attempts: options.attempts } : {}),
  });
}

describe("a reviewed directory result", () => {
  it("hands each reviewer its own files and keeps one saved payload", async () => {
    const seen: Array<{ bytes: number; inode: number; links: number }> = [];
    const result = await reviewedRun((spec) => {
      const image = lstatSync(join(spec.cwd, "disk.img"));
      seen.push({ bytes: image.size, inode: image.ino, links: image.nlink });
    });

    expect(result.lifecycle).toBe("succeeded");
    expect(seen).toHaveLength(2);
    const name = createHash("sha256")
      .update("A".repeat(4096))
      .update(Buffer.alloc(MiB - 4096))
      .digest("hex");
    const blob = join("final/files/content", name);
    const saved = lstatSync(join(result.runDir, "attempts/a01", blob));
    for (const copy of seen) {
      expect(copy.bytes).toBe(MiB);
      if (posix) expect(copy).toMatchObject({ links: 1 });
      if (posix) expect(copy.inode).not.toBe(saved.ino);
    }
    const reviews = join(result.runDir, "reviews");
    const persistent = readdirSync(reviews).find((entry) => entry.endsWith("-reviewers"))!;
    for (const path of [join(result.runDir, blob), join(reviews, persistent, "evidence", blob)])
      if (posix) expect(lstatSync(path).ino).toBe(saved.ino);
  });

  it("builds no review copies for a result no reviewer reads", async () => {
    let reviews = 0;
    // A single candidate that changed nothing reaches no panel.
    const result = await reviewedRun(() => (reviews += 1), { write: () => undefined });

    expect(reviews).toBe(0);
    expect(existsSync(join(result.runDir, "final/files/manifest.json"))).toBe(true);
    expect(existsSync(join(result.runDir, "review-evidence/FILES.json"))).toBe(false);
    expect(existsSync(join(result.runDir, "review-evidence/final/files"))).toBe(false);
  });

  it("states why a post-review check could not read the result", async () => {
    const real = WorkspaceManager.prototype.captureFiles;
    vi.spyOn(WorkspaceManager.prototype, "captureFiles").mockImplementation(function (
      this: WorkspaceManager,
      ...args
    ) {
      if (args[2]?.retainContent === false)
        return Promise.reject(Object.assign(new Error("EACCES: locked"), { code: "EACCES" }));
      return real.apply(this, args);
    });
    const result = await reviewedRun(() => undefined);

    const { facts, failure } = terminal(result.runDir);
    expect(facts.outcome).toMatchObject({ lifecycle: "failed", reason: "capture_refused" });
    expect(failure!.captureFailure).toMatchObject({ causeCode: "EACCES" });
    expect(failure!.safeMessage).toContain("post-review stability check could not verify");
    expect(failure!.safeMessage).not.toMatch(/stale|diff changed/);
    // The captured result itself is whole and published.
    expect(existsSync(join(result.runDir, "final/work_product.yaml"))).toBe(true);
  });

  it.each([
    ["race", { attempts: undefined }],
    ["convergence", { attempts: 2 }],
  ])("states that its review copies could not fit: %s", async (_lane, options) => {
    vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
    const space = fileCopyHost.availableBytes;
    vi.spyOn(fileCopyHost, "availableBytes").mockImplementation((dir) =>
      dir.includes("directory-review") ? 0 : space(dir),
    );
    let reviews = 0;
    const result = await reviewedRun(() => (reviews += 1), options);

    const { facts, failure } = terminal(result.runDir);
    expect(reviews).toBe(0);
    expect(facts.outcome.lifecycle).toBe("failed");
    expect(failure).toMatchObject({ phase: "review" });
    expect(failure!.captureFailure).toMatchObject({ code: "capture_space_insufficient" });
    expect(existsSync(join(result.runDir, "attempts/a01/directory-review"))).toBe(false);
  });

  it("keeps a review error as the cause beside a refused publication", async () => {
    refusePublication();
    vi.spyOn(
      Orchestrator.prototype as unknown as { reviewRuns: () => Promise<unknown> },
      "reviewRuns",
    ).mockRejectedValue(new Error("reviewer preparation failed"));
    const result = await reviewedRun(() => undefined);

    const { facts, failure } = terminal(result.runDir);
    expect(facts.outcome.lifecycle).toBe("failed");
    expect(failure).toMatchObject({ phase: "review" });
    // The review's error leads; the refused publication is stated after it.
    const [lead, ...rest] = failure!.safeMessage.split("\n");
    expect(lead).toContain("reviewer preparation failed");
    expect(rest.join("\n")).toContain("could not be published as the run's final files");
    expect(failure!.captureFailure).toMatchObject({ code: "capture_space_insufficient" });
    expectOnlyAttemptCopy(result.runDir, "a01");
  });
});

describe("a directory race that already delivered", () => {
  it("keeps the delivery receipt when the publication is refused", async () => {
    refusePublication();
    const writers = ["writer-a", "writer-b"].map((id) =>
      author((spec) => writeImage(join(spec.cwd, "disk.img")), undefined, id),
    );
    const reviewers = [
      reviewer("review-a", "openai", () => undefined),
      reviewer("review-b", "anthropic", () => undefined),
    ];
    const adapters = [...writers, ...reviewers.map((item) => item.adapter)];
    const repoRoot = project();
    const result = await new Orchestrator({
      registry: new Map(adapters.map((adapter) => [adapter.id, adapter])),
      reviewers,
    }).run({
      repoRoot,
      prompt: "Create the image",
      harnesses: writers.map((writer) => writer.id),
      n: 2,
      workspaceKind: "directory",
      scopePaths: ["input.txt"],
      inPlace: true,
      review: true,
    });

    expect(lstatSync(join(repoRoot, "disk.img")).size).toBe(MiB);
    const { facts, failure } = terminal(result.runDir);
    expect(facts.outcome).toMatchObject({ lifecycle: "failed", reason: "capture_refused" });
    expect(failure!.safeMessage).toContain("already delivered stays recorded");
    expect(existsSync(join(result.runDir, "final/delivery_receipt.yaml"))).toBe(true);
    expect(existsSync(join(result.runDir, "final/work_product.yaml"))).toBe(false);
  });
});

describe("a directory result's review copies", () => {
  async function captured() {
    const root = project();
    const manager = new WorkspaceManager(root, { runtimeRoot: temp("cx-dir-publish-runtime-") });
    const envelope = await manager.create({
      taskId: "t",
      attemptId: "a",
      workspaceKind: "directory",
      scopePaths: ["input.txt"],
    });
    writeImage(join(envelope.worktree_path, "disk.img"));
    const artifactRoot = temp("cx-dir-publish-attempt-");
    const { files } = await captureDirectoryCandidate({
      manager,
      envelope,
      artifactRoot,
      observedPaths: [],
    });
    return { files: files!, artifactRoot, evidence: temp("cx-dir-publish-evidence-") };
  }

  it("shares the evidence blobs and gives the candidate tree its own files", async () => {
    const f = await captured();
    const review = await prepareDirectoryReview(f.files, f.evidence);
    const image = f.files.manifest.entries.find((entry) => entry.path === "disk.img")!.after!;
    if (image.kind !== "file") throw new Error("expected a file");
    const saved = join(f.artifactRoot, image.artifactPath!);
    const evidence = join(f.evidence, image.artifactPath!);
    const candidate = join(review.cwd, "disk.img");
    expect(readFileSync(candidate).equals(readFileSync(saved))).toBe(true);
    if (posix) {
      expect(lstatSync(evidence).ino).toBe(lstatSync(saved).ino);
      expect(lstatSync(candidate).ino).not.toBe(lstatSync(saved).ino);
    }
    truncateSync(candidate, 1);
    expect(lstatSync(saved).size).toBe(MiB);
    // A second preparation of the same packet replaces its own names only.
    await review.dispose();
    await (await prepareDirectoryReview(f.files, f.evidence)).dispose();
    expect(lstatSync(saved).size).toBe(MiB);
    expect(existsSync(review.cwd)).toBe(false);
  });

  it("refuses, with no partial candidate tree, when a copy cannot fit", async () => {
    const f = await captured();
    vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
    vi.spyOn(fileCopyHost, "availableBytes").mockReturnValue(0);
    await expect(prepareDirectoryReview(f.files, f.evidence)).rejects.toMatchObject({
      code: "capture_space_insufficient",
    });
    expect(existsSync(join(f.artifactRoot, "directory-review"))).toBe(false);
  });
});

const serial = RuntimeConcurrencyCaps.parse({ max_parallel_candidates: 1 });

/** A project whose selected scope includes a 1 MiB image, so even its baseline costs room. */
function projectWithImage() {
  const root = project();
  writeImage(join(root, "base.img"));
  return root;
}

describe("one stored copy per digest across a run's attempts", () => {
  it.skipIf(!posix)("links the second attempt's identical result to the first", async () => {
    const writers = ["writer-a", "writer-b"].map((id) =>
      author((spec) => writeImage(join(spec.cwd, "disk.img")), undefined, id),
    );
    const reviewers = [
      reviewer("review-a", "openai", () => undefined),
      reviewer("review-b", "anthropic", () => undefined),
    ];
    const adapters = [...writers, ...reviewers.map((item) => item.adapter)];
    const result = await new Orchestrator({
      registry: new Map(adapters.map((adapter) => [adapter.id, adapter])),
      reviewers,
      runtimeConcurrencyCaps: serial,
    }).run({
      repoRoot: project(),
      prompt: "Create the image",
      harnesses: writers.map((writer) => writer.id),
      n: 2,
      workspaceKind: "directory",
      scopePaths: ["input.txt"],
      review: true,
    });

    expect(result.lifecycle).toBe("succeeded");
    const stored = ["a01", "a02"].map((id) => {
      const content = join(result.runDir, "attempts", id, "final/files/content");
      return readdirSync(content)
        .map((name) => lstatSync(join(content, name)))
        .filter((info) => info.size === MiB)
        .map((info) => info.ino);
    });
    expect(stored[0]).toHaveLength(1);
    expect(stored[1]).toEqual(stored[0]);
  });
});

describe("a publication's commit point", () => {
  it("takes the work product back when the ready event is not durably landed", async () => {
    const real = EventLog.prototype.emitLanded;
    vi.spyOn(EventLog.prototype, "emitLanded").mockImplementation(function (
      this: EventLog,
      ...args: Parameters<EventLog["emitLanded"]>
    ) {
      if (args[0] === "output.ready" && (args[1] as { kind?: string })?.kind === "artifact")
        return Promise.reject(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }));
      return real.apply(this, args);
    });
    const result = await start(author((spec) => writeImage(join(spec.cwd, "disk.img"))));

    const { facts, failure } = terminal(result.runDir);
    expect(facts.outcome).toMatchObject({ lifecycle: "failed", reason: "capture_refused" });
    expect(failure!.captureFailure).toMatchObject({ causeCode: "EIO" });
    expect(failure!.safeMessage).not.toContain("harness");
    expectOnlyAttemptCopy(result.runDir, "a01");
  });

  it("keeps the files its ready line names when only the journal after that line fails", async () => {
    const real = EventLog.prototype.emitLanded;
    vi.spyOn(EventLog.prototype, "emitLanded").mockImplementation(function (
      this: EventLog,
      ...args: Parameters<EventLog["emitLanded"]>
    ) {
      if (args[0] !== "output.ready" || (args[1] as { kind?: string })?.kind !== "artifact")
        return real.apply(this, args);
      // The run's own file takes the line; its durable journal then refuses it.
      return real.apply(this, args).then((event) => {
        throw Object.assign(new Error("EIO: journal write failed"), { code: "EIO", event });
      });
    });
    const result = await start(author((spec) => writeImage(join(spec.cwd, "disk.img"))));

    const { facts, failure } = terminal(result.runDir);
    expect(facts.outcome).toMatchObject({ lifecycle: "failed", reason: "capture_refused" });
    expect(failure!.captureFailure).toMatchObject({ causeCode: "EIO" });
    expect(failure!.safeMessage).toContain("the daemon journal did not accept it");
    const ready = readRunEvents(join(result.runDir, "events.jsonl")).events.filter(
      (event) => event.type === "output.ready" && event.payload?.["kind"] === "artifact",
    );
    expect(ready.map((event) => event.payload?.["path"])).toEqual(["final/files/manifest.json"]);
    // What the replayable line names stays whole; no work product claims it.
    const manifest = WorkspaceFilesManifest.parse(
      JSON.parse(readFileSync(join(result.runDir, "final/files/manifest.json"), "utf8")),
    );
    for (const entry of manifest.entries)
      if (entry.after?.kind === "file")
        expect(lstatSync(join(result.runDir, entry.after.artifactPath!)).size).toBe(
          entry.after.sizeBytes,
        );
    expect(existsSync(join(result.runDir, "final/work_product.yaml"))).toBe(false);
  });

  it("types a space failure writing the manifest itself", async () => {
    const real = ArtifactStore.prototype.writeTextAsync;
    vi.spyOn(ArtifactStore.prototype, "writeTextAsync").mockImplementation(function (
      this: ArtifactStore,
      ...args: Parameters<ArtifactStore["writeTextAsync"]>
    ) {
      if (/runs[\\/]run-[^\\/]+[\\/]final[\\/]files[\\/]manifest\.json$/.test(String(args[0])))
        return Promise.reject(Object.assign(new Error("ENOSPC: no space"), { code: "ENOSPC" }));
      return real.apply(this, args);
    });
    const result = await start(author((spec) => writeImage(join(spec.cwd, "disk.img"))));

    const { failure } = terminal(result.runDir);
    expect(failure!.captureFailure).toMatchObject({ code: "capture_space_insufficient" });
    expectOnlyAttemptCopy(result.runDir, "a01");
  });
});

describe("one capture of an attempt's bytes", () => {
  it("does not need room twice for one stored copy", async () => {
    vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
    // Room for one copy of the image and the margin, and not for a second: counted
    // by the logical length already stored in the same content directory.
    const room = MiB + 64 * MiB + MiB / 2;
    const real = fileCopyHost.availableBytes;
    vi.spyOn(fileCopyHost, "availableBytes").mockImplementation((dir) => {
      if (!/attempts[\\/]a01[\\/]final[\\/]files[\\/]content$/.test(dir)) return real(dir);
      const held = existsSync(dir)
        ? readdirSync(dir).reduce((sum, name) => sum + lstatSync(join(dir, name)).size, 0)
        : 0;
      return room - held;
    });
    const result = await start(author((spec) => writeImage(join(spec.cwd, "disk.img"))));

    expect(result.lifecycle).toBe("succeeded");
    expect(blobsIn(result.runDir).some((blob) => lstatSync(blob).size === MiB)).toBe(true);
  });
});

describe("a typed space cause at the other boundaries", () => {
  it("names a workspace that could not be prepared for want of room", async () => {
    vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
    vi.spyOn(fileCopyHost, "availableBytes").mockReturnValue(0);
    const writer = author(() => undefined);
    const result = await new Orchestrator({ registry: new Map([[writer.id, writer]]) }).run({
      repoRoot: projectWithImage(),
      prompt: "Create the image",
      harnesses: [writer.id],
      workspaceKind: "directory",
      scopePaths: ["input.txt", "base.img"],
      review: false,
    });

    const { facts, failure } = terminal(result.runDir);
    expect(facts.outcome.lifecycle).toBe("failed");
    expect(failure!.captureFailure).toMatchObject({ code: "capture_space_insufficient" });
  });

  it("names a convergence workspace that could not be prepared before its loop", async () => {
    vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
    vi.spyOn(fileCopyHost, "availableBytes").mockReturnValue(0);
    const writer = author(() => undefined);
    const result = await new Orchestrator({ registry: new Map([[writer.id, writer]]) }).run({
      repoRoot: projectWithImage(),
      prompt: "Create the image",
      harnesses: [writer.id],
      attempts: 2,
      workspaceKind: "directory",
      scopePaths: ["input.txt", "base.img"],
      review: false,
    });

    const { facts, failure, failedPhase, summary } = terminal(result.runDir);
    expect(facts.outcome).toMatchObject({ lifecycle: "failed", reason: "capture_refused" });
    expect(failure).toMatchObject({ phase: "workspace", category: "project" });
    expect(failure!.captureFailure).toMatchObject({ code: "capture_space_insufficient" });
    expect(failedPhase).toBe("workspace");
    expect(summary).toContain("- Phase: workspace");
  });

  it("keeps the typed cause of an attempt whose capture was refused when cancelled", async () => {
    vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
    const real = fileCopyHost.availableBytes;
    vi.spyOn(fileCopyHost, "availableBytes").mockImplementation((dir) =>
      /attempts[\\/]a01[\\/]final[\\/]files[\\/]content$/.test(dir) ? 0 : real(dir),
    );
    const controller = new AbortController();
    const result = await start(
      author((spec) => {
        writeImage(join(spec.cwd, "disk.img"));
        controller.abort();
      }),
      { signal: controller.signal },
    );

    const { facts, failure, failedPhase, summary } = terminal(result.runDir);
    expect(facts.outcome.lifecycle).toBe("cancelled");
    expect(failure).toMatchObject({ category: "cancelled" });
    expect(failure!.captureFailure).toMatchObject({ code: "capture_space_insufficient" });
    // The event and the summary state the same terminal as the record.
    expect(failedPhase).toBe("workspace");
    expect(failedEvent(result.runDir)?.["failure_ref"]).toBe("final/failure.yaml");
    expect(summary).toContain("Directory output capture failed");
  });

  it("keeps a failed capture beside another attempt's kept files when cancelled", async () => {
    vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
    const real = fileCopyHost.availableBytes;
    vi.spyOn(fileCopyHost, "availableBytes").mockImplementation((dir) =>
      /attempts[\\/]a01[\\/]final[\\/]files[\\/]content$/.test(dir) ? 0 : real(dir),
    );
    const controller = new AbortController();
    let finished = 0;
    const act = (spec: HarnessRunSpec) => {
      writeImage(join(spec.cwd, "disk.img"));
      if (++finished === 2) controller.abort();
    };
    const writers = ["writer-a", "writer-b"].map((id) => author(act, undefined, id));
    const reviewers = [
      reviewer("review-a", "openai", () => undefined),
      reviewer("review-b", "anthropic", () => undefined),
    ];
    const adapters = [...writers, ...reviewers.map((item) => item.adapter)];
    const result = await new Orchestrator({
      registry: new Map(adapters.map((adapter) => [adapter.id, adapter])),
      reviewers,
      runtimeConcurrencyCaps: serial,
    }).run({
      repoRoot: project(),
      prompt: "Create the image",
      harnesses: writers.map((writer) => writer.id),
      n: 2,
      workspaceKind: "directory",
      scopePaths: ["input.txt"],
      review: true,
      signal: controller.signal,
    });

    const { facts, failure, failedPhase } = terminal(result.runDir);
    expect(facts.outcome.lifecycle).toBe("cancelled");
    expect(failure).toMatchObject({ category: "cancelled", attemptId: "a01" });
    expect(failure!.captureFailure).toMatchObject({ code: "capture_space_insufficient" });
    expect(failedPhase).toBe("workspace");
  });
});

describe.each([
  ["race", {}],
  ["convergence", { attempts: 1 }],
] as const)("a refused publication of a blocked %s run", (_lane, lane) => {
  it("keeps the failed checks as the cause, with the refusal beside it", async () => {
    refusePublication();
    const result = await start(
      author((spec) => writeImage(join(spec.cwd, "disk.img"))),
      {
        ...lane,
        tests: [{ program: process.execPath, args: ["-e", "process.exit(1)"], envAllowlist: [] }],
      },
    );

    const { facts, failure } = terminal(result.runDir);
    expect(facts.outcome).toMatchObject({ lifecycle: "succeeded", checks: "failed" });
    expect(facts.outcome.reason).not.toBe("capture_refused");
    expect(failure!.captureFailure).toMatchObject({ code: "capture_space_insufficient" });
    expect(failure!.phase).not.toBe("workspace");
    // The secondary refusal keeps its own statement and the kept copy's address.
    expect(failure!.safeMessage).toContain("could not be published as the run's final files");
    expect(failure!.nextActions.join("\n")).toMatch(/attempts[\\/]a01[\\/]final[\\/]files/);
    expect(existsSync(join(result.runDir, "final/work_product.yaml"))).toBe(false);
  });
});

describe.each([
  ["race", {}],
  ["convergence", { attempts: 1 }],
] as const)("a refused publication of an unfinished %s run", (_lane, lane) => {
  it.each([
    [
      "needs input",
      {
        state: "needs_input",
        required_inputs: [{ kind: "decision", locator: "db", description: "Which database?" }],
      },
      "input_required",
      "The run needs input",
      "Provide the requested input and continue the run",
    ],
    [
      "incomplete",
      { state: "incomplete", required_inputs: [] },
      "work_incomplete",
      "The run reported its work incomplete",
      "Continue the run to finish the remaining work",
    ],
  ] as const)(
    "%s: keeps the report as the cause and records the refusal beside it",
    async (_state, report, reason, statement, remedy) => {
      refusePublication();
      const result = await start(
        author((spec) => writeImage(join(spec.cwd, "disk.img")), undefined, "writer", report),
        lane,
      );

      const { facts, failure, events } = terminal(result.runDir);
      expect(facts.outcome).toMatchObject({ lifecycle: "succeeded", reason });
      expect(failure).toMatchObject({ phase: "workspace", category: "project" });
      expect(failure!.captureFailure).toMatchObject({
        code: "capture_space_insufficient",
        causeCode: "ENOSPC",
      });
      const [lead, ...rest] = failure!.safeMessage.split("\n");
      expect(lead).toContain(statement);
      expect(rest.join("\n")).toContain("could not be published as the run's final files");
      expect(failure!.nextActions[0]).toBe(remedy);
      // The returned summary leads with the same report, the refusal after it.
      const [summaryLead, ...summaryRest] = result.summary.split("\n");
      expect(summaryLead).toContain(statement);
      expect(summaryRest.join("\n")).toContain("could not be published");
      expect(failure!.nextActions).toContain(
        `Inspect the changed files at ${join(result.runDir, "attempts", "a01", "final/files")}`,
      );
      const blocked = readRunEvents(join(result.runDir, "events.jsonl")).events.find(
        (event) => event.type === "run.blocked",
      );
      expect(blocked?.payload).toMatchObject({
        phase: "workspace",
        failure_ref: "final/failure.yaml",
        facts: { reason },
      });
      expect(events).not.toContain("work_product.emitted");
      expect(existsSync(join(result.runDir, "final/work_product.yaml"))).toBe(false);
      const decision = new ArtifactStore(result.runDir).readYaml<{
        apply_recommendation: string;
      }>(join(result.runDir, "arbitration/decision.yaml"))!;
      expect(decision.apply_recommendation).toBe("inspect");
    },
  );
});

describe.each([
  ["race", {}],
  ["convergence", { attempts: 1 }],
] as const)("a %s run whose verification copy lacks room", (_lane, lane) => {
  it("leads with the unproven verification and its remedy, never an accepted risk", async () => {
    vi.spyOn(fileCopyHost, "clone").mockResolvedValue(false);
    const real = fileCopyHost.availableBytes;
    vi.spyOn(fileCopyHost, "availableBytes").mockImplementation((dir) =>
      dir.includes("claudexor-verify-files-") ? 0 : real(dir),
    );
    const result = await start(
      author((spec) => writeImage(join(spec.cwd, "disk.img"))),
      lane,
    );

    const { facts, failure } = terminal(result.runDir);
    expect(facts.outcome).toMatchObject({ lifecycle: "succeeded", checks: "failed" });
    expect(failure).toMatchObject({ phase: "verification", category: "validation" });
    expect(failure!.captureFailure).toMatchObject({ code: "capture_space_insufficient" });
    expect(failure!.safeMessage).toContain("final verify ERRORED");
    expect(failure!.nextActions.join("\n")).toContain("Free disk space for the verification copy");
    expect(failure!.nextActions.join("\n")).not.toMatch(/accept_risk|Accept the risk/);
    const blocked = readRunEvents(join(result.runDir, "events.jsonl")).events.find(
      (event) => event.type === "run.blocked",
    );
    expect(blocked?.payload).toMatchObject({ phase: "verification" });
    expect(result.summary.split("\n")[0]).toContain("final verify ERRORED");
    expect(result.summary).not.toContain("converged");
  });
});
