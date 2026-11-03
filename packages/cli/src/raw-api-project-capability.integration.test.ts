/**
 * #137 through the production path: a route that cannot read files plans no
 * project and reviews no change, under the owner's two selections. The real
 * Orchestrator and the real raw adapter talk to a LOCAL endpoint, so "no paid
 * request" is read from what that endpoint actually received. Native readers,
 * Ask without a project and raw implementation are the capability that must stay.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { createRawApiAdapter } from "@claudexor/harness-raw-api";
import { Orchestrator } from "@claudexor/orchestrator";
import { reviewCandidate, type ReviewerSpec } from "@claudexor/review";
import { CredentialProfile, type HarnessRunSpec } from "@claudexor/schema";
import { SecretStore } from "@claudexor/secrets";
import { noProjectRepoRoot } from "@claudexor/util";
import { normalizeRunStartRequest } from "../../control-api/src/run-start.js";
import {
  KEY_ENV,
  asDoctorOk,
  committed,
  failureRecord,
  nativeReader,
  nonReadingReviewer,
  ownedDir,
  removeOwnedDirs,
  runEvents,
  startLoopback,
  useConfig,
  withProfileProbe,
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
    baseUrl: provider.baseUrl,
    keyEnv: KEY_ENV,
  });

const MODEL = { openrouter: "vendor/big" };
const REFUSAL =
  "openrouter (cannot read project files: ask without a project or choose a harness that reads files)";

const noProject = () => {
  const root = noProjectRepoRoot();
  mkdirSync(root, { recursive: true });
  return root;
};

/** A saved OpenRouter account row, as the Accounts surface stores it. */
function savedAccount() {
  const profile = CredentialProfile.parse({
    profile_id: "work",
    harness_id: "openrouter",
    display_name: "Work",
    credential_kind: "api_key",
    secret_ref: "openrouter:work",
    enabled: true,
  });
  useConfig({ credential_profiles: [profile] });
  const store = new SecretStore();
  store.set("openrouter:work", "sk-contract-work");
  store.set("openrouter", "sk-contract-default");
  delete process.env[KEY_ENV];
}

const WORK_PATCH =
  "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# repo\n+# raw implemented\n";

describe("a route that cannot read files plans no project (#137)", () => {
  it("an explicit project Plan refuses before anything is requested, with the remedy", async () => {
    const result = await new Orchestrator({
      registry: new Map([["openrouter", openrouter()]]),
      reviewers: [],
    }).run({
      repoRoot: committed(),
      prompt: "Plan the change",
      mode: "plan",
      harnesses: ["openrouter"],
      models: MODEL,
    });
    expect(provider.posts).toEqual([]);
    expect(result.lifecycle).toBe("failed");
    expect(result.summary).toContain(REFUSAL);
    const failure = failureRecord(result.runDir);
    expect(failure.phase).toBe("routing");
    expect(failure.category).toBe("harness_unavailable");
  });

  it("a Plan pinned to a saved account refuses the same way: no account makes the route read", async () => {
    savedAccount();
    const result = await new Orchestrator({
      registry: new Map([["openrouter", withProfileProbe(openrouter())]]),
      reviewers: [],
    }).run({
      repoRoot: committed(),
      prompt: "Plan the change",
      mode: "plan",
      credentialProfileId: "work",
      models: MODEL,
    });
    expect(provider.posts).toEqual([]);
    expect(result.lifecycle).toBe("failed");
    expect(result.summary).toContain("cannot read project files");
  });

  it("the shipped adapter's saved row stops earlier, at its own credential admission", async () => {
    savedAccount();
    const result = await new Orchestrator({
      registry: new Map([["openrouter", openrouter()]]),
      reviewers: [],
    }).run({
      repoRoot: committed(),
      prompt: "Plan the change",
      mode: "plan",
      credentialProfileId: "work",
      models: MODEL,
    });
    expect(provider.posts).toEqual([]);
    expect(result.lifecycle).toBe("failed");
    expect(result.summary).toContain('harness "openrouter" has no profile probe');
  });

  it("Auto skips a proved route with its reason, and a native reader plans", async () => {
    const local: HarnessRunSpec[] = [];
    const result = await new Orchestrator({
      registry: new Map([
        ["openrouter", asDoctorOk(openrouter())],
        ["reader", nativeReader("reader", "anthropic", local)],
      ]),
      reviewers: [],
    }).run({ repoRoot: committed(), prompt: "Plan the change", mode: "plan", models: MODEL });
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(provider.posts).toEqual([]);
    expect(local.map((spec) => spec.intent)).toEqual(["plan"]);
    const degraded = runEvents(result.runDir).find((e) => e.type === "route.pool.degraded");
    expect(degraded?.payload["dropped_lanes"]).toEqual([
      { harness_id: "openrouter", stage: "capability", detail: REFUSAL },
    ]);
  });

  it("an explicit Council naming the route refuses every member before any draft", async () => {
    const local: HarnessRunSpec[] = [];
    const result = await new Orchestrator({
      registry: new Map([
        ["reader", nativeReader("reader", "anthropic", local)],
        ["openrouter", openrouter()],
      ]),
      reviewers: [],
    }).run({
      repoRoot: committed(),
      prompt: "Plan the change",
      mode: "plan",
      council: true,
      n: 2,
      harnesses: ["reader", "openrouter"],
      models: MODEL,
    });
    expect(provider.posts).toEqual([]);
    expect(local).toEqual([]);
    expect(result.lifecycle).toBe("failed");
    expect(result.summary).toContain(REFUSAL);
  });

  it("an automatic Council drafts and merges on the readers alone", async () => {
    const one: HarnessRunSpec[] = [];
    const two: HarnessRunSpec[] = [];
    const result = await new Orchestrator({
      registry: new Map([
        ["openrouter", asDoctorOk(openrouter())],
        ["reader-a", nativeReader("reader-a", "anthropic", one)],
        ["reader-b", nativeReader("reader-b", "google", two)],
      ]),
      reviewers: [],
    }).run({
      repoRoot: committed(),
      prompt: "Plan the change",
      mode: "plan",
      council: true,
      n: 2,
      models: MODEL,
    });
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(provider.posts).toEqual([]);
    expect([...one, ...two].map((spec) => spec.intent).sort()).toEqual([
      "plan",
      "plan",
      "synthesize",
    ]);
  });

  it("keeps a plan that claims no project: no project in the engine, and no merge it cannot read", async () => {
    // Public surfaces refuse Plan without a project before this point (below);
    // the engine's own no-project Plan has nothing to read and stays text-only.
    const solo = await new Orchestrator({
      registry: new Map([["openrouter", openrouter()]]),
      reviewers: [],
    }).run({
      repoRoot: noProject(),
      prompt: "Outline a migration in general terms",
      mode: "plan",
      harnesses: ["openrouter"],
      models: MODEL,
    });
    expect(solo.lifecycle, solo.summary).toBe("succeeded");
    expect(provider.posts).toHaveLength(1);
    expect(provider.posts[0]!.body.messages.at(-1).content).toContain("Outline a migration");

    // A Council's merge is file-backed. The route cannot read the drafts, so its
    // synthesize attempt is refused before it is paid for, not after.
    provider.reset();
    const local: HarnessRunSpec[] = [];
    const council = await new Orchestrator({
      registry: new Map([
        ["openrouter", openrouter()],
        ["reader", nativeReader("reader", "anthropic", local)],
      ]),
      reviewers: [],
    }).run({
      repoRoot: noProject(),
      prompt: "Outline a migration in general terms",
      mode: "plan",
      council: true,
      n: 2,
      harnesses: ["openrouter", "reader"],
      models: MODEL,
    });
    expect(provider.posts).toHaveLength(1); // the draft; never the merge
    expect(council.lifecycle).toBe("failed");
    expect(council.summary).toContain("requires a RawContextPacket");
  });

  it("the public run start admits no Plan without a project: that boundary was never this route's", () => {
    expect(() => normalizeRunStartRequest({ mode: "plan", prompt: "Outline it" })).toThrow(
      "project scope is required for mode 'plan'",
    );
  });

  it("Ask without a project and raw implementation stay supported", async () => {
    const ask = await new Orchestrator({
      registry: new Map([["openrouter", openrouter()]]),
      reviewers: [],
    }).run({
      repoRoot: noProject(),
      prompt: "2+2?",
      mode: "ask",
      contextMode: "off",
      harnesses: ["openrouter"],
      models: MODEL,
    });
    expect(ask.lifecycle, ask.summary).toBe("succeeded");
    expect(provider.posts).toHaveLength(1);

    provider.reset();
    provider.answers = [{ patch: WORK_PATCH }];
    const agent = await new Orchestrator({
      registry: new Map([["openrouter", openrouter()]]),
      reviewers: [],
    }).run({
      repoRoot: committed(),
      prompt: "Update the heading",
      mode: "agent",
      harnesses: ["openrouter"],
      models: MODEL,
      n: 1,
    });
    expect(agent.lifecycle, agent.summary).toBe("succeeded");
    expect(provider.posts).toHaveLength(1);
  });
});

describe("change review belongs to agents that read the files themselves (#137, INV-042)", () => {
  /** An Agent run by a native producer, reviewed by whatever the deps choose. */
  const reviewedRun = (deps: Record<string, unknown>, registry: Map<string, any>) =>
    new Orchestrator({ registry, ...deps }).run({
      repoRoot: committed(),
      prompt: "Update the heading",
      mode: "agent",
      harnesses: ["producer"],
      n: 1,
      review: true,
    });
  const producer = () =>
    nativeReader("producer", "anthropic", [], (spec) => {
      writeFileSync(join(spec.cwd, "README.md"), "# native\n");
    });

  it("an explicit panel naming the route refuses before any candidate spends", async () => {
    const result = await reviewedRun(
      { reviewerPanel: [{ harness: "openrouter", model: "vendor/big" }] },
      new Map<string, any>([
        ["producer", producer()],
        ["openrouter", openrouter()],
      ]),
    );
    expect(provider.posts).toEqual([]);
    expect(result.lifecycle).toBe("failed");
    expect(failureRecord(result.runDir).phase).toBe("review_preflight");
    expect(result.summary).toContain(
      "reviewer harness 'openrouter' cannot read the candidate evidence files itself",
    );
  });

  it("a panel pinning a saved account refuses too: a key does not make the route read", async () => {
    savedAccount();
    const result = await reviewedRun(
      {
        reviewerPanel: [
          { harness: "openrouter", model: "vendor/big", credentialProfileId: "work" },
        ],
      },
      new Map<string, any>([
        ["producer", producer()],
        ["openrouter", withProfileProbe(openrouter())],
      ]),
    );
    expect(provider.posts).toEqual([]);
    expect(result.lifecycle).toBe("failed");
    expect(result.summary).toContain(
      "reviewer harness 'openrouter' cannot read the candidate evidence files itself",
    );
  });

  it("the automatic panel skips the route with its reason; native reviewers still review", async () => {
    savedAccount();
    const reviewerA: HarnessRunSpec[] = [];
    const reviewerB: HarnessRunSpec[] = [];
    const result = await reviewedRun(
      { reviewerModels: { unknown: "vendor/big" } },
      new Map<string, any>([
        ["openrouter", withProfileProbe(openrouter())],
        ["producer", producer()],
        ["reader-a", nativeReader("reader-a", "anthropic", reviewerA)],
        ["reader-b", nativeReader("reader-b", "google", reviewerB)],
      ]),
    );
    expect(provider.posts).toEqual([]);
    const reviewed = [...reviewerA, ...reviewerB].map((spec) => spec.intent);
    expect(reviewed).toContain("review");
    const preflight = runEvents(result.runDir)
      .filter((event) => event.type === "review.preflight")
      .flatMap((event) => (event.payload["ignored_settings"] ?? []) as string[]);
    expect(preflight.join("\n")).toContain(
      "reviewer family 'openrouter' skipped: it cannot read the candidate evidence files itself",
    );
  });

  it("a raw producer keeps its Agent run, reviewed by a native reader", async () => {
    const reviewer: HarnessRunSpec[] = [];
    provider.answers = [{ patch: WORK_PATCH }];
    const result = await new Orchestrator({
      registry: new Map<string, any>([
        ["openrouter", openrouter()],
        ["reader-a", nativeReader("reader-a", "anthropic", reviewer)],
      ]),
      reviewerPanel: [{ harness: "reader-a" }],
    }).run({
      repoRoot: committed(),
      prompt: "Update the heading",
      mode: "agent",
      harnesses: ["openrouter"],
      models: MODEL,
      n: 1,
      review: true,
    });
    expect(provider.posts).toHaveLength(1); // the patch, never a review
    expect(reviewer.map((spec) => spec.intent)).toEqual(["review"]);
    expect(result.runDir).toBeTruthy();
  });
});

describe("the reviewer contract is file reading, whatever a route declares about review (#137)", () => {
  const writer = () =>
    nativeReader("producer", "anthropic", [], (spec) => {
      writeFileSync(join(spec.cwd, "README.md"), "# native\n");
    });
  const reviewed = (deps: Record<string, unknown>, registry: Map<string, any>) =>
    new Orchestrator({ registry, ...deps }).run({
      repoRoot: committed(),
      prompt: "Update the heading",
      mode: "agent",
      harnesses: ["producer"],
      n: 1,
      review: true,
    });

  it("an explicit panel refuses a reviewer that declares review but no file reading", async () => {
    const blind: HarnessRunSpec[] = [];
    const result = await reviewed(
      { reviewerPanel: [{ harness: "blind" }] },
      new Map<string, any>([
        ["producer", writer()],
        ["blind", nonReadingReviewer("blind", "openai", blind)],
      ]),
    );
    expect(blind).toEqual([]);
    expect(result.lifecycle).toBe("failed");
    expect(failureRecord(result.runDir).phase).toBe("review_preflight");
    expect(result.summary).toContain(
      "reviewer harness 'blind' cannot read the candidate evidence files itself",
    );
  });

  it("the automatic panel passes it over with the reason; reading reviewers review", async () => {
    const blind: HarnessRunSpec[] = [];
    const readerA: HarnessRunSpec[] = [];
    const readerB: HarnessRunSpec[] = [];
    const result = await reviewed(
      {},
      new Map<string, any>([
        ["blind", nonReadingReviewer("blind", "openai", blind)],
        ["producer", writer()],
        ["reader-a", nativeReader("reader-a", "anthropic", readerA)],
        ["reader-b", nativeReader("reader-b", "google", readerB)],
      ]),
    );
    expect(blind).toEqual([]);
    expect([...readerA, ...readerB].map((spec) => spec.intent)).toContain("review");
    const preflight = runEvents(result.runDir)
      .filter((event) => event.type === "review.preflight")
      .flatMap((event) => (event.payload["ignored_settings"] ?? []) as string[]);
    expect(preflight.join("\n")).toContain(
      "reviewer family 'blind' skipped: it cannot read the candidate evidence files itself",
    );
  });

  it("`claudexor review` of a diff refuses it before any reviewer runs", async () => {
    const blind: HarnessRunSpec[] = [];
    const orchestrator = new Orchestrator({
      registry: new Map<string, any>([["blind", nonReadingReviewer("blind", "openai", blind)]]),
      reviewerPanel: [{ harness: "blind" }],
    });
    await expect(
      orchestrator.reviewDiff({
        repoRoot: committed(),
        diff: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# repo\n+# x\n",
      }),
    ).rejects.toThrow("reviewer harness 'blind' cannot read the candidate evidence files itself");
    expect(blind).toEqual([]);
  });
});

describe("a reviewer list the engine did not resolve meets the same contract (#137, INV-042)", () => {
  const CANNOT_READ = "cannot read the candidate evidence files itself";
  const DIFF =
    "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# repo\n+# x\n";
  const spec = (adapter: HarnessAdapter, providerFamily: "openai" | "google") => ({
    adapter,
    providerFamily,
  });
  const writer = (dispatched: HarnessRunSpec[] = []) =>
    nativeReader("producer", "anthropic", dispatched, (run) => {
      writeFileSync(join(run.cwd, "README.md"), "# native\n");
    });
  /** `OrchestratorDeps.reviewers`, the injection seam a library caller has. */
  const injected = (
    reviewers: ReviewerSpec[],
    producer: HarnessRunSpec[] = [],
    run: Record<string, unknown> = { n: 1 },
  ) =>
    new Orchestrator({ registry: new Map([["producer", writer(producer)]]), reviewers }).run({
      repoRoot: committed(),
      prompt: "Update the heading",
      mode: "agent",
      harnesses: ["producer"],
      review: true,
      ...run,
    });
  const decisionOf = (runDir: string) => {
    const path = join(runDir, "arbitration", "decision.yaml");
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  };
  /** The mandatory packet a direct `reviewCandidate` caller supplies. */
  const direct = (reviewers: ReviewerSpec[]) => {
    const evidenceDir = ownedDir("cx-direct-review-evidence-");
    for (const name of [
      "USER_INTENT.md",
      "FORBIDDEN_FINDINGS.md",
      "PLAN_ACCEPTED.md",
      "TESTS.txt",
      "DECIDED_TRADEOFFS.md",
    ])
      writeFileSync(join(evidenceDir, name), "(none)\n");
    const artifactsDir = join(ownedDir("cx-direct-review-artifacts-"), "reviewers");
    return {
      evidenceDir,
      artifactsDir,
      review: () =>
        reviewCandidate({
          candidateLabel: "Direct",
          diff: DIFF,
          cwd: committed(),
          evidenceDir,
          artifactsDir,
          reviewers,
        }),
    };
  };
  /** Counts discoveries so a test can tell a new probe from the panel's own. */
  const counted = (adapter: HarnessAdapter) => {
    const discovery = { calls: 0 };
    const counting: HarnessAdapter = {
      ...adapter,
      discover() {
        discovery.calls += 1;
        return adapter.discover();
      },
    };
    return { adapter: counting, discovery };
  };

  it.each([
    ["one round", { n: 1 }],
    ["best-of", { n: 2 }],
    ["repair rounds", { attempts: 2 }],
  ])("two nonreaders are refused before a candidate spends: %s", async (_label, run) => {
    const a: HarnessRunSpec[] = [];
    const b: HarnessRunSpec[] = [];
    const producer: HarnessRunSpec[] = [];
    const result = await injected(
      [
        spec(nonReadingReviewer("blind-a", "openai", a), "openai"),
        spec(nonReadingReviewer("blind-b", "google", b), "google"),
      ],
      producer,
      run,
    );
    expect([...a, ...b]).toEqual([]);
    expect(producer).toEqual([]);
    expect(result.lifecycle).toBe("failed");
    const failure = failureRecord(result.runDir);
    expect(failure.phase).toBe("review_preflight");
    expect(failure.category).toBe("harness_unavailable");
    expect(result.summary).toContain(`reviewer harness 'blind-a' ${CANNOT_READ}`);
    expect(result.facts.review).toBe("not_run");
    expect(result.reviewVerified).not.toBe(true);
    expect(decisionOf(result.runDir)).toBeNull();
  });

  it("one nonreader refuses the whole list: no clean partial panel, wherever it stands", async () => {
    for (const blindFirst of [true, false]) {
      const blind: HarnessRunSpec[] = [];
      const reader: HarnessRunSpec[] = [];
      const producer: HarnessRunSpec[] = [];
      const members = [
        spec(nativeReader("reader-a", "openai", reader), "openai"),
        spec(nativeReader("reader-b", "google", reader), "google"),
        spec(nonReadingReviewer("blind", "openai", blind), "openai"),
      ];
      const result = await injected(blindFirst ? members.reverse() : members, producer);
      expect([...blind, ...reader, ...producer]).toEqual([]);
      expect(result.lifecycle).toBe("failed");
      expect(result.summary).toContain(`reviewer harness 'blind' ${CANNOT_READ}`);
      expect(result.facts.review).toBe("not_run");
      expect(decisionOf(result.runDir)).toBeNull();
    }
  });

  it("the real raw adapter injected as a reviewer sends nothing", async () => {
    const producer: HarnessRunSpec[] = [];
    const result = await injected(
      [{ adapter: openrouter(), providerFamily: "unknown", requestedModel: "vendor/big" }],
      producer,
    );
    expect(provider.posts).toEqual([]);
    expect(producer).toEqual([]);
    expect(result.lifecycle).toBe("failed");
    expect(result.summary).toContain(`reviewer harness 'openrouter' ${CANNOT_READ}`);
  });

  it("a reviewer whose discovery fails is refused: an unknown capability is no pass", async () => {
    const dispatched: HarnessRunSpec[] = [];
    const producer: HarnessRunSpec[] = [];
    const broken: HarnessAdapter = {
      ...nativeReader("broken", "openai", dispatched),
      async discover() {
        throw new Error("discovery down");
      },
    };
    const result = await injected(
      [spec(broken, "openai"), spec(nativeReader("reader-b", "google", dispatched), "google")],
      producer,
    );
    expect([...dispatched, ...producer]).toEqual([]);
    expect(result.lifecycle).toBe("failed");
    expect(failureRecord(result.runDir).phase).toBe("review_preflight");
    expect(result.summary).toContain("reviewer harness 'broken' is unavailable: discovery down");
  });

  it("`reviewDiff` rejects them before any reviewer runs", async () => {
    const blind: HarnessRunSpec[] = [];
    const orchestrator = new Orchestrator({
      registry: new Map(),
      reviewers: [
        spec(nonReadingReviewer("blind-a", "openai", blind), "openai"),
        spec(nonReadingReviewer("blind-b", "google", blind), "google"),
      ],
    });
    await expect(orchestrator.reviewDiff({ repoRoot: committed(), diff: DIFF })).rejects.toThrow(
      `reviewer harness 'blind-a' ${CANNOT_READ}`,
    );
    expect(blind).toEqual([]);
  });

  it("a direct `reviewCandidate` rejects them before writing or running anything", async () => {
    const blind: HarnessRunSpec[] = [];
    const reader: HarnessRunSpec[] = [];
    const call = direct([
      spec(nativeReader("reader-a", "openai", reader), "openai"),
      spec(nonReadingReviewer("blind-b", "google", blind), "google"),
    ]);
    await expect(call.review()).rejects.toThrow(`reviewer harness 'blind-b' ${CANNOT_READ}`);
    expect([...blind, ...reader]).toEqual([]);
    expect(existsSync(join(call.evidenceDir, "DIFF.patch"))).toBe(false);
    expect(existsSync(call.artifactsDir)).toBe(false);
  });

  it("injection stays: custom readers review, verified, with an apply recommendation", async () => {
    const a: HarnessRunSpec[] = [];
    const b: HarnessRunSpec[] = [];
    const reader = counted(nativeReader("reader-a", "openai", a));
    const result = await injected([
      spec(reader.adapter, "openai"),
      spec(nativeReader("reader-b", "google", b), "google"),
    ]);
    expect(a.map((run) => run.intent)).toEqual(["review"]);
    expect(b.map((run) => run.intent)).toEqual(["review"]);
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(result.facts.review).toBe("approved");
    expect(result.reviewVerified).toBe(true);
    const decision = decisionOf(result.runDir);
    expect(decision).toContain("apply_recommendation: apply");
    expect(decision).toContain("verification_basis: cross_family_review");
    // Admitted at preflight; its dispatch does not ask again.
    expect(reader.discovery.calls).toBe(1);
  });

  it("a direct `reviewCandidate` still reviews with readers", async () => {
    const a: HarnessRunSpec[] = [];
    const b: HarnessRunSpec[] = [];
    const result = await direct([
      spec(nativeReader("reader-a", "openai", a), "openai"),
      spec(nativeReader("reader-b", "google", b), "google"),
    ]).review();
    expect(a.map((run) => run.intent)).toEqual(["review"]);
    expect(b.map((run) => run.intent)).toEqual(["review"]);
    expect(result.crossFamilyHealthy).toBe(true);
    expect(result.crossFamilyVerified).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("review off never asks: the same list neither reviews nor refuses the run", async () => {
    const blind: HarnessRunSpec[] = [];
    const producer: HarnessRunSpec[] = [];
    const reviewer = counted(nonReadingReviewer("blind", "openai", blind));
    const result = await injected([spec(reviewer.adapter, "openai")], producer, {
      n: 1,
      review: false,
    });
    expect(blind).toEqual([]);
    expect(reviewer.discovery.calls).toBe(0);
    expect(producer.map((run) => run.intent)).toContain("implement");
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(result.facts.review).toBe("not_run");
  });

  it("a panel's reviewer is not probed again at dispatch: its own discovery is enough", async () => {
    const dispatched: HarnessRunSpec[] = [];
    const a = counted(nativeReader("reader-a", "openai", dispatched));
    const b = counted(nativeReader("reader-b", "google", dispatched));
    const afterPanel = { a: -1, b: -1 };
    const producer = nativeReader("producer", "anthropic", [], (run) => {
      afterPanel.a = a.discovery.calls;
      afterPanel.b = b.discovery.calls;
      writeFileSync(join(run.cwd, "README.md"), "# native\n");
    });
    const result = await new Orchestrator({
      registry: new Map([
        ["producer", producer],
        ["reader-a", a.adapter],
        ["reader-b", b.adapter],
      ]),
      reviewerPanel: [{ harness: "reader-a" }, { harness: "reader-b" }],
    }).run({
      repoRoot: committed(),
      prompt: "Update the heading",
      mode: "agent",
      harnesses: ["producer"],
      n: 1,
      review: true,
    });
    expect(dispatched.map((run) => run.intent)).toEqual(["review", "review"]);
    expect(result.facts.review).toBe("approved");
    expect(afterPanel.a).toBeGreaterThan(0);
    expect(a.discovery.calls).toBe(afterPanel.a);
    expect(b.discovery.calls).toBe(afterPanel.b);
  });
});
