import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
import { createFakeHarness } from "@claudexor/harness-fake";
import {
  deriveApplyEligibility,
  revertInPlaceFromAnchor,
  validateApplyGate,
  verifyAndDeliver,
} from "@claudexor/delivery";
import type { ReviewerSpec } from "@claudexor/review";
import {
  ConformanceReport,
  DecisionRecord,
  HarnessManifest,
  RunFacts,
  TaskContract,
  WorkProduct,
  outcomeBanner,
} from "@claudexor/schema";
import { Orchestrator, type RunInput } from "./orchestrator.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-review-policy-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  execFileSync("git", ["-C", dir, "add", "README.md"]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "base",
  ]);
  return dir;
}
function author(id = "author", path = "change.txt", content?: (attempt: number) => string) {
  const fake = createFakeHarness("fake-implement");
  const calls: string[] = [];
  const adapter: HarnessAdapter = {
    ...fake,
    id,
    async discover() {
      const manifest = await fake.discover();
      return HarnessManifest.parse({
        ...manifest,
        id,
        kind: "local_cli",
        capabilities: {
          ...manifest.capabilities,
          review: false,
          synthesize: false,
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
      calls.push(spec.intent);
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts };
      writeFileSync(join(spec.cwd, path), content?.(calls.length) ?? `change from ${id}\n`);
      yield { type: "message", session_id: spec.session_id, ts, text: "Changed the fixture." };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
  return { adapter, calls };
}
function reviewer(id: string, providerFamily: "openai" | "anthropic") {
  let calls = 0;
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
      calls++;
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
  return { spec: { adapter, providerFamily } as ReviewerSpec, calls: () => calls };
}
function artifacts(root: string, runDir: string) {
  const store = new ArtifactStore(root);
  const facts = RunFacts.parse(store.readYaml(join(runDir, "final/run_facts.yaml")));
  const decision = DecisionRecord.parse(store.readYaml(join(runDir, "arbitration/decision.yaml")));
  const product = WorkProduct.parse(store.readYaml(join(runDir, "final/work_product.yaml")));
  const contract = TaskContract.parse(store.readYaml(join(runDir, "context/task.yaml")));
  const patch = readFileSync(join(runDir, "final/patch.diff"), "utf8");
  const events = readFileSync(join(runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const gate = {
    state: facts.outcome.lifecycle,
    decision,
    workProduct: product,
    patch,
    originalRepoRoot: root,
    targetRepoRoot: root,
  };
  return { facts, decision, product, contract, patch, events, gate };
}

describe("frozen ordinary Agent review policy", () => {
  it("capped review-off repairs failed checks before ordinary envelope apply", async () => {
    const root = repo();
    const writer = author("author", "change.txt", (attempt) =>
      attempt === 1 ? "bad\n" : "good\n",
    );
    const orch = new Orchestrator({ registry: new Map([["author", writer.adapter]]) });
    const preflight = vi.spyOn(
      orch as never as { resolveReviewers: () => Promise<ReviewerSpec[]> },
      "resolveReviewers",
    );
    const result = await orch.run({
      repoRoot: root,
      prompt: "Make a passing change",
      harnesses: ["author"],
      review: false,
      attempts: 3,
      tests: [
        {
          program: process.execPath,
          args: [
            "-e",
            "process.exit(require('fs').readFileSync('change.txt','utf8') === 'good\\n' ? 0 : 1)",
          ],
          envAllowlist: [],
        },
      ],
    });
    expect(result.facts).toMatchObject({
      lifecycle: "succeeded",
      review_requested: false,
      review: "not_run",
      checks: "passed",
    });
    expect(writer.calls).toHaveLength(2);
    expect(preflight).not.toHaveBeenCalled();
    const art = artifacts(root, result.runDir);
    expect(art.facts.apply.eligibility?.eligible).toBe(true);
    expect(art.decision.final_verify?.gates_passed).toBe(true);
  });
  it.each([false, true])(
    "defaults off with automatic executor=%s and applies without risk acceptance",
    async (automatic) => {
      const root = repo();
      const writer = author();
      const a = reviewer("review-a", "openai"),
        b = reviewer("review-b", "anthropic");
      const orch = new Orchestrator({
        registry: new Map([
          ["author", writer.adapter],
          ["review-a", a.spec.adapter],
          ["review-b", b.spec.adapter],
        ]),
      });
      const preflight = vi.spyOn(
        orch as never as { resolveReviewers: () => Promise<ReviewerSpec[]> },
        "resolveReviewers",
      );
      const evidence = vi.spyOn(
        orch as never as { prepareReviewEvidenceDir: () => string },
        "prepareReviewEvidenceDir",
      );
      const result = await orch.run({
        repoRoot: root,
        prompt: "Make a change",
        mode: "agent",
        ...(automatic ? {} : { harnesses: ["author"] }),
      });
      expect(result.facts).toMatchObject({
        lifecycle: "succeeded",
        review: "not_run",
        review_requested: false,
      });
      expect(preflight).not.toHaveBeenCalled();
      expect(evidence).not.toHaveBeenCalled();
      expect(a.calls() + b.calls()).toBe(0);
      const art = artifacts(root, result.runDir);
      expect(art.contract.review_requested).toBe(false);
      expect(art.facts.review.state).toBe("not_run");
      expect(art.facts.apply.eligibility).toMatchObject({ eligible: true, state: "not_verified" });
      expect(art.facts.required_actions).toEqual([]);
      expect(art.facts.participants.attempts.every((entry) => entry.role !== "reviewer")).toBe(
        true,
      );
      expect(art.decision.verification_basis).toBe("none");
      expect(art.decision.final_verify?.applied_cleanly).toBe(true);
      expect(
        art.events
          .filter((event) => event.type === "review.skipped")
          .map((event) => event.payload.reason),
      ).toContain("not_requested");
      expect(
        art.events.some(
          (event) => event.type === "review.started" || event.payload.harness_id === "review-panel",
        ),
      ).toBe(false);
      expect(validateApplyGate(art.gate)).toBeNull();
      const applied = await verifyAndDeliver(
        root,
        art.patch,
        { mode: "apply", protectedApply: true },
        [],
        (finalVerify) => validateApplyGate({ ...art.gate, finalVerify }),
      );
      expect(applied.applied).toBe(true);
      expect(readFileSync(join(root, "change.txt"), "utf8")).toContain("change from author");
    },
  );

  it.each([undefined, 3])(
    "in-place review-off writes honestly and keeps Revert, attempts=%s",
    async (attempts) => {
      const root = repo();
      const writer = author();
      const orch = new Orchestrator({ registry: new Map([["author", writer.adapter]]) });
      const preflight = vi.spyOn(
        orch as never as { resolveReviewers: () => Promise<ReviewerSpec[]> },
        "resolveReviewers",
      );
      const evidence = vi.spyOn(
        orch as never as { prepareReviewEvidenceDir: () => string },
        "prepareReviewEvidenceDir",
      );
      const result = await orch.run({
        repoRoot: root,
        prompt: "Make a change",
        mode: "agent",
        harnesses: ["author"],
        inPlace: true,
        review: false,
        attempts,
      });
      expect(result.facts).toMatchObject({
        lifecycle: "succeeded",
        review: "not_run",
        review_requested: false,
      });
      const art = artifacts(root, result.runDir);
      expect(preflight).not.toHaveBeenCalled();
      expect(evidence).not.toHaveBeenCalled();
      expect(writer.calls).toHaveLength(1);
      expect(art.product.meta).toMatchObject({ adopted: true, apply_state: "applied" });
      expect(art.facts.apply.eligibility?.state).toBe("already_applied");
      expect(
        outcomeBanner(art.facts.outcome, { applyState: "applied", hasApplyableChange: false }),
      ).toBe("Applied · not reviewed");
      const anchor = art.product.meta?.revert_anchor_id;
      expect(typeof anchor).toBe("string");
      expect(await revertInPlaceFromAnchor(root, anchor as string)).toMatchObject({
        reverted: true,
      });
      expect(existsSync(join(root, "change.txt"))).toBe(false);
    },
  );

  it.each([0, 1])("preserves independently configured checks, exit=%s", async (code) => {
    const root = repo();
    const writer = author();
    const result = await new Orchestrator({ registry: new Map([["author", writer.adapter]]) }).run({
      repoRoot: root,
      prompt: "Make a change",
      harnesses: ["author"],
      review: false,
      tests: [
        { program: process.execPath, args: ["-e", `process.exit(${code})`], envAllowlist: [] },
      ],
    });
    const art = artifacts(root, result.runDir);
    expect(art.facts.outcome).toMatchObject({
      review_requested: false,
      review: "not_run",
      checks: code === 0 ? "passed" : "failed",
    });
    expect(art.facts.apply.eligibility?.eligible).toBe(code === 0);
    expect(art.decision.verification_basis).toBe(code === 0 ? "deterministic_checks" : "none");
  });

  it.each([{ review: true }, { n: 2 }, { attempts: 2 }, { untilClean: true }])(
    "keeps explicitly requested review and strategy $review/$n/$attempts/$untilClean",
    async (strategy) => {
      const root = repo();
      const writer = author();
      const second = author("other");
      const a = reviewer("review-a", "openai"),
        b = reviewer("review-b", "anthropic");
      const orch = new Orchestrator({
        registry: new Map([
          ["author", writer.adapter],
          ["other", second.adapter],
        ]),
        reviewers: [a.spec, b.spec],
      });
      const result = await orch.run({
        repoRoot: root,
        prompt: "Make a change",
        mode: "agent",
        harnesses: strategy.n ? ["author", "other"] : ["author"],
        synthesis: "never",
        ...strategy,
      } as RunInput);
      expect(result.facts).toMatchObject({
        lifecycle: "succeeded",
        review_requested: true,
        review: "approved",
      });
      expect(a.calls()).toBeGreaterThan(0);
      expect(b.calls()).toBeGreaterThan(0);
      expect(artifacts(root, result.runDir).facts.apply.eligibility?.eligible).toBe(true);
    },
  );

  it.each([false, true])(
    "explicit panel/auto review requests real review, auto=%s",
    async (auto) => {
      const root = repo();
      const writer = author();
      const a = reviewer("review-a", "openai"),
        b = reviewer("review-b", "anthropic");
      const orch = new Orchestrator({
        registry: new Map([
          ["author", writer.adapter],
          ["review-a", a.spec.adapter],
          ["review-b", b.spec.adapter],
        ]),
        reviewerPanel: auto
          ? undefined
          : [
              { harness: "review-a", model: "review-a-model" },
              { harness: "review-b", model: "review-b-model" },
            ],
      });
      const result = await orch.run({
        repoRoot: root,
        prompt: "Make a change",
        harnesses: ["author"],
        ...(auto ? { review: true } : {}),
      });
      expect(result.facts).toMatchObject({
        lifecycle: "succeeded",
        review_requested: true,
        review: "approved",
      });
      expect(a.calls()).toBe(1);
      expect(b.calls()).toBe(1);
    },
  );

  it("unavailable requested review remains not-run and cannot be applied", async () => {
    const root = repo();
    const writer = author();
    const result = await new Orchestrator({ registry: new Map([["author", writer.adapter]]) }).run({
      repoRoot: root,
      prompt: "Make a change",
      harnesses: ["author"],
      review: true,
    });
    expect(result.facts).toMatchObject({ review_requested: true, review: "not_run" });
    expect(artifacts(root, result.runDir).facts.apply.eligibility?.eligible).toBe(false);
  });

  it("does not demand absent model review for a high-risk diff when review was off", async () => {
    const root = repo();
    const writer = author("author", "migration.sql");
    const result = await new Orchestrator({ registry: new Map([["author", writer.adapter]]) }).run({
      repoRoot: root,
      prompt: "Make a change",
      harnesses: ["author"],
      review: false,
    });
    expect(result.facts).toMatchObject({ review_requested: false, review: "not_run" });
    expect(artifacts(root, result.runDir).facts.apply.eligibility?.eligible).toBe(true);
  });

  it("retains independent denied-path policy and its durable blocker ids with review off", async () => {
    const root = repo();
    const writer = author();
    const result = await new Orchestrator({ registry: new Map([["author", writer.adapter]]) }).run({
      repoRoot: root,
      prompt: "Make a change",
      harnesses: ["author"],
      review: false,
      denyPaths: ["change.txt"],
    });
    const art = artifacts(root, result.runDir);
    expect(result.facts).toMatchObject({ review_requested: false, review: "blocked" });
    expect(art.facts.review.blockers).toBeGreaterThan(0);
    expect(
      art.facts.participants.attempts.every((participant) => participant.role !== "reviewer"),
    ).toBe(true);
    expect(art.facts.apply.eligibility?.eligible).toBe(false);
  });

  it("frozen off ignores later automatic panel configuration", async () => {
    const root = repo();
    const writer = author();
    const orch = new Orchestrator({
      registry: new Map([["author", writer.adapter]]),
      reviewerPanel: [{ harness: "absent" }],
    });
    const result = await orch.run({
      repoRoot: root,
      prompt: "Make a change",
      harnesses: ["author"],
      review: false,
    });
    expect(result.facts).toMatchObject({
      lifecycle: "succeeded",
      review_requested: false,
      review: "not_run",
    });
  });

  it("does not upgrade legacy not-run decisions to applicable", async () => {
    const root = repo();
    const writer = author();
    const result = await new Orchestrator({ registry: new Map([["author", writer.adapter]]) }).run({
      repoRoot: root,
      prompt: "Make a change",
      harnesses: ["author"],
      review: false,
    });
    const art = artifacts(root, result.runDir);
    const legacyFacts = { ...art.decision.facts };
    delete legacyFacts.review_requested;
    const gate = { ...art.gate, decision: { ...art.decision, facts: legacyFacts } };
    expect(validateApplyGate(gate)).toContain("isn't ready to apply");
    expect(deriveApplyEligibility(gate).eligible).toBe(false);
  });

  it.each([{ n: 2 }, { untilClean: true }])(
    "refuses contradictory explicit off before work ($n/$untilClean)",
    async (strategy) => {
      const root = repo();
      const writer = author();
      const orch = new Orchestrator({ registry: new Map([["author", writer.adapter]]) });
      await expect(
        orch.run({
          repoRoot: root,
          prompt: "Make a change",
          harnesses: ["author"],
          review: false,
          ...strategy,
        }),
      ).rejects.toMatchObject({ code: "invalid_strategy" });
      expect(writer.calls).toEqual([]);
    },
  );
});
