import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
import { createFakeHarness } from "@claudexor/harness-fake";
import {
  ConformanceReport,
  HarnessManifest,
  RunFacts,
  WorkProduct,
  WorkspaceFilesManifest,
} from "@claudexor/schema";
import { type ReviewerSpec } from "@claudexor/review";
import { verifyAndDeliverFiles } from "@claudexor/delivery";
import { Orchestrator } from "./orchestrator.js";
import { OrchestratorCredentials } from "./orchestrator-credentials.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "claudexor-directory-runtime-"));
  dirs.push(root);
  writeFileSync(join(root, "input.txt"), "selected source\r\n");
  writeFileSync(join(root, "outside.txt"), "unselected source");
  return root;
}
function writer(bytes: Buffer, fail = false) {
  const fake = createFakeHarness("fake-implement");
  const calls: string[] = [];
  const adapter: HarnessAdapter = {
    ...fake,
    id: "directory-author",
    async discover() {
      return HarnessManifest.parse({
        ...(await fake.discover()),
        id: "directory-author",
        kind: "local_cli",
        capabilities: { ...(await fake.discover()).capabilities, review: false, synthesize: false },
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: "directory-author",
        status: "ok",
        enabled_intents: ["implement", "repair"],
      });
    },
    async *run(spec) {
      calls.push(spec.cwd);
      const ts = new Date().toISOString();
      yield { type: "started", ts, session_id: spec.session_id };
      if (spec.access !== "readonly") {
        writeFileSync(join(spec.cwd, "output.bin"), bytes);
        yield {
          type: "file_change",
          ts,
          session_id: spec.session_id,
          payload: { path: "output.bin" },
        };
      }
      if (fail) yield { type: "error", ts, session_id: spec.session_id, error: "fixture failure" };
      else
        yield {
          type: "message",
          ts,
          session_id: spec.session_id,
          text: "Prepared the output.",
          final: true,
        };
      yield { type: "completed", ts, session_id: spec.session_id };
    },
  };
  return { adapter, calls };
}
function approvingReviewer(id: string, providerFamily: "openai" | "anthropic"): ReviewerSpec {
  return {
    providerFamily,
    requestedModel: `${id}-model`,
    adapter: {
      id,
      async discover() {
        return HarnessManifest.parse({
          id,
          display_name: id,
          kind: "local_cli",
          provider_family: providerFamily,
          access_profiles_supported: ["readonly"],
          capabilities: { review: true, known_models: [`${id}-model`] },
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
        const ts = new Date().toISOString();
        const route = { credential_route: "managed_api_key" as const };
        yield {
          type: "started",
          ts,
          session_id: spec.session_id,
          observed_model: `${id}-model`,
          ...route,
        };
        yield { type: "message", ts, session_id: spec.session_id, text: "```json\n[]\n```" };
        yield {
          type: "usage",
          ts,
          session_id: spec.session_id,
          ...route,
          usage: { cost_usd: 0.001 },
        };
        yield { type: "completed", ts, session_id: spec.session_id };
      },
    },
  };
}
function readResult(root: string, runDir: string) {
  const store = new ArtifactStore(root);
  const facts = RunFacts.parse(store.readYaml(join(runDir, "final/run_facts.yaml")));
  const product = WorkProduct.parse(store.readYaml(join(runDir, "final/work_product.yaml")));
  const text = readFileSync(join(runDir, product.files.manifest!), "utf8");
  const manifest = WorkspaceFilesManifest.parse(JSON.parse(text));
  expect(product.meta.manifest_sha256).toBe(
    `sha256:${createHash("sha256").update(text).digest("hex")}`,
  );
  return { facts, product, manifest };
}

describe("ordinary directory Agent execution", () => {
  it.each([
    { inPlace: true },
    { inPlace: false },
    { inPlace: true, attempts: 3 },
    { inPlace: false, attempts: 3 },
  ])(
    "produces full file output with inPlace=$inPlace, attempts=$attempts and review-off",
    async ({ inPlace, attempts }) => {
      const root = fixture();
      const bytes = Buffer.alloc(34 * 1024 * 1024, 0x01);
      const author = writer(bytes);
      const orchestrator = new Orchestrator({
        registry: new Map([[author.adapter.id, author.adapter]]),
      });
      const result = await orchestrator.run({
        repoRoot: root,
        prompt: "Create binary output",
        harnesses: [author.adapter.id],
        workspaceKind: "directory",
        scopePaths: ["input.txt"],
        inPlace,
        attempts,
        review: false,
      });
      expect(result.facts).toMatchObject({
        lifecycle: "succeeded",
        review_requested: false,
        review: "not_run",
        noChanges: inPlace ? null : false,
      });
      expect(author.calls).toHaveLength(1);
      expect(existsSync(join(root, ".git"))).toBe(false);
      expect(existsSync(join(result.runDir, "final/patch.diff"))).toBe(false);
      const { product, manifest, facts } = readResult(root, result.runDir);
      expect(facts.deliverable.kind).toBe("files");
      expect(product.meta.apply_state).toBe(inPlace ? "applied" : "not_applied");
      const output = manifest.entries.find((entry) => entry.path === "output.bin")!.after;
      if (output?.kind !== "file") throw new Error("expected file");
      expect(readFileSync(join(result.runDir, output.artifactPath!)).equals(bytes)).toBe(true);
      if (!inPlace) {
        expect(existsSync(author.calls[0]!)).toBe(false);
        expect(existsSync(join(root, "output.bin"))).toBe(false);
        expect(
          await verifyAndDeliverFiles(root, {
            manifest,
            manifestSha256: String(product.meta.manifest_sha256),
            artifactRoot: result.runDir,
          }),
        ).toMatchObject({ applied: true });
      }
      expect(readFileSync(join(root, "output.bin")).equals(bytes)).toBe(true);
      expect(readFileSync(join(root, "outside.txt"), "utf8")).toBe("unselected source");
    },
  );

  it("keeps project identity for the run while its files name the delegated execution tree", async () => {
    const root = fixture(),
      executionRoot = fixture();
    const author = writer(Buffer.from([0, 255]));
    const result = await new Orchestrator({
      registry: new Map([[author.adapter.id, author.adapter]]),
    }).run({
      repoRoot: root,
      executionRoot,
      workspaceKind: "directory",
      inPlace: true,
      delegated: true,
      prompt: "Write in this selected directory",
      harnesses: [author.adapter.id],
    });
    expect(result.facts.lifecycle).toBe("succeeded");
    const { manifest, product } = readResult(root, result.runDir);
    expect(
      new ArtifactStore(root).readYaml<{ repo: { root: string } }>(
        join(result.runDir, "context/task.yaml"),
      )?.repo.root,
    ).toBe(root);
    expect(manifest.sourceRoot).toBe(executionRoot);
    expect(manifest.executionRoot).toBe(executionRoot);
    expect(product.meta.source_root).toBe(executionRoot);
    expect(existsSync(join(root, "output.bin"))).toBe(false);
    expect(existsSync(join(executionRoot, "output.bin"))).toBe(true);
  });

  it("delivers a delegated directory best-of winner into the bound execution root", async () => {
    const root = fixture(),
      executionRoot = fixture();
    writeFileSync(join(executionRoot, "input.txt"), "caller workspace source\n");
    const author = writer(Buffer.from([0, 255, 7]));
    const result = await new Orchestrator({
      registry: new Map([[author.adapter.id, author.adapter]]),
      reviewers: [
        approvingReviewer("review-a", "openai"),
        approvingReviewer("review-b", "anthropic"),
      ],
    }).run({
      repoRoot: root,
      executionRoot,
      workspaceKind: "directory",
      scopePaths: ["input.txt"],
      inPlace: true,
      delegated: true,
      prompt: "Race to write in the selected directory",
      harnesses: [author.adapter.id],
      n: 2,
      review: true,
    });
    expect(result.facts).toMatchObject({ lifecycle: "succeeded", review: "approved" });
    expect(
      new ArtifactStore(root).readYaml(join(result.runDir, "final/delivery_receipt.yaml")),
    ).toMatchObject({ applied: true, appliedPaths: ["output.bin"] });
    expect(readFileSync(join(executionRoot, "output.bin"))).toEqual(Buffer.from([0, 255, 7]));
    expect(existsSync(join(root, "output.bin"))).toBe(false);
    expect(readFileSync(join(root, "input.txt"), "utf8")).toBe("selected source\r\n");
    expect(author.calls).toHaveLength(2);
    expect(author.calls).not.toContain(executionRoot);
    const { product, manifest } = readResult(root, result.runDir);
    expect(manifest).toMatchObject({ sourceRoot: executionRoot, isolation: "envelope" });
    const baseline = manifest.entries.find((entry) => entry.path === "input.txt")?.before;
    if (!baseline || baseline === "unknown" || baseline.kind !== "file")
      throw new Error("missing selected baseline");
    expect(readFileSync(join(result.runDir, baseline.artifactPath!), "utf8")).toBe(
      "caller workspace source\n",
    );
    expect(product.meta).toMatchObject({ source_root: executionRoot, apply_state: "applied" });
  });

  it("binds a copied delegated directory result to its execution root, never the project", async () => {
    const root = fixture(),
      executionRoot = fixture();
    const author = writer(Buffer.from([9, 0, 255]));
    const result = await new Orchestrator({
      registry: new Map([[author.adapter.id, author.adapter]]),
    }).run({
      repoRoot: root,
      executionRoot,
      workspaceKind: "directory",
      scopePaths: ["input.txt"],
      delegated: true,
      prompt: "Write in a copy of the selected directory",
      harnesses: [author.adapter.id],
      review: false,
    });
    expect(result.facts.lifecycle).toBe("succeeded");
    const { product, manifest } = readResult(root, result.runDir);
    expect(manifest.sourceRoot).toBe(executionRoot);
    const candidate = {
      manifest,
      manifestSha256: String(product.meta.manifest_sha256),
      artifactRoot: result.runDir,
    };
    expect(await verifyAndDeliverFiles(root, candidate)).toMatchObject({
      applied: false,
      treeMutated: false,
      detail: "target does not match the work product source",
    });
    expect(existsSync(join(root, "output.bin"))).toBe(false);
    expect(await verifyAndDeliverFiles(executionRoot, candidate)).toMatchObject({
      applied: true,
    });
    expect(readFileSync(join(executionRoot, "output.bin"))).toEqual(Buffer.from([9, 0, 255]));
  });

  it("does not initialize Git or capture files on readonly Agent", async () => {
    const root = fixture();
    const author = writer(Buffer.from([1]));
    const result = await new Orchestrator({
      registry: new Map([[author.adapter.id, author.adapter]]),
    }).run({
      repoRoot: root,
      workspaceKind: "directory",
      prompt: "Read the directory",
      scopePaths: ["."],
      harnesses: [author.adapter.id],
      access: "readonly",
    });
    expect(result.facts.lifecycle).toBe("succeeded");
    expect(readdirSync(root).sort()).toEqual(["input.txt", "outside.txt"]);
    expect(existsSync(join(result.runDir, "final/work_product.yaml"))).toBe(false);
    expect(existsSync(join(result.runDir, "attempts/a01/final/files/manifest.json"))).toBe(false);
    expect(readFileSync(join(result.runDir, "final/answer.md"), "utf8")).toContain(
      "Prepared the output.",
    );
    const attempt = new ArtifactStore(root).readYaml<Record<string, unknown>>(
      join(result.runDir, "attempts/a01/attempt.yaml"),
    );
    expect(attempt).not.toHaveProperty("capture_refusal");
  });

  it.skipIf(process.platform === "win32")(
    "answers from a readonly live directory containing a Unix socket",
    async () => {
      const root = fixture();
      const socket = createServer();
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(join(root, "s"), resolve);
      });
      try {
        const author = writer(Buffer.from([1]));
        const result = await new Orchestrator({
          registry: new Map([[author.adapter.id, author.adapter]]),
        }).run({
          repoRoot: root,
          workspaceKind: "directory",
          inPlace: true,
          scopePaths: ["."],
          access: "readonly",
          harnesses: [author.adapter.id],
          prompt: "Read the directory without changing its files",
        });
        expect(result.facts.lifecycle).toBe("succeeded");
        expect(author.calls).toEqual([root]);
        expect(readFileSync(join(result.runDir, "final/answer.md"), "utf8")).toContain(
          "Prepared the output.",
        );
        expect(existsSync(join(result.runDir, "final/work_product.yaml"))).toBe(false);
        expect(existsSync(join(result.runDir, "attempts/a01/final/files/manifest.json"))).toBe(
          false,
        );
      } finally {
        await new Promise<void>((resolve, reject) =>
          socket.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it.each([false, true])(
    "preserves readonly dispatch and HOME selection, delegated=%s",
    async (delegated) => {
      const root = fixture(),
        executionRoot = delegated ? fixture() : root;
      const author = writer(Buffer.from([1]));
      const seen: Array<{ cwd: string; access: string; home?: string; homeExists: boolean }> = [];
      const run = author.adapter.run;
      author.adapter.run = async function* (spec) {
        seen.push({
          cwd: spec.cwd,
          access: spec.access,
          home: spec.env?.HOME,
          homeExists: Boolean(spec.env?.HOME && existsSync(spec.env.HOME)),
        });
        yield* run.call(author.adapter, spec);
      };
      const result = await new Orchestrator({
        registry: new Map([[author.adapter.id, author.adapter]]),
      }).run({
        repoRoot: root,
        executionRoot,
        delegated,
        workspaceKind: "directory",
        inPlace: true,
        scopePaths: ["input.txt"],
        access: "readonly",
        harnesses: [author.adapter.id],
        prompt: "Read the selected folder",
      });
      expect(result.facts.lifecycle).toBe("succeeded");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ cwd: executionRoot, access: "readonly" });
      if (delegated) {
        expect(seen[0]!.homeExists).toBe(true);
        expect(seen[0]!.home).not.toBe(process.env.HOME);
        expect(seen[0]!.home).not.toBe(executionRoot);
      } else expect(seen[0]!.home).toBeUndefined();
      expect(existsSync(join(result.runDir, "final/work_product.yaml"))).toBe(false);
      expect(readdirSync(executionRoot).sort()).toEqual(["input.txt", "outside.txt"]);
    },
  );

  it.each([["."], ["input.txt"]])(
    "does not mark an empty readonly answer as delivered with scope %j",
    async (...scopePaths) => {
      const root = fixture();
      const author = writer(Buffer.from([1]));
      author.adapter.run = async function* (spec) {
        const ts = new Date().toISOString();
        yield { type: "started", ts, session_id: spec.session_id };
        yield { type: "completed", ts, session_id: spec.session_id };
      };
      const served = vi.spyOn(OrchestratorCredentials.prototype, "noteTryServed");
      try {
        const result = await new Orchestrator({
          registry: new Map([[author.adapter.id, author.adapter]]),
        }).run({
          repoRoot: root,
          workspaceKind: "directory",
          scopePaths,
          access: "readonly",
          harnesses: [author.adapter.id],
          prompt: "Read only",
        });
        expect(served.mock.calls.map(([, , delivered]) => delivered)).toEqual([false]);
        const facts = RunFacts.parse(
          new ArtifactStore(root).readYaml(join(result.runDir, "final/run_facts.yaml")),
        );
        expect(facts.deliverable.present).toBe(false);
        expect(existsSync(join(result.runDir, "final/work_product.yaml"))).toBe(false);
      } finally {
        served.mockRestore();
      }
    },
  );

  it.each([true, false])(
    "retains credential-shaped directory output exactly (direct=%s, INV-146)",
    async (inPlace) => {
      const root = fixture();
      const secret = `ghp_${"Q".repeat(25)}`;
      const bytes = Buffer.concat([Buffer.alloc(70000, 0), Buffer.from(secret)]);
      const author = writer(bytes);
      const result = await new Orchestrator({
        registry: new Map([[author.adapter.id, author.adapter]]),
      }).run({
        repoRoot: root,
        workspaceKind: "directory",
        prompt: "Write output",
        harnesses: [author.adapter.id],
        inPlace,
      });
      expect(result.facts.lifecycle).toBe("succeeded");
      expect(author.calls).toHaveLength(1);
      expect(existsSync(join(result.runDir, "final/work_product.yaml"))).toBe(true);
      const manifest = readFileSync(join(result.runDir, "final/files/manifest.json"), "utf8");
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      expect(manifest).toContain(digest);
      expect(existsSync(join(root, "output.bin"))).toBe(inPlace);
    },
  );

  it.each([{}, { attempts: 3 }, { untilClean: true }])(
    "requested review sees the full selected candidate and binary outputs with strategy %j",
    async (strategy) => {
      const root = fixture();
      const author = writer(Buffer.from([0, 255, 2]));
      const originalRun = author.adapter.run;
      author.adapter.run = async function* (spec) {
        for await (const event of originalRun(spec)) {
          if (event.type === "completed") {
            mkdirSync(join(spec.cwd, "dist"));
            writeFileSync(join(spec.cwd, "dist/generated.bin"), Buffer.from([7, 0, 255]));
            yield {
              type: "file_change",
              ts: event.ts,
              session_id: spec.session_id,
              payload: { path: "dist/generated.bin" },
            };
          }
          yield event;
        }
      };
      const reviewed: string[] = [];
      const reviewer = (id: string, providerFamily: "openai" | "anthropic"): ReviewerSpec => ({
        providerFamily,
        requestedModel: `${id}-model`,
        adapter: {
          id,
          async discover() {
            return HarnessManifest.parse({
              id,
              display_name: id,
              kind: "local_cli",
              provider_family: providerFamily,
              access_profiles_supported: ["readonly"],
              capabilities: { review: true, known_models: [`${id}-model`] },
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
            const ts = new Date().toISOString();
            reviewed.push(id);
            expect(readFileSync(join(spec.cwd, "input.txt"), "utf8")).toBe("selected source\r\n");
            expect(readFileSync(join(spec.cwd, "output.bin"))).toEqual(Buffer.from([0, 255, 2]));
            expect(readFileSync(join(spec.cwd, "dist/generated.bin"))).toEqual(
              Buffer.from([7, 0, 255]),
            );
            expect(existsSync(join(spec.cwd, "outside.txt"))).toBe(false);
            expect(spec.prompt).toContain("FILES.json");
            const evidenceRoot = join(spec.cwd, ".claudexor-review-evidence");
            const fullManifest = WorkspaceFilesManifest.parse(
              JSON.parse(readFileSync(join(evidenceRoot, "FILES.json"), "utf8")),
            );
            const baseline = fullManifest.entries.find(
              (entry) => entry.path === "input.txt",
            )?.before;
            if (!baseline || baseline === "unknown" || baseline.kind !== "file")
              throw new Error("missing selected baseline");
            expect(readFileSync(join(evidenceRoot, baseline.artifactPath!), "utf8")).toBe(
              "selected source\r\n",
            );
            yield {
              type: "started",
              ts,
              session_id: spec.session_id,
              observed_model: `${id}-model`,
              credential_route: "managed_api_key",
            };
            yield { type: "message", ts, session_id: spec.session_id, text: "```json\n[]\n```" };
            yield {
              type: "usage",
              ts,
              session_id: spec.session_id,
              credential_route: "managed_api_key",
              usage: { cost_usd: 0.001 },
            };
            yield { type: "completed", ts, session_id: spec.session_id };
          },
        },
      });
      const reviewers = [reviewer("review-a", "openai"), reviewer("review-b", "anthropic")];
      const result = await new Orchestrator({
        registry: new Map([[author.adapter.id, author.adapter]]),
        reviewers,
      }).run({
        repoRoot: root,
        workspaceKind: "directory",
        scopePaths: ["input.txt"],
        prompt: "Write and review binary output",
        harnesses: [author.adapter.id],
        review: true,
        ...strategy,
      });
      expect(result.facts).toMatchObject({
        lifecycle: "succeeded",
        review: "approved",
        noChanges: false,
      });
      expect(reviewed.sort()).toEqual(["review-a", "review-b"]);
      expect(existsSync(join(root, ".git"))).toBe(false);
    },
  );

  it.each([undefined, 3])(
    "keeps direct changes unknown with attempts=%s and no footprint",
    async (attempts) => {
      const root = fixture();
      const author = writer(Buffer.from([1]));
      author.adapter.run = async function* (spec) {
        const ts = new Date().toISOString();
        yield { type: "started", ts, session_id: spec.session_id };
        yield {
          type: "message",
          ts,
          session_id: spec.session_id,
          text: "The external action is complete.",
          final: true,
        };
        yield { type: "completed", ts, session_id: spec.session_id };
      };
      const result = await new Orchestrator({
        registry: new Map([[author.adapter.id, author.adapter]]),
      }).run({
        repoRoot: root,
        workspaceKind: "directory",
        inPlace: true,
        prompt: "Do the task",
        attempts,
        review: false,
        harnesses: [author.adapter.id],
      });
      expect(result.facts).toMatchObject({ lifecycle: "succeeded", noChanges: null });
      expect(readResult(root, result.runDir).facts.outcome.noChanges).toBeNull();
      expect(existsSync(join(root, ".git"))).toBe(false);
    },
  );

  it("retains failed partial file work and continues it on the same account, never from scratch", async () => {
    const root = fixture();
    const author = writer(Buffer.from([0, 255]), true);
    const result = await new Orchestrator({
      registry: new Map([[author.adapter.id, author.adapter]]),
    }).run({
      repoRoot: root,
      workspaceKind: "directory",
      inPlace: true,
      prompt: "Create output",
      harnesses: [author.adapter.id],
    });
    // After progress the same account continues the work (packet, owner 1B),
    // bounded by transient_retry.max_retries; the partial file is kept.
    expect(author.calls).toHaveLength(3);
    expect(result.facts.lifecycle).toBe("failed");
    expect(readResult(root, result.runDir).product.meta.apply_state).toBe("applied");
    expect(readFileSync(join(root, "output.bin"))).toEqual(Buffer.from([0, 255]));
  }, 20_000);

  it("keeps path policy evidence for a copied binary work product", async () => {
    const root = fixture();
    const author = writer(Buffer.from([0, 255]));
    const result = await new Orchestrator({
      registry: new Map([[author.adapter.id, author.adapter]]),
    }).run({
      repoRoot: root,
      workspaceKind: "directory",
      scopePaths: ["input.txt"],
      denyPaths: ["output.bin"],
      prompt: "Write output",
      harnesses: [author.adapter.id],
    });
    expect(result.facts.review).toBe("blocked");
    const store = new ArtifactStore(root);
    const reviews = store.readYaml<{
      findings: Array<{ evidence: { files: Array<{ path: string }> } }>;
    }>(join(result.runDir, "reviews/a01.yaml"));
    expect(
      reviews?.findings.some((finding) =>
        finding.evidence.files.some((file) => file.path === "output.bin"),
      ),
    ).toBe(true);
    expect(readResult(root, result.runDir).product.meta.apply_state).toBe("not_applied");
    expect(existsSync(join(root, "output.bin"))).toBe(false);
  });

  it("presents a file-only result as readable links while its canonical proof remains the manifest", async () => {
    const root = fixture();
    const author = writer(Buffer.from([0, 255]));
    const originalRun = author.adapter.run;
    author.adapter.run = async function* (spec) {
      for await (const event of originalRun(spec)) if (event.type !== "message") yield event;
    };
    const result = await new Orchestrator({
      registry: new Map([[author.adapter.id, author.adapter]]),
    }).run({
      repoRoot: root,
      workspaceKind: "directory",
      prompt: "Produce output",
      harnesses: [author.adapter.id],
    });
    expect(result.facts.lifecycle).toBe("succeeded");
    const { facts } = readResult(root, result.runDir);
    expect(facts.deliverable.path).toBe("final/files/manifest.json");
    expect(facts.presentation?.primary?.path).toBe("final/files/result.md");
    expect(readFileSync(join(result.runDir, "final/files/result.md"), "utf8")).toContain(
      "[output.bin]",
    );
  });

  it.each([undefined, 3])(
    "retains cancelled direct output without replay, attempts=%s",
    async (attempts) => {
      const root = fixture();
      const author = writer(Buffer.from([0, 255]));
      const signal = new AbortController();
      const originalRun = author.adapter.run;
      author.adapter.run = async function* (spec) {
        for await (const event of originalRun(spec)) {
          yield event;
          if (event.type === "file_change") {
            signal.abort();
            break;
          }
        }
      };
      const result = await new Orchestrator({
        registry: new Map([[author.adapter.id, author.adapter]]),
      }).run({
        repoRoot: root,
        workspaceKind: "directory",
        inPlace: true,
        scopePaths: ["output.bin"],
        signal: signal.signal,
        attempts,
        review: false,
        prompt: "Produce output",
        harnesses: [author.adapter.id],
      });
      expect(result.facts.lifecycle).toBe("cancelled");
      expect(author.calls).toHaveLength(1);
      expect(readResult(root, result.runDir).product.meta.apply_state).toBe("applied");
      expect(readFileSync(join(root, "output.bin"))).toEqual(Buffer.from([0, 255]));
    },
  );
  it.each([true, false])(
    "keeps earlier file output across repair attempts, direct=%s",
    async (inPlace) => {
      const root = fixture();
      const author = writer(Buffer.from([0, 255]));
      let round = 0;
      author.adapter.run = async function* (spec) {
        author.calls.push(spec.cwd);
        const ts = new Date().toISOString();
        yield { type: "started", ts, session_id: spec.session_id };
        round += 1;
        const path = round === 1 ? "first.bin" : "second.bin";
        writeFileSync(join(spec.cwd, path), Buffer.from([0, round, 255]));
        yield { type: "file_change", ts, session_id: spec.session_id, payload: { path } };
        yield {
          type: "message",
          ts,
          session_id: spec.session_id,
          text: "Prepared output.",
          final: true,
        };
        yield { type: "completed", ts, session_id: spec.session_id };
      };
      const result = await new Orchestrator({
        registry: new Map([[author.adapter.id, author.adapter]]),
      }).run({
        repoRoot: root,
        workspaceKind: "directory",
        scopePaths: ["input.txt"],
        inPlace,
        prompt: "Produce two binary outputs",
        harnesses: [author.adapter.id],
        attempts: 3,
        review: false,
        tests: [
          {
            program: process.execPath,
            args: ["-e", "process.exit(require('node:fs').existsSync('second.bin') ? 0 : 1)"],
            envAllowlist: [],
          },
        ],
      });
      expect(result.facts).toMatchObject({ lifecycle: "succeeded", checks: "passed" });
      expect(author.calls).toHaveLength(2);
      expect(new Set(author.calls).size).toBe(1);
      expect(existsSync(join(root, ".git"))).toBe(false);
      const { product, manifest } = readResult(root, result.runDir);
      for (const [path, number] of [
        ["first.bin", 1],
        ["second.bin", 2],
      ] as const) {
        const state = manifest.entries.find((entry) => entry.path === path)?.after;
        if (state?.kind !== "file") throw new Error("missing completed output");
        expect(readFileSync(join(result.runDir, state.artifactPath!))).toEqual(
          Buffer.from([0, number, 255]),
        );
      }
      if (!inPlace) {
        expect(existsSync(join(root, "first.bin"))).toBe(false);
        expect(
          await verifyAndDeliverFiles(root, {
            manifest,
            manifestSha256: String(product.meta.manifest_sha256),
            artifactRoot: result.runDir,
          }),
        ).toMatchObject({ applied: true });
      }
      expect(readFileSync(join(root, "first.bin"))).toEqual(Buffer.from([0, 1, 255]));
      expect(product.meta).not.toHaveProperty("revert_anchor_id");
    },
  );
  it("measures repair progress from changed binary content instead of the empty patch", async () => {
    const root = fixture();
    const author = writer(Buffer.from([0]));
    const originalRun = author.adapter.run;
    let round = 0;
    author.adapter.run = async function* (spec) {
      round += 1;
      for await (const event of originalRun(spec)) {
        if (event.type === "file_change")
          writeFileSync(join(spec.cwd, "output.bin"), Buffer.from([round, 0, 255]));
        yield event;
      }
    };
    const result = await new Orchestrator({
      registry: new Map([[author.adapter.id, author.adapter]]),
    }).run({
      repoRoot: root,
      workspaceKind: "directory",
      inPlace: true,
      prompt: "Repair the binary output",
      harnesses: [author.adapter.id],
      attempts: 3,
      review: false,
      tests: [
        {
          program: process.execPath,
          args: [
            "-e",
            "process.exit(require('node:fs').readFileSync('output.bin')[0] === 3 ? 0 : 1)",
          ],
          envAllowlist: [],
        },
      ],
    });
    expect(result.facts).toMatchObject({ lifecycle: "succeeded", checks: "passed" });
    expect(author.calls).toHaveLength(3);
    expect(readFileSync(join(root, "output.bin"))).toEqual(Buffer.from([3, 0, 255]));
    expect(readResult(root, result.runDir).facts.deliverable.kind).toBe("files");
  });
});
