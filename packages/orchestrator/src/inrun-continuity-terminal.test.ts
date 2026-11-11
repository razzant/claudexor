import { describe, expect, it, vi } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConformanceReport, HarnessManifest, type QuotaSnapshot } from "@claudexor/schema";
import { Orchestrator } from "./orchestrator.js";
import { ArtifactStore } from "@claudexor/artifact-store";
import { run, seedSession, limit, crash } from "./inrun-continuity.test-support.js";

describe("unfinished terminal facts", () => {
  it.each(["agent", "ask"] as const)(
    "%s clears a prior account's limit from a transport terminal",
    async (mode) => {
      const o = await run({
        mode,
        profiles: ["a", "b"],
        script: function* ({ profile, spec, emit }) {
          if (profile === "a") seedSession(spec.cwd, "a", "sid-limit");
          yield emit({ type: "started", payload: { native_session_id: "sid-limit" } });
          if (profile === "a") {
            yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
            yield* limit(emit);
          } else yield* crash(emit);
        },
      });
      expect(o.resumable).toMatchObject({
        cause: "transport",
        resetsAt: null,
        limitWindow: null,
        limitEvidence: null,
        limitCode: null,
      });
    },
  );

  it("cancelled Ask after progress exposes its continuation and surviving execution root", async () => {
    const stop = new AbortController();
    const o = await run({
      mode: "ask",
      profiles: ["a"],
      input: { signal: stop.signal },
      script: function* ({ emit, spec }) {
        seedSession(spec.cwd, "a", "sid-cancel");
        yield emit({ type: "started", payload: { native_session_id: "sid-cancel" } });
        yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
        stop.abort("user_cancelled");
        yield emit({ type: "completed", aborted: true });
      },
    });
    expect(o.result.lifecycle).toBe("cancelled");
    expect(o.spawns).toHaveLength(1);
    expect(o.resumable).toMatchObject({
      cause: "cancelled",
      workspace: { kind: "in_place", root: o.root },
    });
    expect(
      new ArtifactStore(o.root).readYaml(join(o.result.runDir, "final", "resumable.yaml")),
    ).toEqual(o.resumable);
  });

  it("failed project Ask retains its execution root", async () => {
    const o = await run({
      mode: "ask",
      profiles: ["a"],
      maxRetries: 0,
      script: function* ({ emit }) {
        yield emit({ type: "started", payload: { native_session_id: "sid-root" } });
        yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
        yield* crash(emit);
      },
    });
    expect(o.resumable).toMatchObject({ workspace: { kind: "in_place", root: o.root } });
  });

  it.each([false, true])(
    "a failed gate after a completed edit is continuable (convergence=%s)",
    async (convergence) => {
      const o = await run({
        mode: "agent",
        profiles: ["a"],
        input: {
          ...(convergence ? { attempts: 1 } : {}),
          tests: [{ program: "sh", args: ["-c", "exit 3"], envAllowlist: [] }],
        },
        script: function* ({ emit, spec }) {
          yield emit({ type: "started", payload: { native_session_id: "sid-gate" } });
          writeFileSync(join(spec.cwd, "edited.txt"), "unfinished change\n");
          yield emit({ type: "file_change", payload: { path: "edited.txt" } });
          yield emit({ type: "message", text: "edited", final: true });
          yield emit({ type: "completed" });
        },
      });
      expect(o.result.facts.checks).toBe("failed");
      expect(o.resumable).toMatchObject({
        cause: "other",
        session: { nativeSessionId: "sid-gate" },
        workspace: { kind: "in_place", root: o.root },
      });
      expect(existsSync(join(o.result.runDir, "final", "resumable.yaml"))).toBe(true);
    },
  );

  it("a hard budget cap stops a zero-cash route without preparing another try", async () => {
    const o = await run({
      mode: "agent",
      profiles: ["a"],
      input: { paidBudget: { kind: "finite", maxUsd: 0.05 } },
      script: function* ({ emit, spec }) {
        seedSession(spec.cwd, "a", "sid-budget");
        yield emit({ type: "started", payload: { native_session_id: "sid-budget" } });
        yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
        yield emit({
          type: "usage",
          usage: { cost_usd: 2, cost_basis: { kind: "cash", source: "fixture" } },
        });
        yield emit({ type: "completed" });
      },
    });
    expect(
      o.events.some(
        (e) =>
          e.type === "budget.observation" && e.payload["detail"] === "hard cap mid-flight abort",
      ),
    ).toBe(true);
    expect(o.spawns).toHaveLength(1);
    expect(o.receipts).toHaveLength(0);
    expect(o.resumable?.["cause"]).toBe("other");
  });
});

it("a succeeded best-of run carries no losing candidate's continuation facts", async () => {
  const o = await run({
    mode: "agent",
    profiles: ["a"],
    input: {
      n: 2,
      review: true,
      paidBudget: { kind: "finite", maxUsd: 10 },
      tests: [{ program: "sh", args: ["-c", "test -f good.txt"], envAllowlist: [] }],
    },
    reviewers: [
      {
        providerFamily: "openai",
        adapter: {
          id: "clean-reviewer",
          async discover() {
            return HarnessManifest.parse({
              id: "clean-reviewer",
              display_name: "clean reviewer",
              kind: "local_cli",
              provider_family: "openai",
              capabilities: { review: true, read_files: true },
            });
          },
          async doctor() {
            return ConformanceReport.parse({
              harness_id: "clean-reviewer",
              status: "ok",
              enabled_intents: ["review"],
            });
          },
          async *run(spec) {
            const base = { session_id: spec.session_id, ts: new Date().toISOString() };
            yield { ...base, type: "started", credential_route: "managed_api_key" };
            yield { ...base, type: "message", text: "[]" };
            yield {
              ...base,
              type: "usage",
              credential_route: "managed_api_key",
              usage: { cost_usd: 0.001 },
            };
            yield { ...base, type: "completed" };
          },
        },
      },
    ],
    script: function* ({ emit, spec, tryOfProfile }) {
      yield emit({ type: "started", payload: { native_session_id: `sid-cand-${tryOfProfile}` } });
      const file = tryOfProfile === 1 ? "bad.txt" : "good.txt";
      writeFileSync(join(spec.cwd, file), "candidate\n");
      yield emit({ type: "file_change", payload: { path: file } });
      yield emit({ type: "message", text: "done", final: true });
      yield emit({ type: "completed" });
    },
  });
  expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
  expect(o.resumable).toBeUndefined();
  expect(existsSync(join(o.result.runDir, "final", "resumable.yaml"))).toBe(false);
});

it("pool-exhausted resumable uses the same folded earliest reset as failure.yaml", async () => {
  const snapshots: QuotaSnapshot[] = [];
  // Future resets: an elapsed window is no longer evidence at the decision (#457).
  const early = new Date(Date.now() + 3_600_000).toISOString(),
    late = new Date(Date.now() + 7_200_000).toISOString();
  const o = await run({
    mode: "ask",
    profiles: ["a", "b"],
    snapshots,
    script: function* ({ profile, emit, spec }) {
      if (profile === "a") {
        seedSession(spec.cwd, "a", "sid-pool");
        snapshots.push({
          subject: {
            harness: "fake",
            credential_route: "vendor_native",
            plan_label: null,
            subject_id: "a",
          },
          constraints: [
            {
              id: "five_hour",
              label: "5 hour",
              used_ratio: 1,
              window_seconds: 18000,
              resets_at: early,
              cooldown_until: null,
            },
          ],
          source: "claude_oauth_usage",
          observed_at: new Date().toISOString(),
          freshness: "fresh",
        } as QuotaSnapshot);
      }
      yield emit({ type: "started", payload: { native_session_id: "sid-pool" } });
      yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
      yield* limit(emit, profile === "a" ? early : late);
    },
  });
  expect(o.result.lifecycle).toBe("failed");
  expect(
    new ArtifactStore(o.root).readYaml(join(o.result.runDir, "final", "failure.yaml")),
  ).toMatchObject({ resetsAt: early });
  expect(o.resumable).toMatchObject({ cause: "pool_exhausted", resetsAt: early });
});

it("review failure after clean execution still carries continuation facts", async () => {
  const o = await run({
    mode: "agent",
    profiles: ["a"],
    input: { review: true, paidBudget: { kind: "finite", maxUsd: 10 } },
    reviewers: [
      {
        providerFamily: "openai",
        adapter: {
          id: "fixture-reviewer",
          async discover() {
            return HarnessManifest.parse({
              id: "fixture-reviewer",
              display_name: "fixture reviewer",
              kind: "local_cli",
              provider_family: "openai",
              capabilities: { review: true, read_files: true },
            });
          },
          async doctor() {
            return ConformanceReport.parse({
              harness_id: "fixture-reviewer",
              status: "ok",
              enabled_intents: ["review"],
            });
          },
          async *run(spec) {
            const base = { session_id: spec.session_id, ts: new Date().toISOString() };
            yield {
              ...base,
              type: "started",
              observed_model: "review-model",
              credential_route: "managed_api_key",
            };
            yield {
              ...base,
              type: "message",
              text: JSON.stringify([
                {
                  severity: "NEEDS_HUMAN",
                  category: "spec_gap",
                  claim: "The unfinished edit needs review.",
                  evidence: { files: [{ path: "README.md" }] },
                  proposed_fix: "Complete the change.",
                },
              ]),
            };
            yield {
              ...base,
              type: "usage",
              credential_route: "managed_api_key",
              usage: { cost_usd: 0.001 },
            };
            yield { ...base, type: "completed" };
          },
        },
      },
    ],
    script: function* ({ spec, emit }) {
      yield emit({ type: "started", payload: { native_session_id: "sid-review" } });
      writeFileSync(join(spec.cwd, "README.md"), "review needed\n");
      yield emit({ type: "file_change", payload: { path: "README.md" } });
      yield emit({ type: "message", text: "edited", final: true });
      yield emit({ type: "completed" });
    },
  });
  expect(o.spawns).toHaveLength(1);
  expect(o.result.facts.review).toBe("blocked");
  expect(o.resumable).toMatchObject({ cause: "other", session: { nativeSessionId: "sid-review" } });
});

it("review preflight failure after a completed harness try preserves continuation", async () => {
  const preflight = vi
    .spyOn(
      Orchestrator.prototype as unknown as { prepareReviewEvidenceDir(): string },
      "prepareReviewEvidenceDir",
    )
    .mockImplementationOnce(() => {
      throw new Error("fixture evidence unavailable");
    });
  try {
    const o = await run({
      mode: "agent",
      profiles: ["a"],
      input: { review: true },
      script: function* ({ spec, emit }) {
        yield emit({ type: "started", payload: { native_session_id: "sid-review-failure" } });
        writeFileSync(join(spec.cwd, "README.md"), "unfinished edit\n");
        yield emit({ type: "file_change", payload: { path: "README.md" } });
        yield emit({ type: "message", text: "edited", final: true });
        yield emit({ type: "completed" });
      },
    });
    expect(o.result.lifecycle).toBe("failed");
    expect(o.spawns).toHaveLength(1);
    expect(o.resumable).toMatchObject({
      cause: "other",
      session: { nativeSessionId: "sid-review-failure" },
    });
  } finally {
    preflight.mockRestore();
  }
});
