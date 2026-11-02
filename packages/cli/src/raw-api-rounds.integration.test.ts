/**
 * #551 through the production path: the real Orchestrator, the real adapter and
 * real Git run convergence rounds of a patch producer against a LOCAL endpoint.
 * Each round is produced and applied against the exact candidate the previous
 * round left, while the run keeps its one delivery base, so the final result from
 * that base holds every round. A refused patch is the attempt's own typed failure
 * with its usage kept, never a crashed process.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { createRawApiAdapter } from "@claudexor/harness-raw-api";
import { Orchestrator } from "@claudexor/orchestrator";
import { ControlRunSummary, type HarnessRunSpec } from "@claudexor/schema";
import { detailFor, summarizeRun } from "../../control-api/src/run-projection.js";
import type { DaemonRunRecord } from "../../control-api/src/run-record.js";
import {
  KEY_ENV,
  attemptRecord,
  blobOidOf,
  committed,
  failureRecord,
  git,
  nativeReader,
  ownedDir,
  removeOwnedDirs,
  runEvents,
  sentPacket,
  startLoopback,
  telemetryRecord,
  type Loopback,
} from "./test-support/raw-api-loopback.js";

// Real Git runs: the timeouts detect hangs, and a busy machine is not one.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });

let provider: Loopback;
beforeAll(async () => {
  provider = await startLoopback();
});
afterAll(async () => {
  await provider.stop();
});
beforeEach(() => {
  provider.reset();
  process.env[KEY_ENV] = "sk-contract";
});
afterEach(() => {
  delete process.env[KEY_ENV];
  removeOwnedDirs();
});

const openrouter = () =>
  createRawApiAdapter({
    id: "openrouter",
    providerFamily: "unknown",
    providerUsageCostUnit: "usd",
    baseUrl: provider.baseUrl,
    keyEnv: KEY_ENV,
  });

/** A required gate: passes only once `file` holds `text`. */
const gateOn = (file: string, text: string) => ({
  program: process.execPath,
  envAllowlist: [],
  args: [
    "-e",
    `const s=require("fs").existsSync(${JSON.stringify(file)})?require("fs").readFileSync(${JSON.stringify(file)},"utf8"):"";process.exit(s.includes(${JSON.stringify(text)})?0:1)`,
  ],
});

const rounds = (
  adapter: HarnessAdapter,
  repoRoot: string,
  attempts: number,
  input: Record<string, unknown> = {},
) =>
  new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [],
  }).run({
    repoRoot,
    prompt: "Build the feature",
    mode: "agent",
    harnesses: [adapter.id],
    models: { [adapter.id]: "vendor/big" },
    attempts,
    review: false,
    ...input,
  });

const edit = (path: string, from: string, to: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;
const create = (path: string, line: string) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${line}\n`;

/** The final patch must apply to the run's base and reproduce `expected`. */
function deliverFromBase(
  repo: string,
  base: string,
  runDir: string,
  expected: Record<string, string>,
) {
  const delivered = ownedDir("cx-raw-delivered-");
  execFileSync("git", ["clone", "-q", "--no-checkout", repo, delivered], { stdio: "pipe" });
  git(delivered, "checkout", "-q", base);
  git(delivered, "apply", "--whitespace=nowarn", join(runDir, "final", "patch.diff"));
  for (const [path, content] of Object.entries(expected))
    expect(readFileSync(join(delivered, path), "utf8"), path).toBe(content);
}

describe("every raw round starts from the exact candidate; delivery keeps its base (#551)", () => {
  it("a second round edits what the first created, and the patch from the base holds both", async () => {
    const repo = committed({ "a.txt": "one\n" });
    const base = git(repo, "rev-parse", "HEAD");
    provider.answers = [
      { patch: edit("a.txt", "one", "two") + create("new.txt", "round one"), cost: 0.1 },
      { patch: edit("new.txt", "round one", "round two"), cost: 0.2 },
    ];
    const result = await rounds(openrouter(), repo, 2, { tests: [gateOn("new.txt", "round two")] });
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(provider.posts).toHaveLength(2);

    const [first, second] = [sentPacket(provider.posts[0]), sentPacket(provider.posts[1])];
    // The run's delivery base never moves; the round's tree does.
    expect(first.base_commit_sha).toBe(base);
    expect(second.base_commit_sha).toBe(base);
    expect(first.base_tree_sha).toBe(git(repo, "rev-parse", `${base}^{tree}`));
    expect(second.base_tree_sha).not.toBe(first.base_tree_sha);
    // Round two reads round one's result, and each identity names those bytes.
    const contentOf = (path: string) =>
      second.readable_files.find((file) => file.path === path)?.content;
    expect(contentOf("a.txt")).toBe("two\n");
    expect(contentOf("new.txt")).toBe("round one\n");
    for (const packet of [first, second])
      for (const file of packet.readable_files)
        expect(file.blob_oid, file.path).toBe(blobOidOf(repo, file.content));

    // The user's tree stays untouched until delivery.
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
    expect(existsSync(join(repo, "new.txt"))).toBe(false);
    deliverFromBase(repo, base, result.runDir, { "a.txt": "two\n", "new.txt": "round two\n" });
    // Every paid round is in the run's spend.
    expect(result.spendUsd).toBeCloseTo(0.3);
  });

  it("deletion and rename in one round are what the next round sees", async () => {
    const repo = committed({ "gone.txt": "bye\n", "old.txt": "keep\n" });
    const base = git(repo, "rev-parse", "HEAD");
    provider.answers = [
      {
        patch:
          "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n" +
          "diff --git a/old.txt b/moved.txt\nsimilarity index 100%\nrename from old.txt\nrename to moved.txt\n",
      },
      { patch: edit("moved.txt", "keep", "kept") },
    ];
    const result = await rounds(openrouter(), repo, 2, { tests: [gateOn("moved.txt", "kept")] });
    expect(result.lifecycle, result.summary).toBe("succeeded");
    const second = sentPacket(provider.posts[1]);
    const manifest = second.file_manifest.map((entry) => entry.path);
    expect(manifest).toContain("moved.txt");
    expect(manifest).not.toContain("gone.txt");
    expect(manifest).not.toContain("old.txt");
    deliverFromBase(repo, base, result.runDir, { "moved.txt": "kept\n" });
    expect(existsSync(join(repo, "gone.txt"))).toBe(true);
  });

  it("the engine's generated CLAUDE.md does not stop the first round on a project with AGENTS.md", async () => {
    const repo = committed({ "AGENTS.md": "# agents\n" });
    const base = git(repo, "rev-parse", "HEAD");
    provider.answers = [{ patch: edit("README.md", "# repo", "# raw") }];
    const result = await rounds(openrouter(), repo, 1);
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(provider.posts).toHaveLength(1);
    const patch = readFileSync(join(result.runDir, "final", "patch.diff"), "utf8");
    expect(patch).toContain("README.md");
    expect(patch).not.toContain("CLAUDE.md"); // the bridge never enters the result
    deliverFromBase(repo, base, result.runDir, { "README.md": "# raw\n" });
  });

  it("a dirty source keeps its snapshot base and stays untouched across rounds", async () => {
    const repo = committed({ "a.txt": "one\n" });
    writeFileSync(join(repo, "a.txt"), "dirty\n");
    writeFileSync(join(repo, "local.txt"), "mine\n");
    provider.answers = [
      { patch: edit("a.txt", "dirty", "two") },
      { patch: edit("local.txt", "mine", "ours") },
    ];
    const result = await rounds(openrouter(), repo, 2, { tests: [gateOn("local.txt", "ours")] });
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("dirty\n");
    expect(readFileSync(join(repo, "local.txt"), "utf8")).toBe("mine\n");
    const [first, second] = [sentPacket(provider.posts[0]), sentPacket(provider.posts[1])];
    expect(second.base_commit_sha).toBe(first.base_commit_sha);
    expect(first.base_commit_sha).not.toBe(git(repo, "rev-parse", "HEAD"));
  });

  it("a native round then a raw round: the raw packet reads the native work and the result holds both", async () => {
    const repo = committed({ "a.txt": "one\n" });
    const base = git(repo, "rev-parse", "HEAD");
    const native: HarnessRunSpec[] = [];
    // A new diff each round: the same one twice is `stuck_no_progress`, not a stall.
    const reader = nativeReader("native", "anthropic", native, (spec) => {
      writeFileSync(join(spec.cwd, "native.txt"), `from native ${native.length}\n`);
    });
    const raw = openrouter();
    provider.answers = [{ patch: edit("native.txt", "from native 2", "from raw") }];
    const result = await new Orchestrator({
      registry: new Map<string, HarnessAdapter>([
        ["native", reader],
        ["openrouter", raw],
      ]),
      reviewers: [],
    }).run({
      repoRoot: repo,
      prompt: "Build the feature",
      mode: "agent",
      harnesses: ["native", "openrouter"],
      models: { openrouter: "vendor/big" },
      attempts: 3,
      review: false,
      tests: [gateOn("native.txt", "from raw")],
    });
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(native).toHaveLength(2);
    expect(provider.posts).toHaveLength(1);
    const packet = sentPacket(provider.posts[0]);
    expect(packet.base_commit_sha).toBe(base);
    expect(packet.readable_files.find((file) => file.path === "native.txt")?.content).toBe(
      "from native 2\n",
    );
    deliverFromBase(repo, base, result.runDir, { "native.txt": "from raw\n" });
  });

  it("a file Git converts on checkout: rounds read and patch its stored form, and delivery keeps Git's conversion", async () => {
    const repo = committed({ ".gitattributes": "*.txt text eol=crlf\n", "a.txt": "one\r\n" });
    const base = git(repo, "rev-parse", "HEAD");
    provider.answers = [
      { patch: edit("a.txt", "one", "two") },
      { patch: edit("a.txt", "two", "three") },
    ];
    const result = await rounds(openrouter(), repo, 2, { tests: [gateOn("a.txt", "three")] });
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(provider.posts).toHaveLength(2);
    const [first, second] = [sentPacket(provider.posts[0]), sentPacket(provider.posts[1])];
    const file = (packet: typeof first) =>
      packet.readable_files.find((candidate) => candidate.path === "a.txt")!;
    expect([file(first).content, file(second).content]).toEqual(["one\n", "two\n"]);
    for (const packet of [first, second])
      expect(file(packet).blob_oid).toBe(blobOidOf(repo, file(packet).content));
    // The result is stored form too, and Git converts it again where it is delivered.
    expect(readFileSync(join(result.runDir, "final", "patch.diff"), "utf8")).not.toContain("\r");
    deliverFromBase(repo, base, result.runDir, { "a.txt": "three\r\n" });
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\r\n");
  });
});

describe("best-of synthesis on a raw route is served by the same packet and apply chain (#551)", () => {
  /** A second raw instance on the same endpoint, so best-of has two distinct lanes. */
  const second = () =>
    createRawApiAdapter({
      id: "raw-b",
      providerFamily: "unknown",
      baseUrl: provider.baseUrl,
      keyEnv: KEY_ENV,
    });
  const isSynthesis = (post: { body: any }) =>
    String(post.body.messages.at(-1).content).includes("Read `.claudexor-synthesis-input.md`");

  it("two raw candidates, then a raw synthesis that reads both and applies to its own tree", async () => {
    const repo = committed({ "a.txt": "one\n", "b.txt": "uno\n" });
    const base = git(repo, "rev-parse", "HEAD");
    const reviews: HarnessRunSpec[] = [];
    // The candidates race; whichever asks first gets the first proposal.
    provider.answers = [
      { patch: edit("a.txt", "one", "two"), cost: 0.1 },
      { patch: edit("b.txt", "uno", "dos"), cost: 0.1 },
      { patch: edit("a.txt", "one", "two") + edit("b.txt", "uno", "dos"), cost: 0.2 },
    ];
    const result = await new Orchestrator({
      registry: new Map<string, HarnessAdapter>([
        ["openrouter", openrouter()],
        ["raw-b", second()],
        ["reader", nativeReader("reader", "anthropic", reviews)],
      ]),
      reviewerPanel: [{ harness: "reader" }],
    }).run({
      repoRoot: repo,
      prompt: "Make both changes",
      mode: "agent",
      harnesses: ["openrouter", "raw-b"],
      models: { openrouter: "vendor/big", "raw-b": "vendor/big" },
      n: 2,
      synthesis: "always",
      review: true,
    });
    expect(provider.posts).toHaveLength(3);
    const synthesis = provider.posts.filter(isSynthesis);
    expect(synthesis).toHaveLength(1);
    // The synthesizer reads what it was told to read: the candidate diffs, in its packet.
    const packet = sentPacket(synthesis[0]);
    expect(packet.base_commit_sha).toBe(base);
    const input = packet.readable_files.find(
      (file) => file.path === ".claudexor-synthesis-input.md",
    )?.content;
    expect(input).toContain("+two");
    expect(input).toContain("+dos");
    // Its patch applied to the tree it was sent, and the result holds both changes.
    const synthAttempt = attemptRecord(result.runDir, "synth");
    expect(synthAttempt).toContain("errored: false");
    const synthPatch = readFileSync(join(result.runDir, "attempts", "synth", "patch.diff"), "utf8");
    expect(synthPatch).toContain("+two");
    expect(synthPatch).toContain("+dos");
    expect(synthPatch).not.toContain("claudexor-synthesis-input");
    const everything = runEvents(result.runDir)
      .map((event) => JSON.stringify(event))
      .join("\n");
    expect(everything).not.toContain("process_crash");
    expect(everything).not.toContain("raw_patch_");
    expect(reviews.map((spec) => spec.intent)).toContain("review");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
  });
});

describe("what a gate leaves between rounds (#551)", () => {
  it("an ignored file a gate writes is outside the candidate tree and stops no round", async () => {
    const repo = committed({ ".gitignore": "*.log\n" });
    const base = git(repo, "rev-parse", "HEAD");
    provider.answers = [
      { patch: edit("README.md", "# repo", "# draft") },
      { patch: edit("README.md", "# draft", "# final") },
    ];
    const gate = {
      program: process.execPath,
      envAllowlist: [],
      args: [
        "-e",
        'const fs=require("fs");fs.writeFileSync("gate.log","ran\\n");process.exit(fs.readFileSync("README.md","utf8").includes("# final")?0:1)',
      ],
    };
    const result = await rounds(openrouter(), repo, 2, { tests: [gate] });
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(provider.posts).toHaveLength(2);
    const second = sentPacket(provider.posts[1]);
    expect(second.file_manifest.map((entry) => entry.path)).not.toContain("gate.log");
    deliverFromBase(repo, base, result.runDir, { "README.md": "# final\n" });
    expect(readFileSync(join(result.runDir, "final", "patch.diff"), "utf8")).not.toContain(
      "gate.log",
    );
  });
});

describe("a refused patch is the attempt's typed failure with its usage kept (#551)", () => {
  const noCrash = (runDir: string) => {
    const recorded = `${attemptRecord(runDir)}${readFileSync(join(runDir, "final", "failure.yaml"), "utf8")}`;
    expect(recorded).not.toContain("process_crash");
    expect(recorded).not.toContain("crashed");
    const types = runEvents(runDir).map((event) => event.type);
    expect(types).not.toContain("route.transient.retry_scheduled");
  };

  it.each([
    [
      "one agent attempt",
      (repo: string) => rounds(openrouter(), repo, 1, { attempts: undefined, n: 1 }),
    ],
    ["the convergence loop", (repo: string) => rounds(openrouter(), repo, 1)],
  ])("%s: a patch that does not apply is raw_patch_apply_failed, paid once", async (_l, run) => {
    const repo = committed();
    provider.answers = [{ patch: edit("README.md", "not the content", "x"), cost: 0.25 }];
    const result = await run(repo);
    expect(provider.posts).toHaveLength(1);
    expect(result.lifecycle).toBe("failed");
    const failure = failureRecord(result.runDir);
    expect(failure.code).toBe("raw_patch_apply_failed");
    expect(failure.category).toBe("harness_error");
    noCrash(result.runDir);
    expect(result.spendUsd).toBeCloseTo(0.25);
    expect(attemptRecord(result.runDir)).toContain("cost_usd: 0.25");
    const attempt = telemetryRecord(result.runDir).attempts.find((a) => a.attempt_id === "a01");
    expect(attempt?.requested_model).toBe("vendor/big");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("# repo\n");
  });

  it("the next round hears the refusal through the ordinary revise prompt, and may correct it", async () => {
    const repo = committed();
    const base = git(repo, "rev-parse", "HEAD");
    provider.answers = [
      { patch: edit("README.md", "not the content", "x"), cost: 0.25 },
      { patch: edit("README.md", "# repo", "# fixed"), cost: 0.25 },
    ];
    const result = await rounds(openrouter(), repo, 2);
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(provider.posts).toHaveLength(2);
    const secondPrompt = provider.posts[1]!.body.messages.at(-1).content as string;
    expect(secondPrompt).toContain("raw_patch_apply_failed");
    expect(secondPrompt).toContain("Runtime errors from the previous attempt");
    expect(result.spendUsd).toBeCloseTo(0.5);
    deliverFromBase(repo, base, result.runDir, { "README.md": "# fixed\n" });
  });

  it("an answer that is no patch is the attempt's typed refusal, and repeats nothing by itself", async () => {
    const repo = committed();
    provider.answers = [{ text: "I would rather explain it", cost: 0.25 }];
    const result = await rounds(openrouter(), repo, 1);
    expect(provider.posts).toHaveLength(1);
    expect(failureRecord(result.runDir).code).toBe("raw_patch_truncated");
    noCrash(result.runDir);
    expect(result.spendUsd).toBeCloseTo(0.25);
  });

  it("a patch touching a path outside the packet refuses as out of scope", async () => {
    const repo = committed(
      { "secret/held.txt": "held\n" },
      "version: 1\ncontext:\n  exclude: ['secret/**']\n",
    );
    provider.answers = [{ patch: edit("secret/held.txt", "held", "changed"), cost: 0.25 }];
    const result = await rounds(openrouter(), repo, 1);
    expect(provider.posts).toHaveLength(1);
    const failure = failureRecord(result.runDir);
    expect(failure.code).toBe("raw_patch_outside_scope");
    expect(failure.category).toBe("harness_error");
    noCrash(result.runDir);
    expect(result.spendUsd).toBeCloseTo(0.25);
  });

  /** The real adapter, its stream intercepted at the seam a fault would hit. */
  const intercepted = (onPatch: (event: any, spec: HarnessRunSpec) => void): HarnessAdapter => {
    const adapter = openrouter();
    const run = adapter.run.bind(adapter);
    adapter.run = async function* (spec) {
      for await (const event of run(spec)) {
        if (event.type === "patch_produced") onPatch(event, spec);
        yield event;
      }
    };
    return adapter;
  };

  it("a worktree that changed after its packet was sent ends the run typed; no round follows", async () => {
    const repo = committed();
    provider.answers = [{ patch: edit("README.md", "# repo", "# raw"), cost: 0.25 }];
    const adapter = intercepted((_event, spec) => {
      writeFileSync(join(spec.cwd, "stray.txt"), "appeared after the packet\n");
    });
    const result = await rounds(adapter, repo, 3);
    expect(provider.posts).toHaveLength(1);
    const failure = failureRecord(result.runDir);
    expect(failure.code).toBe("raw_patch_base_mismatch");
    expect(failure.category).toBe("internal");
    noCrash(result.runDir);
    expect(result.spendUsd).toBeCloseTo(0.25);
  });

  it("a patch whose digest does not match its bytes ends the run typed; no round follows", async () => {
    const repo = committed();
    provider.answers = [{ patch: edit("README.md", "# repo", "# raw"), cost: 0.25 }];
    const adapter = intercepted((event) => {
      event.patch_envelope.patch_hash = `sha256:${"0".repeat(64)}`;
    });
    const result = await rounds(adapter, repo, 3);
    expect(provider.posts).toHaveLength(1);
    expect(failureRecord(result.runDir).code).toBe("raw_patch_digest_mismatch");
    noCrash(result.runDir);
    expect(result.spendUsd).toBeCloseTo(0.25);
  });

  it("a patch bound to another tree than its packet ends the run typed", async () => {
    const repo = committed();
    provider.answers = [{ patch: edit("README.md", "# repo", "# raw") }];
    const adapter = intercepted((event) => {
      event.patch_envelope.base_tree_sha = "0".repeat(40);
    });
    const result = await rounds(adapter, repo, 3);
    expect(provider.posts).toHaveLength(1);
    expect(failureRecord(result.runDir).code).toBe("raw_patch_base_mismatch");
    noCrash(result.runDir);
  });

  describe("after an accepted round, the refusal stays named and that round's work stays kept", () => {
    /** The real control projection of this run's real artifacts, as every surface reads it. */
    const projected = (result: { runId: string; taskId: string; runDir: string }) => {
      const record: DaemonRunRecord = {
        id: "job-raw",
        runId: result.runId,
        taskId: result.taskId,
        state: "failed",
        runDir: result.runDir,
        params: { mode: "agent", prompt: "Build the feature" },
      };
      return { summary: ControlRunSummary.parse(summarizeRun(record)), detail: detailFor(record) };
    };
    /** What stays is the first round's change, from the run's base, on an untouched source. */
    const keepsTheAcceptedRound = (
      repo: string,
      base: string,
      result: { runId: string; taskId: string; runDir: string },
    ) => {
      const { summary, detail } = projected(result);
      expect(summary.result.kind).toBe("patch");
      expect(summary.result.applyState).toBe("not_applied");
      expect(summary.result.adopted).toBeNull();
      expect(summary.result.revertable).toBe(false);
      expect(detail.primaryOutput?.kind).toBe("diagnostic");
      expect(detail.applyEligibility?.eligible).toBe(false);
      for (const attemptId of ["a01", "a02"])
        expect(existsSync(join(result.runDir, "attempts", attemptId, "patch.diff"))).toBe(true);
      const patch = readFileSync(join(result.runDir, "final", "patch.diff"), "utf8");
      expect(patch).toContain("+# draft");
      expect(patch).not.toContain("# final");
      deliverFromBase(repo, base, result.runDir, { "README.md": "# draft\n" });
      expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("# repo\n");
      noCrash(result.runDir);
      return summary;
    };
    const FIRST = { patch: edit("README.md", "# repo", "# draft"), cost: 0.1 };
    /** The gate still fails after the first round, so a second one is asked for. */
    const needsSecondRound = { tests: [gateOn("README.md", "# final")] };

    /** The real adapter, faulting only the second round's answer. */
    const faultingSecondRound = (fault: (event: any, spec: HarnessRunSpec) => void) => {
      let round = 0;
      const adapter = intercepted((event, spec) => {
        if (round === 2) fault(event, spec);
      });
      const run = adapter.run.bind(adapter);
      adapter.run = (spec) => {
        round += 1;
        return run(spec);
      };
      return adapter;
    };

    it.each([
      [
        "raw_patch_digest_mismatch",
        (event: any) => {
          event.patch_envelope.patch_hash = `sha256:${"0".repeat(64)}`;
        },
      ],
      [
        "raw_patch_base_mismatch",
        (_event: any, spec: HarnessRunSpec) => {
          writeFileSync(join(spec.cwd, "stray.txt"), "appeared after the packet\n");
        },
      ],
    ])("%s on round two ends the run with rounds left", async (code, fault) => {
      const repo = committed();
      const base = git(repo, "rev-parse", "HEAD");
      provider.answers = [FIRST, { patch: edit("README.md", "# draft", "# final"), cost: 0.2 }];
      const result = await rounds(faultingSecondRound(fault), repo, 3, needsSecondRound);
      expect(provider.posts).toHaveLength(2);
      expect(result.lifecycle).toBe("failed");
      expect(result.spendUsd).toBeCloseTo(0.3);
      const summary = keepsTheAcceptedRound(repo, base, result);
      expect(summary.state).toBe("failed");
      expect(summary.failure?.code).toBe(code);
      expect(summary.failure?.category).toBe("internal");
      expect(summary.failure?.attemptId).toBe("a02");
      expect(summary.failure?.safeMessage).toContain(code);
      expect(summary.outcomeFacts?.lifecycle).toBe("failed");
      expect(summary.outcomeFacts?.checks).toBe("failed");
      expect(summary.outcomeFacts?.reason).toBe("not_converged");
    });

    it.each([
      ["raw_patch_apply_failed", { patch: edit("README.md", "not the content", "x"), cost: 0.2 }],
      ["raw_patch_truncated", { text: "I would rather explain it", cost: 0.2 }],
    ])("%s on the last allowed round keeps the same state", async (code, answer) => {
      const repo = committed();
      const base = git(repo, "rev-parse", "HEAD");
      provider.answers = [FIRST, answer];
      const result = await rounds(openrouter(), repo, 2, needsSecondRound);
      expect(provider.posts).toHaveLength(2);
      expect(result.lifecycle).toBe("failed");
      expect(result.spendUsd).toBeCloseTo(0.3);
      const summary = keepsTheAcceptedRound(repo, base, result);
      expect(summary.state).toBe("failed");
      expect(summary.failure?.code).toBe(code);
      expect(summary.failure?.category).toBe("harness_error");
      expect(summary.failure?.attemptId).toBe("a02");
      expect(summary.outcomeFacts?.lifecycle).toBe("failed");
      expect(summary.outcomeFacts?.checks).toBe("failed");
      // The run ended on its attempts: a refused patch repeated no result.
      expect(summary.outcomeFacts?.reason).toBe("not_converged");
    });

    describe("only accepted results count toward no progress (INV-047)", () => {
      const UNAPPLICABLE = { patch: edit("README.md", "not the content", "x"), cost: 0.2 };
      const NOT_A_PATCH = { text: "I would rather explain it", cost: 0.2 };
      const FINAL = (cost: number) => ({ patch: edit("README.md", "# draft", "# final"), cost });
      /** The accepted change re-emitted against the tree that holds it: it applies, and
       * the result stays what it was. */
      const SAME_AGAIN = (cost: number) => ({
        patch: edit("README.md", "# draft", "# draft"),
        cost,
      });
      const promptOf = (post: { body: any } | undefined) =>
        post!.body.messages.at(-1).content as string;

      it.each([
        ["raw_patch_apply_failed", UNAPPLICABLE, "error: README.md: patch does not apply"],
        ["raw_patch_truncated", NOT_A_PATCH, "was not a complete Git patch proposal JSON object"],
      ])(
        "%s after an accepted round: the next ordinary round corrects it",
        async (_code, refused, error) => {
          const repo = committed();
          const base = git(repo, "rev-parse", "HEAD");
          provider.answers = [FIRST, refused, FINAL(0.3)];
          const result = await rounds(openrouter(), repo, 3, needsSecondRound);
          expect(result.lifecycle, result.summary).toBe("succeeded");
          // Three paid requests, all in the run's spend, the refused one on its own attempt.
          expect(provider.posts).toHaveLength(3);
          expect(result.spendUsd).toBeCloseTo(0.6);
          const refusedAttempt = attemptRecord(result.runDir, "a02");
          expect(refusedAttempt).toContain("cost_usd: 0.2");
          expect(refusedAttempt).toContain("errored: true");
          // The third request hears that refusal's own error through the revise prompt...
          const third = promptOf(provider.posts[2]);
          expect(third).toContain("Runtime errors from the previous attempt");
          expect(third).toContain(error);
          expect(promptOf(provider.posts[1])).not.toContain("Runtime errors");
          // ...and reads the accepted round's tree, which the refused round left as it was.
          const [second, last] = [sentPacket(provider.posts[1]), sentPacket(provider.posts[2])];
          expect(last.base_commit_sha).toBe(base);
          expect(last.base_tree_sha).toBe(second.base_tree_sha);
          const readme = last.readable_files.find((file) => file.path === "README.md");
          expect(readme?.content).toBe("# draft\n");
          deliverFromBase(repo, base, result.runDir, { "README.md": "# final\n" });
          expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("# repo\n");
        },
      );

      it("a refused round spends one of the --attempts like any other round", async () => {
        const repo = committed();
        const base = git(repo, "rev-parse", "HEAD");
        provider.answers = [FIRST, UNAPPLICABLE, { ...NOT_A_PATCH, cost: 0.3 }, FINAL(0.4)];
        const result = await rounds(openrouter(), repo, 3, needsSecondRound);
        // The fourth answer is ready, and never asked for.
        expect(provider.posts).toHaveLength(3);
        expect(result.lifecycle).toBe("failed");
        expect(result.spendUsd).toBeCloseTo(0.6);
        const summary = keepsTheAcceptedRound(repo, base, result);
        expect(summary.failure?.code).toBe("raw_patch_truncated");
        expect(summary.failure?.attemptId).toBe("a03");
        expect(summary.outcomeFacts?.reason).toBe("not_converged");
      });

      it("the same refusal twice stops on the existing repeated-failure rule, attempts left", async () => {
        const repo = committed();
        const base = git(repo, "rev-parse", "HEAD");
        provider.answers = [FIRST, UNAPPLICABLE, { ...UNAPPLICABLE, cost: 0.3 }, FINAL(0.4)];
        const result = await rounds(openrouter(), repo, 4, needsSecondRound);
        expect(provider.posts).toHaveLength(3);
        expect(result.lifecycle).toBe("failed");
        expect(result.spendUsd).toBeCloseTo(0.6);
        const summary = keepsTheAcceptedRound(repo, base, result);
        expect(summary.failure?.code).toBe("raw_patch_apply_failed");
        expect(summary.failure?.attemptId).toBe("a03");
        expect(summary.outcomeFacts?.reason).toBe("not_converged");
      });

      it("the same accepted result twice against the failing gate is stuck_no_progress", async () => {
        const repo = committed();
        const base = git(repo, "rev-parse", "HEAD");
        provider.answers = [FIRST, SAME_AGAIN(0.2), FINAL(0.3)];
        const result = await rounds(openrouter(), repo, 3, needsSecondRound);
        expect(provider.posts).toHaveLength(2);
        expect(result.lifecycle).toBe("failed");
        expect(result.facts.reason).toBe("stuck_no_progress");
        expect(result.spendUsd).toBeCloseTo(0.3);
        const summary = keepsTheAcceptedRound(repo, base, result);
        expect(summary.outcomeFacts?.reason).toBe("stuck_no_progress");
        expect(summary.failure?.safeMessage).toContain("same candidate result");
      });

      it("a refused round between two identical accepted results resets none of their history", async () => {
        const repo = committed();
        const base = git(repo, "rev-parse", "HEAD");
        provider.answers = [FIRST, UNAPPLICABLE, SAME_AGAIN(0.3), FINAL(0.4)];
        const result = await rounds(openrouter(), repo, 4, needsSecondRound);
        expect(provider.posts).toHaveLength(3);
        expect(result.lifecycle).toBe("failed");
        expect(result.facts.reason).toBe("stuck_no_progress");
        expect(result.spendUsd).toBeCloseTo(0.6);
        const summary = keepsTheAcceptedRound(repo, base, result);
        expect(summary.outcomeFacts?.reason).toBe("stuck_no_progress");
        expect(summary.failure?.attemptId).toBe("a03");
        expect(summary.failure?.safeMessage).toContain("same candidate result");
      });
    });
  });

  it("in-place convergence stays refused for a patch producer", async () => {
    const repo = committed();
    mkdirSync(join(repo, ".scratch"));
    const result = await rounds(openrouter(), repo, 2, { inPlace: true });
    expect(provider.posts).toEqual([]);
    expect(result.lifecycle).toBe("failed");
    expect(result.summary).toContain("in-place convergence is unavailable");
  });
});
