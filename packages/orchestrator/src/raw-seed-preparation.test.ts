// A8: the real candidate/synthesis callers, preparation and disposal. Only the
// seed's update-ref result and the process observations are injected; no stalled
// child is spawned or signalled. Restoring the old post-create seed calls makes
// the base disappear before the scope barrier: the negative control is disk
// custody through the actual finally/dispose path, not just an error field.
// No-abort failures additionally exercise both consumers from the real journal.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetLedger } from "@claudexor/budget";
import { mintRunScopeMarker } from "@claudexor/core";
import type {
  CaptureResult,
  HarnessAdapter,
  PreparationQuietVerdict,
  ScopeReapOutcome,
} from "@claudexor/core";
import { createFakeHarness } from "@claudexor/harness-fake";
import { RuntimeConcurrencyCaps, type RunEvent } from "@claudexor/schema";
import {
  RAW_ACCEPTED_REF,
  rawAcceptedPaths,
  readEnvelopeCustody,
  readEnvelopePreparation,
  releaseEnvelopeBase,
  WorkspaceManager,
} from "@claudexor/workspace";
import { Orchestrator, type OrchestratorResult, type RunInput } from "./orchestrator.js";
import { RawAdoption } from "./rawPatchLane.js";
import { formatRunEventLine } from "../../cli/src/live.js";
import { timelineEvents } from "../../control-api/src/run-timeline.js";

let intercept: ((args: string[]) => Promise<CaptureResult> | undefined) | null = null;
let quiet: PreparationQuietVerdict = { status: "quiet" };
vi.mock("@claudexor/core", async (original) => {
  const core = await original<typeof import("@claudexor/core")>();
  return {
    ...core,
    runCaptureRaw: (cmd: string, args: string[], opts: Parameters<typeof core.runCaptureRaw>[2]) =>
      (cmd === "git" ? intercept?.(args) : undefined) ?? core.runCaptureRaw(cmd, args, opts),
    preparationQuiet: async () => quiet,
  };
});
// Exercise the source preparation owner, including its shared signal/stop types.
vi.mock("@claudexor/workspace", () => import("../../workspace/src/index.js"));

const roots: string[] = [];
afterEach(() => {
  intercept = null;
  quiet = { status: "quiet" };
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-raw-seed-")));
  roots.push(root);
  const repo = join(root, "project");
  mkdirSync(repo);
  const emptyConfig = join(root, "gitconfig");
  writeFileSync(emptyConfig, "");
  for (const [key, value] of Object.entries({
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
    CLAUDEXOR_CONFIG_DIR: join(root, "config"),
  }))
    vi.stubEnv(key, value);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "base\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const tree = git("rev-parse", "HEAD^{tree}");
  git("update-ref", RAW_ACCEPTED_REF, tree);
  return { root, repo, git, tree };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

const scopeEnded: ScopeReapOutcome = {
  coverage: "marker",
  census: "ok",
  censusFailure: null,
  ended: [],
  survivors: [],
  unreadable: [],
  reusedGroups: [],
  settled: true,
  incomplete: false,
  completeness: "complete",
  completenessReason: null,
  restricted: false,
  durationMs: 0,
};

/** Pause at the existing scope owner, after the caller's ordinary cleanup ran. */
function scopeBarrier() {
  const reached = deferred();
  const release = deferred();
  return {
    reached: reached.promise,
    release: release.resolve,
    owner: {
      open: async () => ({ marker: mintRunScopeMarker() }),
      settle: async () => {
        reached.resolve();
        await release.promise;
        return scopeEnded;
      },
    },
  };
}

function editingHarness(seen: string[], raw = false): HarnessAdapter {
  const fake = createFakeHarness("fake-success");
  return {
    ...fake,
    discover: async () => {
      const manifest = await fake.discover();
      return raw
        ? {
            ...manifest,
            capabilities: {
              ...manifest.capabilities,
              implementation_transport: "git_patch_envelope",
            },
            access_profiles_supported: ["readonly"],
          }
        : manifest;
    },
    async *run(spec) {
      seen.push(spec.intent);
      if (raw) throw new Error("raw model must not start after failed seed");
      expect(await rawAcceptedPaths(spec.cwd, "HEAD")).toEqual(["README.md"]);
      writeFileSync(join(spec.cwd, "edit.txt"), `${seen.length}\n`);
      yield* fake.run(spec);
    },
  };
}

const events = (result: OrchestratorResult): RunEvent[] =>
  readFileSync(join(result.runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RunEvent);

const callers = [
  { name: "candidate race", target: "a01", raw: false, n: 2, proveAtBarrier: true },
  {
    name: "raw singleton with continuation custody",
    target: "a01",
    raw: true,
    n: 1,
    proveAtBarrier: true,
  },
  { name: "synthesis", target: "synth", raw: false, n: 2, proveAtBarrier: true },
  {
    name: "candidate held past settlement",
    target: "a01",
    raw: false,
    n: 2,
    proveAtBarrier: false,
  },
] as const;

describe("raw seed stays under envelope preparation (A8)", () => {
  for (const ending of ["confirmed Stop", "unconfirmed Stop", "no-abort failure"] as const) {
    const confirmed = ending === "confirmed Stop";
    const stopped = ending !== "no-abort failure";
    it.each(callers)(
      `$name: ${ending} owns the base and discloses its state at each event`,
      async ({ target, raw, n, proveAtBarrier }) => {
        const w = world();
        const stop = new AbortController();
        const barrier = scopeBarrier();
        const seen: string[] = [];
        const harness = editingHarness(seen, raw);
        const reserve = vi.spyOn(BudgetLedger.prototype, "reserve");
        const cancel = vi.spyOn(BudgetLedger.prototype, "cancel");
        const settle = vi.spyOn(BudgetLedger.prototype, "settle");
        const dispose = vi.spyOn(WorkspaceManager.prototype, "dispose"); // calls through
        let base = "";
        let preparingAtSeed: boolean | undefined;
        intercept = (args) => {
          const cwd = args[args.indexOf("-C") + 1]!;
          if (
            base ||
            !args.includes("update-ref") ||
            !args.includes("--stdin") ||
            basename(cwd) !== "tree" ||
            basename(dirname(cwd)) !== target
          )
            return undefined;
          base = dirname(cwd);
          preparingAtSeed = readEnvelopePreparation(base)?.preparing;
          if (stopped) stop.abort("stop during raw seed");
          if (!confirmed)
            quiet = { status: "held", reasons: ["injected seed descendant is alive"] };
          return Promise.resolve({
            code: null,
            signal: "SIGTERM",
            stdout: "",
            stderr: "",
            termination: confirmed
              ? { status: "confirmed", proof: "group_empty" }
              : {
                  status: "unconfirmed",
                  reason: "output_held",
                  rootPid: 4242,
                  groups: [4242],
                  directExited: true,
                  directExitObservedAt: Date.now(),
                  directExit: Promise.resolve(),
                },
          });
        };
        const run = new Orchestrator({
          registry: new Map([[harness.id, harness]]),
          reviewers: [],
          runtimeConcurrencyCaps: RuntimeConcurrencyCaps.parse({ max_parallel_candidates: 1 }),
          runScopes: barrier.owner,
        }).run({
          repoRoot: w.repo,
          prompt: "edit",
          mode: "agent",
          harnesses: [harness.id],
          inPlace: true,
          n,
          synthesis: target === "synth" ? "always" : "never",
          paidBudget: { kind: "unlimited" },
          signal: stop.signal,
          ...(raw ? { continuation: { retain: true } } : {}),
        });
        let result: OrchestratorResult;
        try {
          await Promise.race([
            barrier.reached,
            run.then(() => {
              throw new Error("run finished before its scope barrier");
            }),
          ]);
          expect(base).not.toBe("");
          // This is the A8 negative-control assertion: old finally/dispose deletes it.
          if (!confirmed) {
            expect(existsSync(join(base, "tree", "README.md"))).toBe(true);
            expect(readEnvelopePreparation(base)).toMatchObject({
              preparing: true,
              held: { reason: "output_held" },
            });
            expect(readEnvelopeCustody(base)).toBeNull(); // no premature continuation owner
            expect(await releaseEnvelopeBase(base)).toBe(false);
          }
          expect(preparingAtSeed).toBe(true);
          expect(dispose.mock.calls.some(([env]) => dirname(env.worktree_path) === base)).toBe(
            false,
          );
          expect(stop.signal.aborted).toBe(stopped);
          expect(seen).toEqual(
            target === "synth" ? ["implement", "implement"] : stopped || raw ? [] : ["implement"],
          );
          // The existing barrier receives proof of the end, then runs its queued release.
          if (confirmed || proveAtBarrier) quiet = { status: "quiet" };
        } finally {
          barrier.release();
          result = await run;
        }
        // A failed optional synthesis / one failed race slot does not cancel or
        // fail the working candidate; the failed raw singleton has no survivor.
        expect(result.lifecycle).toBe(stopped ? "cancelled" : raw ? "failed" : "succeeded");
        expect(w.git("rev-parse", RAW_ACCEPTED_REF)).toBe(w.tree);
        const all = events(result);
        const terminalEvent = all.find(
          (e) => e.type === "run.failed" || e.type === "run.completed",
        )!;
        const terminal = terminalEvent.payload;
        if (confirmed) {
          expect(terminal).not.toHaveProperty("held");
          expect(terminal).not.toHaveProperty("termination_unconfirmed");
        } else if (proveAtBarrier) {
          expect(terminal).toMatchObject({
            held: [],
            termination_unconfirmed: { reason: "output_held" },
          });
        }
        if (!confirmed && !proveAtBarrier) {
          expect(existsSync(base)).toBe(true);
          expect(terminal).toMatchObject({
            held: [base],
            termination_unconfirmed: { reason: "output_held" },
          });
          expect(await releaseEnvelopeBase(base)).toBe(false);
          quiet = { status: "quiet" };
          expect(await releaseEnvelopeBase(base)).toBe(true); // later sweep's same owner
        }
        expect(existsSync(base)).toBe(false);
        const completedEvent = all.find(
          (e) => e.type === "harness.completed" && e.payload["attempt_id"] === target,
        )!;
        const completed = completedEvent.payload;
        expect(completed).toMatchObject({
          status: stopped ? "cancelled" : "failed",
          phase: "workspace",
        });
        if (confirmed) {
          expect(completed).not.toHaveProperty("held");
          expect(completed).not.toHaveProperty("termination_unconfirmed");
        } else {
          expect(completed).toMatchObject({
            held: [base],
            termination_unconfirmed: { reason: "output_held" },
          });
        }
        if (!stopped) {
          const message = "git update-ref was stopped at its time bound; its end is unconfirmed";
          expect(completed["error"]).toBe(message);
          expect(formatRunEventLine(completedEvent)).toContain(`completed: failed — ${message}`);
          // Positive consumer control: the same canonical events reach CLI and
          // the Control timeline. A later release never rewrites the attempt.
          for (const event of [completedEvent, terminalEvent]) {
            const cli = formatRunEventLine(event)!;
            const [row] = timelineEvents({}, [event]);
            for (const text of [cli, row!.detail!]) {
              expect(text).toContain("Termination unconfirmed at this event (output_held)");
              expect(text).toContain("claudexor gc preparations");
              if (event === completedEvent || !proveAtBarrier)
                expect(text).toContain(`Held paths at this event: ${JSON.stringify(base)}`);
              else {
                expect(text).toContain("No held paths reported in this event");
                expect(text).not.toContain(base);
              }
            }
            if (event === completedEvent) {
              expect(row).toMatchObject({ severity: "error", title: message });
              expect(row!.detail).toContain(message);
            }
            // Negative consumer control: the old producers' same failure text
            // without structured facts does not produce a custody warning.
            const legacyPayload = { ...event.payload };
            delete legacyPayload["termination_unconfirmed"];
            delete legacyPayload["held"];
            const legacy = { ...event, payload: legacyPayload };
            expect(formatRunEventLine(legacy)).not.toContain("gc preparations");
            expect(timelineEvents({}, [legacy])[0]!.detail ?? "").not.toContain("gc preparations");
          }
          expect(events(result).find((e) => e.seq === completedEvent.seq)).toEqual(completedEvent);
          expect(events(result).find((e) => e.seq === terminalEvent.seq)).toEqual(terminalEvent);
        }
        expect(
          all.some((e) => e.type === "harness.started" && e.payload["attempt_id"] === target),
        ).toBe(false);
        const reserved =
          reserve.mock.results[reserve.mock.calls.findIndex(([r]) => r.attemptId === target)]!;
        expect(reserved.type).toBe("return");
        if (reserved.type !== "return" || !reserved.value.lease)
          throw new Error("the stopped preparation had no granted lease");
        const leaseId = reserved.value.lease.lease_id;
        if (stopped) {
          expect(cancel).toHaveBeenCalledWith(leaseId);
          expect(settle.mock.calls.some(([id]) => id === leaseId)).toBe(false);
        } else {
          expect(cancel).not.toHaveBeenCalledWith(leaseId);
          const settlements = settle.mock.calls.filter(([id]) => id === leaseId);
          expect(settlements).toHaveLength(1);
          const source = target === "synth" ? "synthesis-error" : "post-stream-error";
          expect(settlements[0]![1]).toEqual({
            knowledge: "unknown",
            source,
            provenance: [`orchestrator:${source}`],
            // The candidate's existing scalar fallback stays UNKNOWN, not a
            // newly claimed zero-cost cancellation; synthesis has no scalar.
            ...(target === "synth" ? {} : { cashUsd: 0 }),
          });
        }
        if (stopped && target === "a01")
          for (const reservation of reserve.mock.results)
            if (reservation.type === "return" && reservation.value.granted)
              expect(cancel).toHaveBeenCalledWith(reservation.value.lease!.lease_id);
        expect(all.filter((e) => e.type === "budget.cash")).toHaveLength(
          stopped ? (target === "synth" ? 2 : 0) : target === "synth" ? 3 : n,
        );
      },
      120_000,
    );
  }

  it("an ordinary seed error fails before the model and still cleans the base", async () => {
    const w = world();
    const seen: string[] = [];
    const harness = editingHarness(seen, true);
    const reserve = vi.spyOn(BudgetLedger.prototype, "reserve");
    const cancel = vi.spyOn(BudgetLedger.prototype, "cancel");
    const settle = vi.spyOn(BudgetLedger.prototype, "settle");
    const barrier = scopeBarrier();
    barrier.release();
    let base = "";
    intercept = (args) => {
      if (!args.includes("update-ref") || !args.includes("--stdin")) return undefined;
      base = dirname(args[args.indexOf("-C") + 1]!);
      return Promise.resolve({ code: 1, signal: null, stdout: "", stderr: "injected seed error" });
    };
    const result = await new Orchestrator({
      registry: new Map([[harness.id, harness]]),
      reviewers: [],
      runScopes: barrier.owner,
    }).run({
      repoRoot: w.repo,
      prompt: "edit",
      mode: "agent",
      harnesses: [harness.id],
      inPlace: true,
      n: 1,
      paidBudget: { kind: "unlimited" },
    });
    expect(base).not.toBe("");
    expect(seen).toEqual([]);
    expect(existsSync(base)).toBe(false);
    expect(result.lifecycle).toBe("failed");
    const all = events(result);
    expect(all.some((event) => event.type === "harness.started")).toBe(false);
    expect(all.find((event) => event.type === "harness.completed")?.payload).toMatchObject({
      attempt_id: "a01",
      status: "failed",
      phase: "workspace",
      error: expect.stringContaining("injected seed error"),
    });
    for (const event of all) {
      expect(event.payload).not.toHaveProperty("termination_unconfirmed");
      expect(event.payload).not.toHaveProperty("held");
      expect(formatRunEventLine(event) ?? "").not.toContain("gc preparations");
    }
    expect(timelineEvents({}, all).every((row) => !row.detail?.includes("gc preparations"))).toBe(
      true,
    );
    const reserved = reserve.mock.results[0]!;
    if (reserved.type !== "return" || !reserved.value.lease) throw new Error("no granted lease");
    const leaseId = reserved.value.lease.lease_id;
    expect(cancel).not.toHaveBeenCalledWith(leaseId);
    expect(settle.mock.calls.filter(([id]) => id === leaseId)).toEqual([
      [
        leaseId,
        {
          knowledge: "unknown",
          source: "post-stream-error",
          provenance: ["orchestrator:post-stream-error"],
          cashUsd: 0,
        },
      ],
    ]);
  });

  it.each(["a01", "synth"])(
    "post-dispatch %s failure keeps settled usage and is not a preparation disclosure",
    async (target) => {
      const w = world();
      const seen: string[] = [];
      const fake = editingHarness(seen);
      const harness: HarnessAdapter = {
        ...fake,
        async *run(spec) {
          for await (const event of fake.run(spec))
            yield { ...event, credential_route: "managed_api_key" as const };
        },
      };
      const reserve = vi.spyOn(BudgetLedger.prototype, "reserve");
      const cancel = vi.spyOn(BudgetLedger.prototype, "cancel");
      const settle = vi.spyOn(BudgetLedger.prototype, "settle");
      const keep = RawAdoption.prototype.keep;
      let base = "";
      const message = "injected post-dispatch failure with unconfirmed termination";
      vi.spyOn(RawAdoption.prototype, "keep").mockImplementation(async function (
        this: RawAdoption,
        attemptId,
        tree,
      ) {
        if (attemptId !== target) return keep.call(this, attemptId, tree);
        base = dirname(tree);
        expect(seen).toContain(target === "synth" ? "synthesize" : "implement");
        expect(readEnvelopePreparation(base)?.preparing).toBe(false);
        // Same structured error, but thrown AFTER the fake stream and settlement.
        // Copying its fields as preparation facts would be a false custody claim.
        throw Object.assign(new Error(message), {
          heldBase: base,
          termination: {
            status: "unconfirmed",
            reason: "output_held",
            rootPid: 4242,
            groups: [4242],
            directExited: true,
            directExit: Promise.resolve(),
          },
        });
      });
      const barrier = scopeBarrier();
      barrier.release();
      const result = await new Orchestrator({
        registry: new Map([[harness.id, harness]]),
        reviewers: [],
        runtimeConcurrencyCaps: RuntimeConcurrencyCaps.parse({ max_parallel_candidates: 1 }),
        runScopes: barrier.owner,
      }).run({
        repoRoot: w.repo,
        prompt: "edit",
        mode: "agent",
        harnesses: [harness.id],
        inPlace: true,
        n: 2,
        synthesis: target === "synth" ? "always" : "never",
        paidBudget: { kind: "unlimited" },
      });
      expect(base).not.toBe("");
      expect(existsSync(base)).toBe(false);
      expect(result.lifecycle).toBe("succeeded"); // a working candidate still stands
      const all = events(result);
      const failure = all.find(
        (e) => e.type === "harness.completed" && e.payload["error"] === message,
      )!;
      expect(failure.payload).toMatchObject({
        attempt_id: target,
        status: "failed",
        phase: "harness",
      });
      for (const event of all) {
        expect(event.payload).not.toHaveProperty("termination_unconfirmed");
        expect(event.payload).not.toHaveProperty("held");
        expect(formatRunEventLine(event) ?? "").not.toContain("gc preparations");
      }
      expect(timelineEvents({}, all).every((row) => !row.detail?.includes("gc preparations"))).toBe(
        true,
      );
      const reserved =
        reserve.mock.results[reserve.mock.calls.findIndex(([r]) => r.attemptId === target)]!;
      if (reserved.type !== "return" || !reserved.value.lease) throw new Error("no granted lease");
      const leaseId = reserved.value.lease.lease_id;
      expect(cancel).not.toHaveBeenCalledWith(leaseId);
      // The later catch's existing fallback remains idempotent: no second debit
      // and no rewrite of the usage already settled from the completed stream.
      expect(settle.mock.calls.filter(([id]) => id === leaseId)).toEqual([
        [
          leaseId,
          expect.objectContaining({
            knowledge: "exact",
            cashUsd: 0.01,
            source: "harness-usage-by-route",
          }),
        ],
        [
          leaseId,
          expect.objectContaining({
            knowledge: "unknown",
            source: target === "synth" ? "synthesis-error" : "post-stream-error",
          }),
        ],
      ]);
      expect(result.spendUsd).toBeCloseTo(target === "synth" ? 0.03 : 0.02);
      expect(all.filter((e) => e.type === "budget.cash")).toHaveLength(target === "synth" ? 3 : 2);
    },
    120_000,
  );

  it("control: healthy candidates and synthesis inherit membership before running and are disposed", async () => {
    const w = world();
    const seen: string[] = [];
    const harness = editingHarness(seen);
    const dispose = vi.spyOn(WorkspaceManager.prototype, "dispose");
    const barrier = scopeBarrier();
    barrier.release();
    const input: RunInput = {
      repoRoot: w.repo,
      prompt: "edit",
      mode: "agent",
      harnesses: [harness.id],
      inPlace: true,
      n: 2,
      synthesis: "always",
      paidBudget: { kind: "unlimited" },
    };
    const result = await new Orchestrator({
      registry: new Map([[harness.id, harness]]),
      reviewers: [],
      runtimeConcurrencyCaps: RuntimeConcurrencyCaps.parse({ max_parallel_candidates: 1 }),
      runScopes: barrier.owner,
    }).run(input);
    expect(seen).toEqual(["implement", "implement", "synthesize"]);
    expect(result.lifecycle).toBe("succeeded");
    const disposed = dispose.mock.calls.map(([env]) => env);
    expect(disposed.map((env) => env.attempt_id).sort()).toEqual(["a01", "a02", "synth"]);
    for (const env of disposed) expect(existsSync(env.worktree_path)).toBe(false);
  }, 120_000);
});
