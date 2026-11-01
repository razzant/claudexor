import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
import { verifyAndDeliverFiles } from "@claudexor/delivery";
import { createFakeHarness } from "@claudexor/harness-fake";
import { type ReviewerSpec } from "@claudexor/review";
import {
  ConformanceReport,
  HarnessManifest,
  RunFailure,
  WorkProduct,
  WorkspaceFilesManifest,
  type HarnessRunSpec,
} from "@claudexor/schema";
import { readEnvelopeCustody } from "@claudexor/workspace";
import { Orchestrator, type OrchestratorResult } from "./orchestrator.js";

// #563 owner decision A: in a best-of run over an isolated directory copy, a
// candidate whose final capture refuses AND whose retention setup then fails
// is excluded; a healthy sibling still wins and can be applied. The excluded
// candidate's exact receipt (cause, kept copy, failed retention stage) reaches
// the successful run's summary and event stream. Everything else stays fatal.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const posix = process.platform !== "win32";
const asRoot = process.getuid?.() === 0;

function project() {
  const root = mkdtempSync(join(tmpdir(), "cx-bestof-retention-"));
  dirs.push(root);
  writeFileSync(join(root, "input.txt"), "selected source\n");
  writeFileSync(join(root, "unselected.txt"), "unselected sibling\n");
  return root;
}

function author(id: string, act: (spec: HarnessRunSpec) => void): HarnessAdapter {
  const fake = createFakeHarness("fake-implement");
  return {
    ...fake,
    id,
    async discover() {
      return HarnessManifest.parse({
        ...(await fake.discover()),
        id,
        kind: "local_cli",
        capabilities: { ...(await fake.discover()).capabilities, review: false, synthesize: false },
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
      act(spec);
      yield { type: "file_change", ts, session_id: spec.session_id, payload: { path: "out.txt" } };
      yield { type: "message", ts, session_id: spec.session_id, text: "Prepared.", final: true };
      yield { type: "completed", ts, session_id: spec.session_id };
    },
  };
}

function reviewer(id: string, providerFamily: "openai" | "anthropic"): ReviewerSpec {
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

type Stage = "address" | "custody";

/** A candidate whose copy holds a FIFO (the capture refuses) and whose
 * retention write at `stage` is blocked by a directory occupying its path. */
function refused(id: string, root: string, stage: Stage): HarnessAdapter {
  const runsDir = new ArtifactStore(root).runsDir();
  return author(id, (spec) => {
    writeFileSync(join(spec.cwd, "out.txt"), `${id} output\n`);
    execFileSync("mkfifo", [join(spec.cwd, "pipe")]);
    const envelopeBase = dirname(spec.cwd);
    const [runDir] = readdirSync(runsDir).map((name) => join(runsDir, name));
    const blocked =
      stage === "address"
        ? join(runDir!, "attempts", basename(envelopeBase), "retained-envelope.json")
        : join(envelopeBase, "continuation-custody.json");
    mkdirSync(join(blocked, "occupied"), { recursive: true });
  });
}

const healthy = author("healthy", (spec) =>
  writeFileSync(join(spec.cwd, "out.txt"), "healthy output\n"),
);

async function race(root: string, adapters: HarnessAdapter[], extra = {}) {
  return new Orchestrator({
    registry: new Map(adapters.map((adapter) => [adapter.id, adapter])),
    reviewers: [reviewer("review-a", "openai"), reviewer("review-b", "anthropic")],
  }).run({
    repoRoot: root,
    prompt: "Create out.txt",
    harnesses: adapters.map((adapter) => adapter.id),
    n: adapters.length,
    workspaceKind: "directory",
    scopePaths: ["input.txt"],
    review: true,
    ...extra,
  });
}

function attemptRefusal(result: OrchestratorResult, attemptId: string) {
  const attempt = new ArtifactStore(result.runDir).readYaml<{
    capture_refusal?: {
      disposition: string;
      detail: string;
      sourceRoot?: string;
      failure?: { message: string };
      retentionFailure?: { code: string };
    };
  }>(join(result.runDir, "attempts", attemptId, "attempt.yaml"));
  return attempt?.capture_refusal;
}

function events(runDir: string): Array<{ type: string; payload: Record<string, unknown> }> {
  return readFileSync(join(runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

const STAGE_TEXT: Record<Stage, string> = {
  address:
    " (not applied), recorded in durable custody; its address in this run could not be written," +
    " so retention setup is incomplete until crash recovery restores that address.",
  custody: ", held by this process only (durable retention could not be recorded).",
};

describe.skipIf(!posix || asRoot)(
  "best-of over an isolated directory copy: a failed retention excludes one candidate",
  () => {
    it.each(["address", "custody"] as const)(
      "%s write failed: the healthy sibling wins and applies, the receipt stays exact",
      async (stage) => {
        const root = project();
        const result = await race(root, [refused("refused", root, stage), healthy]);

        // The healthy candidate wins; nothing reached the original folder yet.
        expect(result.facts).toMatchObject({ lifecycle: "succeeded", review: "approved" });
        expect(result.winner).toBe("a02");
        expect(existsSync(join(result.runDir, "final/failure.yaml"))).toBe(false);
        expect(existsSync(join(root, "out.txt"))).toBe(false);
        expect(readFileSync(join(root, "input.txt"), "utf8")).toBe("selected source\n");

        // The excluded candidate keeps its exact cause, kept copy and stage.
        const refusal = attemptRefusal(result, "a01");
        expect(refusal).toMatchObject({ disposition: "manual_cleanup" });
        expect(refusal?.retentionFailure).toBeDefined();
        const tree = refusal!.sourceRoot!;
        expect(refusal!.failure!.message).toBe(
          `Unsupported filesystem entry: ${join(tree, "pipe")}`,
        );
        expect(refusal!.detail).toContain(`Kept: the isolated copy at ${tree}${STAGE_TEXT[stage]}`);
        expect(readEnvelopeCustody(dirname(tree))?.state).toBe(
          stage === "address" ? "retained" : undefined,
        );
        expect(readFileSync(join(tree, "out.txt"), "utf8")).toBe("refused output\n");

        // ...and reaches the successful run's summary and its event stream.
        const summary = readFileSync(join(result.runDir, "final/summary.md"), "utf8");
        expect(summary).toContain(`- Excluded Candidate A (a01, refused): ${refusal!.detail}`);
        const completed = events(result.runDir).find(
          (event) => event.type === "harness.completed" && event.payload["attempt_id"] === "a01",
        );
        expect(completed?.payload).toMatchObject({ status: "failed", error: refusal!.detail });

        // The winner's exact result applies through the delivery owner.
        const store = new ArtifactStore(root);
        const product = WorkProduct.parse(
          store.readYaml(join(result.runDir, "final/work_product.yaml")),
        );
        expect(product.producer_attempt_id).toBe("a02");
        expect(product.meta.apply_state).toBe("not_applied");
        const text = readFileSync(join(result.runDir, product.files.manifest!), "utf8");
        expect(product.meta.manifest_sha256).toBe(
          `sha256:${createHash("sha256").update(text).digest("hex")}`,
        );
        const applied = await verifyAndDeliverFiles(root, {
          manifest: WorkspaceFilesManifest.parse(JSON.parse(text)),
          manifestSha256: String(product.meta.manifest_sha256),
          artifactRoot: result.runDir,
        });
        expect(applied).toMatchObject({ applied: true });
        expect(readFileSync(join(root, "out.txt"), "utf8")).toBe("healthy output\n");
        expect(readFileSync(join(root, "input.txt"), "utf8")).toBe("selected source\n");
        expect(readFileSync(join(root, "unselected.txt"), "utf8")).toBe("unselected sibling\n");
      },
    );

    it("all candidates refused: the run still fails capture_refused with the first receipt", async () => {
      const root = project();
      const result = await race(root, [
        refused("refused-a", root, "address"),
        refused("refused-b", root, "custody"),
      ]);
      expect(result.facts).toMatchObject({ lifecycle: "failed", reason: "capture_refused" });
      expect(result.winner).toBeNull();
      const failure = RunFailure.parse(
        new ArtifactStore(root).readYaml(join(result.runDir, "final/failure.yaml")),
      );
      const first = attemptRefusal(result, "a01")!;
      expect(failure.captureFailure?.message).toBe(first.failure!.message);
      expect(failure.nextActions).toContain(`Inspect the changed files at ${first.sourceRoot}`);
      expect(readFileSync(join(result.runDir, "final/summary.md"), "utf8")).toContain(
        STAGE_TEXT.address,
      );
      expect(existsSync(join(result.runDir, "final/files/manifest.json"))).toBe(false);
      expect(existsSync(join(root, "out.txt"))).toBe(false);
    });

    it("a single candidate whose retention failed still fails", async () => {
      const root = project();
      const only = refused("refused", root, "custody");
      const result = await new Orchestrator({ registry: new Map([[only.id, only]]) }).run({
        repoRoot: root,
        prompt: "Create out.txt",
        harnesses: [only.id],
        workspaceKind: "directory",
        scopePaths: ["input.txt"],
        review: false,
      });
      expect(result.facts).toMatchObject({ lifecycle: "failed", reason: "capture_refused" });
      expect(readFileSync(join(result.runDir, "final/summary.md"), "utf8")).toContain(
        STAGE_TEXT.custody,
      );
      expect(existsSync(join(root, "out.txt"))).toBe(false);
    });

    it("in place, a refused capture still fails the run (live effects need inspection)", async () => {
      const root = project();
      const live = author("live", (spec) => {
        // The observed output path is a FIFO: the live capture cannot read it.
        execFileSync("mkfifo", [join(spec.cwd, "out.txt")]);
      });
      const result = await new Orchestrator({ registry: new Map([[live.id, live]]) }).run({
        repoRoot: root,
        prompt: "Create out.txt",
        harnesses: [live.id],
        workspaceKind: "directory",
        scopePaths: ["input.txt"],
        inPlace: true,
        review: false,
      });
      expect(result.facts).toMatchObject({ lifecycle: "failed", reason: "capture_refused" });
      expect(attemptRefusal(result, "a01")).toMatchObject({ disposition: "manual_cleanup" });
      // The live effect stays in place for inspection; nothing rolled it back.
      expect(lstatSync(join(root, "out.txt")).isFIFO()).toBe(true);
    });
  },
);
