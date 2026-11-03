import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  HOME_SCOPED_ENV,
  isRunScopeMarkerName,
  mintRunScopeMarker,
  runCapture,
  spawnProcess,
  type HarnessAdapter,
  type ScopeReapOutcome,
  type ScopeReapOptions,
} from "@claudexor/core";
import {
  ConformanceReport,
  HarnessManifest,
  RunProcessScopeOutcome,
  type HarnessRunSpec,
  type ProviderFamily,
} from "@claudexor/schema";
import type { ReviewerSpec } from "@claudexor/review";
import { ArtifactStore } from "@claudexor/artifact-store";
import { projectRuntimeDir } from "@claudexor/util";
import { Orchestrator } from "./orchestrator.js";
import {
  type RunScopeCustodian,
  createInProcessRunScopeCustodian,
  failedScopeOutcome,
  inProcessRunScopeCustodian,
  scopedSpecEnv,
} from "./runScope.js";

const reapDirs: string[] = [];
afterAll(() => {
  for (const dir of reapDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

async function initRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "claudexor-scope-"));
  reapDirs.push(repo);
  await runCapture("git", ["-C", repo, "init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  await runCapture("git", ["-C", repo, "add", "-A"]);
  await runCapture("git", [
    "-C",
    repo,
    "-c",
    "user.email=t@t.dev",
    "-c",
    "user.name=t",
    "commit",
    "-m",
    "init",
  ]);
  return repo;
}

/** An implementer that records every spec env it was launched with. */
function recordingImplementer(
  id: string,
  seen: HarnessRunSpec["env"][],
  body?: (spec: HarnessRunSpec) => AsyncGenerator<void>,
): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "local",
        capabilities: { implement: true },
        access_profiles_supported: ["workspace_write", "full"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["implement"],
      });
    },
    async *run(spec) {
      seen.push(spec.env);
      const ts = new Date().toISOString();
      yield {
        type: "started",
        session_id: spec.session_id,
        ts,
        credential_route: "managed_api_key",
      };
      if (body) for await (const _ of body(spec)) void _;
      writeFileSync(join(spec.cwd, "CHANGED.txt"), "real change\n");
      yield { type: "message", session_id: spec.session_id, ts, text: "Implemented." };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
}

function recordingReviewer(
  id: string,
  family: ProviderFamily,
  seen: HarnessRunSpec["env"][],
): ReviewerSpec {
  const adapter: HarnessAdapter = {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: family,
        capabilities: { review: true, read_files: true },
      });
    },
    async doctor() {
      return ConformanceReport.parse({ harness_id: id, status: "ok", enabled_intents: ["review"] });
    },
    async *run(spec) {
      seen.push(spec.env);
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
  return { adapter, providerFamily: family };
}

function markerOf(env: HarnessRunSpec["env"] | undefined): string | undefined {
  return Object.keys(env ?? {}).find((key) => isRunScopeMarkerName(key) && env?.[key] === "1");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

describe("scopedSpecEnv", () => {
  const source = { HOME: "/Users/op", PATH: "/usr/bin" };
  it("adds the marker last and the host facts only for a scoped HOME, never rewriting the patch", () => {
    const marker = mintRunScopeMarker();
    const scoped = scopedSpecEnv(marker, { HOME: "/tmp/scoped", CODEX_HOME: "/x" }, { source });
    expect(scoped).toMatchObject({ HOME: "/tmp/scoped", CODEX_HOME: "/x", [marker]: "1" });
    expect(scoped?.[HOME_SCOPED_ENV]).toBe("1");
    const inPlace = scopedSpecEnv(marker, undefined, { source });
    expect(inPlace).toEqual({ [marker]: "1" });
    expect(scopedSpecEnv(undefined, { HOME: "/tmp/scoped" }, { source })).toEqual({
      HOME: "/tmp/scoped",
    });
  });
});

describe("Orchestrator run scope (item 1-2)", () => {
  it("mints ONE marker per run before the first launch, carries it in every candidate and reviewer env, and settles once at the end", async () => {
    const repo = await initRepo();
    const seen: HarnessRunSpec["env"][] = [];
    const reviewerSeen: HarnessRunSpec["env"][] = [];
    const calls: string[] = [];
    const custodian: RunScopeCustodian = {
      async open(runId) {
        calls.push(`open:${runId}`);
        const { marker } = await inProcessRunScopeCustodian.open(runId);
        return { marker };
      },
      async settle(runId, marker) {
        calls.push(`settle:${runId}`);
        return inProcessRunScopeCustodian.settle(runId, marker);
      },
    };
    const registry = new Map<string, HarnessAdapter>([
      [
        "impl",
        recordingImplementer("impl", seen, async function* () {
          calls.push("launch");
        }),
      ],
    ]);
    const res = await new Orchestrator({
      registry,
      runScopes: custodian,
      reviewers: [recordingReviewer("rev-a", "openai", reviewerSeen)],
    }).run({ repoRoot: repo, prompt: "do it", mode: "agent", harnesses: ["impl"], n: 2 });
    expect(res.lifecycle).toBe("succeeded");
    // Order: open, then every launch, then exactly one settle.
    expect(calls[0]).toMatch(/^open:/);
    expect(calls.filter((c) => c === "launch")).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith("settle:"))).toHaveLength(1);
    expect(calls.at(-1)).toMatch(/^settle:/);
    const markers = new Set(seen.map(markerOf));
    expect(markers.size).toBe(1);
    const [marker] = [...markers];
    expect(marker).toBeDefined();
    expect(reviewerSeen.length).toBeGreaterThan(0);
    for (const env of reviewerSeen) {
      expect(markerOf(env)).toBe(marker);
      // The reviewer runs under a scoped scratch HOME: it is told so.
      expect(env?.[HOME_SCOPED_ENV]).toBe("1");
    }
    const factsPath = join(res.runDir, "final", "process_scope.yaml");
    expect(existsSync(factsPath)).toBe(true);
    const facts = RunProcessScopeOutcome.parse(new ArtifactStore(repo).readYaml(factsPath));
    expect(facts.marker).toBe(marker);
    expect(facts.coverage).toBe("marker");
  }, 60_000);

  it("settles the scope exactly once even when the strategy fails", async () => {
    const repo = await initRepo();
    const calls: string[] = [];
    const custodian: RunScopeCustodian = {
      async open(runId) {
        calls.push("open");
        return inProcessRunScopeCustodian.open(runId);
      },
      async settle(runId, marker) {
        calls.push("settle");
        return inProcessRunScopeCustodian.settle(runId, marker);
      },
    };
    const failing: HarnessAdapter = {
      ...recordingImplementer("boom", []),
      // eslint-disable-next-line require-yield
      async *run() {
        throw new Error("vendor exploded");
      },
    };
    const res = await new Orchestrator({
      registry: new Map([["boom", failing]]),
      runScopes: custodian,
    }).run({ repoRoot: repo, prompt: "do it", mode: "agent", harnesses: ["boom"], n: 1 });
    expect(res.lifecycle).not.toBe("succeeded");
    expect(calls).toEqual(["open", "settle"]);
  }, 60_000);

  it.runIf(process.platform !== "win32")(
    "ends a reparented grandchild the harness left behind at the whole-run barrier and records it as ended",
    async () => {
      const repo = await initRepo();
      let orphan = 0;
      const outcomes: ScopeReapOutcome[] = [];
      const custodian: RunScopeCustodian = {
        open: (runId) => inProcessRunScopeCustodian.open(runId),
        async settle(runId, marker) {
          const outcome = await inProcessRunScopeCustodian.settle(runId, marker);
          outcomes.push(outcome);
          return outcome;
        },
      };
      // A real harness process (node) that starts a detached node grandchild
      // carrying the inherited env and exits — the #449 orphan shape with an
      // env-visible leftover; the platform-binary shape is covered in core by
      // the capture path, which the daemon index provides.
      const script =
        "const {spawn}=require('node:child_process');" +
        "const c=spawn(process.execPath,['-e','setTimeout(()=>{},600000)'],{detached:true,stdio:'ignore',env:process.env});" +
        "c.unref();console.log('orphan:'+c.pid);";
      const impl = recordingImplementer("impl", [], async function* (spec) {
        for await (const ev of spawnProcess(process.execPath, ["-e", script], {
          env: spec.env,
          cwd: spec.cwd,
        })) {
          if (ev.type === "stdout" && ev.line.startsWith("orphan:"))
            orphan = Number(ev.line.slice(7));
        }
        yield;
      });
      try {
        const res = await new Orchestrator({
          registry: new Map([["impl", impl]]),
          runScopes: custodian,
        }).run({ repoRoot: repo, prompt: "do it", mode: "agent", harnesses: ["impl"], n: 1 });
        expect(res.lifecycle).toBe("succeeded");
        expect(orphan).toBeGreaterThan(0);
        expect(alive(orphan)).toBe(false);
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]!.ended.map((m) => m.pid)).toContain(orphan);
        expect(outcomes[0]!.settled).toBe(true);
        const facts = RunProcessScopeOutcome.parse(
          new ArtifactStore(repo).readYaml(join(res.runDir, "final", "process_scope.yaml")),
        );
        expect(facts.ended.map((m) => m.pid)).toContain(orphan);
      } finally {
        if (orphan) {
          try {
            process.kill(orphan, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
    },
    60_000,
  );
});

describe("Orchestrator run scope: deterministic gates", () => {
  it.runIf(process.platform !== "win32")(
    "ends what candidate gates and the winner's final verification leave running, at the whole-run barrier",
    async () => {
      const repo = await initRepo();
      const dir = mkdtempSync(join(tmpdir(), "claudexor-gate-leftover-"));
      reapDirs.push(dir);
      const ledger = join(dir, "leftovers.txt");
      // An ordinary configured gate that starts a background server and passes.
      const gate =
        "const {spawn}=require('node:child_process');" +
        "const c=spawn(process.execPath,['-e','setTimeout(()=>{},600000)'],{detached:true,stdio:'ignore',env:process.env});" +
        "c.unref();require('node:fs').appendFileSync(process.argv[1],c.pid+' '+process.cwd()+'\\n');";
      const outcomes: ScopeReapOutcome[] = [];
      const custodian: RunScopeCustodian = {
        open: (runId) => inProcessRunScopeCustodian.open(runId),
        async settle(runId, marker) {
          const outcome = await inProcessRunScopeCustodian.settle(runId, marker);
          outcomes.push(outcome);
          return outcome;
        },
      };
      const leftovers = (): Array<{ pid: number; cwd: string }> =>
        existsSync(ledger)
          ? readFileSync(ledger, "utf8")
              .trim()
              .split("\n")
              .map((line) => {
                const [pid, ...cwd] = line.split(" ");
                return { pid: Number(pid), cwd: cwd.join(" ") };
              })
          : [];
      try {
        const res = await new Orchestrator({
          registry: new Map([["impl", recordingImplementer("impl", [])]]),
          runScopes: custodian,
          reviewers: [recordingReviewer("rev-a", "openai", [])],
        }).run({
          repoRoot: repo,
          prompt: "do it",
          mode: "agent",
          harnesses: ["impl"],
          n: 2,
          tests: [{ program: process.execPath, args: ["-e", gate, ledger], envAllowlist: [] }],
        });
        expect(res.lifecycle).toBe("succeeded");
        expect(res.facts.checks).toBe("passed");
        const left = leftovers();
        // Two candidate envelopes plus the winner's fresh verify tree.
        expect(left.length).toBeGreaterThanOrEqual(3);
        expect(left.some((entry) => entry.cwd.includes("claudexor-verify-"))).toBe(true);
        expect(outcomes).toHaveLength(1);
        for (const { pid } of left) {
          expect(alive(pid)).toBe(false);
          expect(outcomes[0]!.ended.map((m) => m.pid)).toContain(pid);
        }
      } finally {
        for (const { pid } of leftovers()) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
    },
    60_000,
  );
});

describe("Orchestrator run scope: cancel, Windows coverage, concurrency (item 8)", () => {
  it("settles the scope exactly once when the run is cancelled mid-flight", async () => {
    const repo = await initRepo();
    const calls: string[] = [];
    const custodian: RunScopeCustodian = {
      open: (runId) => inProcessRunScopeCustodian.open(runId),
      async settle(runId, marker) {
        calls.push("settle");
        return inProcessRunScopeCustodian.settle(runId, marker);
      },
    };
    const controller = new AbortController();
    const impl = recordingImplementer("slow", [], async function* () {
      controller.abort();
      yield;
    });
    const res = await new Orchestrator({
      registry: new Map([["slow", impl]]),
      runScopes: custodian,
    }).run({
      repoRoot: repo,
      prompt: "do it",
      mode: "agent",
      harnesses: ["slow"],
      n: 1,
      signal: controller.signal,
    });
    expect(res.lifecycle).toBe("cancelled");
    expect(calls).toEqual(["settle"]);
  }, 60_000);

  it("a tree_only (Windows) scope outcome is a disclosure: the succeeded run stays succeeded", async () => {
    const repo = await initRepo();
    const custodian: RunScopeCustodian = {
      open: (runId) => inProcessRunScopeCustodian.open(runId),
      async settle() {
        return {
          coverage: "tree_only",
          census: "unsupported",
          censusFailure: null,
          ended: [],
          survivors: [],
          unreadable: [],
          reusedGroups: [],
          settled: false,
          incomplete: false,
          completeness: "not_provable",
          completenessReason: "no environment census exists on this platform",
          restricted: false,
          durationMs: 0,
        };
      },
    };
    const res = await new Orchestrator({
      registry: new Map([["impl", recordingImplementer("impl", [])]]),
      runScopes: custodian,
    }).run({ repoRoot: repo, prompt: "do it", mode: "agent", harnesses: ["impl"], n: 1 });
    expect(res.lifecycle).toBe("succeeded");
    const facts = RunProcessScopeOutcome.parse(
      new ArtifactStore(repo).readYaml(join(res.runDir, "final", "process_scope.yaml")),
    );
    expect(facts).toMatchObject({ coverage: "tree_only", census: "unsupported", settled: false });
  }, 60_000);

  it.runIf(process.platform !== "win32")(
    "two concurrent runs: the first run's end leaves the second's leftover alive until the second ends",
    async () => {
      const repoA = await initRepo();
      const repoB = await initRepo();
      const script =
        "const {spawn}=require('node:child_process');" +
        "const c=spawn(process.execPath,['-e','setTimeout(()=>{},600000)'],{detached:true,stdio:'ignore',env:process.env});" +
        "c.unref();console.log('orphan:'+c.pid);";
      let orphanA = 0;
      let orphanB = 0;
      let releaseB!: () => void;
      const aFinished = new Promise<void>((resolve) => (releaseB = resolve));
      const leave = async (spec: HarnessRunSpec): Promise<number> => {
        let pid = 0;
        for await (const ev of spawnProcess(process.execPath, ["-e", script], {
          env: spec.env,
          cwd: spec.cwd,
        })) {
          if (ev.type === "stdout" && ev.line.startsWith("orphan:")) pid = Number(ev.line.slice(7));
        }
        return pid;
      };
      const implA = recordingImplementer("impl-a", [], async function* (spec) {
        orphanA = await leave(spec);
        yield;
      });
      const implB = recordingImplementer("impl-b", [], async function* (spec) {
        orphanB = await leave(spec);
        await aFinished; // B outlives A on purpose
        yield;
      });
      try {
        const runA = new Orchestrator({ registry: new Map([["impl-a", implA]]) }).run({
          repoRoot: repoA,
          prompt: "a",
          mode: "agent",
          harnesses: ["impl-a"],
          n: 1,
        });
        const runB = new Orchestrator({ registry: new Map([["impl-b", implB]]) }).run({
          repoRoot: repoB,
          prompt: "b",
          mode: "agent",
          harnesses: ["impl-b"],
          n: 1,
        });
        const resA = await runA;
        expect(resA.lifecycle).toBe("succeeded");
        expect(orphanA).toBeGreaterThan(0);
        expect(orphanB).toBeGreaterThan(0);
        // A ended ONLY its own leftover; B's is still the live run's.
        expect(alive(orphanA)).toBe(false);
        expect(alive(orphanB)).toBe(true);
        releaseB();
        const resB = await runB;
        expect(resB.lifecycle).toBe("succeeded");
        expect(alive(orphanB)).toBe(false);
        const factsA = RunProcessScopeOutcome.parse(
          new ArtifactStore(repoA).readYaml(join(resA.runDir, "final", "process_scope.yaml")),
        );
        const factsB = RunProcessScopeOutcome.parse(
          new ArtifactStore(repoB).readYaml(join(resB.runDir, "final", "process_scope.yaml")),
        );
        expect(factsA.ended.map((m) => m.pid)).toEqual([orphanA]);
        expect(factsB.ended.map((m) => m.pid)).toEqual([orphanB]);
      } finally {
        releaseB();
        for (const pid of [orphanA, orphanB]) {
          try {
            if (pid) process.kill(pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
    },
    120_000,
  );
});

describe("Orchestrator run scope: terminal after cleanup (fix round 1 item 3)", () => {
  it("publishes the run terminal only after the scope is settled and its outcome recorded; survivors never change the verdict", async () => {
    const repo = await initRepo();
    const observed: { terminalAtSettle: boolean; factsAtSettle: boolean }[] = [];
    const custodian: RunScopeCustodian = {
      open: (runId) => inProcessRunScopeCustodian.open(runId),
      async settle(runId, marker) {
        const runDir = join(projectRuntimeDir(repo), "runs", runId);
        const events = existsSync(join(runDir, "events.jsonl"))
          ? readFileSync(join(runDir, "events.jsonl"), "utf8")
          : "";
        observed.push({
          terminalAtSettle: /"type":"run\.(completed|failed|blocked)"/.test(events),
          factsAtSettle: existsSync(join(runDir, "final", "process_scope.yaml")),
        });
        const real = await inProcessRunScopeCustodian.settle(runId, marker);
        // A survivor the cleanup could not end is a DISCLOSURE, not a verdict.
        return { ...real, settled: false, survivors: [{ pid: 424242, startToken: "ps:x" }] };
      },
    };
    const res = await new Orchestrator({
      registry: new Map([["impl", recordingImplementer("impl", [])]]),
      runScopes: custodian,
    }).run({ repoRoot: repo, prompt: "do it", mode: "agent", harnesses: ["impl"], n: 1 });
    expect(res.lifecycle).toBe("succeeded");
    expect(observed).toEqual([{ terminalAtSettle: false, factsAtSettle: false }]);
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"run.completed"');
    const facts = RunProcessScopeOutcome.parse(
      new ArtifactStore(repo).readYaml(join(res.runDir, "final", "process_scope.yaml")),
    );
    expect(facts.settled).toBe(false);
    expect(facts.survivors.map((m) => m.pid)).toEqual([424242]);
  }, 60_000);

  it("a refused run (announced, then failed before any launch) still settles its minted marker exactly once", async () => {
    // Every refusal that could precede the announcement happens BEFORE the
    // marker is minted (mode/secret/admission checks), so the reachable
    // property is: a run the engine refuses after announcing — here an
    // unknown harness — ends with one settle and a recorded outcome, never none.
    const repo = await initRepo();
    const calls: string[] = [];
    const custodian: RunScopeCustodian = {
      async open(runId) {
        calls.push("open");
        return inProcessRunScopeCustodian.open(runId);
      },
      async settle(runId, marker) {
        calls.push("settle");
        return inProcessRunScopeCustodian.settle(runId, marker);
      },
    };
    const res = await new Orchestrator({ registry: new Map(), runScopes: custodian }).run({
      repoRoot: repo,
      prompt: "do it",
      mode: "agent",
      harnesses: ["nope"],
      n: 1,
    });
    expect(res.lifecycle).toBe("failed");
    expect(calls).toEqual(["open", "settle"]);
    expect(existsSync(join(res.runDir, "final", "process_scope.yaml"))).toBe(true);
  }, 60_000);

  it.runIf(process.platform !== "win32")(
    "a continuation inside one run keeps its helper: attempt 1's leftover is alive during attempt 2 and ended only at the run's end",
    async () => {
      const repo = await initRepo();
      const script =
        "const {spawn}=require('node:child_process');" +
        "const c=spawn(process.execPath,['-e','setTimeout(()=>{},600000)'],{detached:true,stdio:'ignore',env:process.env});" +
        "c.unref();console.log('orphan:'+c.pid);";
      let orphan = 0;
      let aliveDuringSecond: boolean | null = null;
      let attempts = 0;
      const impl = recordingImplementer("impl", [], async function* (spec) {
        attempts += 1;
        if (attempts === 1) {
          for await (const ev of spawnProcess(process.execPath, ["-e", script], {
            env: spec.env,
            cwd: spec.cwd,
          })) {
            if (ev.type === "stdout" && ev.line.startsWith("orphan:"))
              orphan = Number(ev.line.slice(7));
          }
        } else {
          aliveDuringSecond = alive(orphan);
        }
        yield;
      });
      try {
        const res = await new Orchestrator({ registry: new Map([["impl", impl]]) }).run({
          repoRoot: repo,
          prompt: "do it",
          mode: "agent",
          harnesses: ["impl"],
          n: 2,
        });
        expect(res.lifecycle).toBe("succeeded");
        expect(attempts).toBe(2);
        expect(orphan).toBeGreaterThan(0);
        expect(aliveDuringSecond).toBe(true);
        expect(alive(orphan)).toBe(false);
      } finally {
        if (orphan) {
          try {
            process.kill(orphan, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
    },
    90_000,
  );
});

describe("fix round 2: barrier finally and frozen cancellation", () => {
  it("records the scope before the typed failure a delegated child-drain rejection becomes (item 4)", async () => {
    const repo = await initRepo();
    const trace: string[] = [];
    const custodian: RunScopeCustodian = {
      open: (runId) => inProcessRunScopeCustodian.open(runId),
      async settle(runId, marker) {
        const runDir = join(projectRuntimeDir(repo), "runs", runId);
        const events = existsSync(join(runDir, "events.jsonl"))
          ? readFileSync(join(runDir, "events.jsonl"), "utf8")
          : "";
        trace.push(`settle:terminal=${/"type":"run\.(completed|failed|blocked)"/.test(events)}`);
        return inProcessRunScopeCustodian.settle(runId, marker);
      },
    };
    const drainError = Object.assign(new Error("delegated children did not settle"), {
      code: "delegation_child_drain_timeout",
    });
    const authority = {
      hasParent: () => true,
      beginParentClose: () => trace.push("drain-begin"),
      waitForChildren: async () => {
        trace.push("drain-reject");
        throw drainError;
      },
      releaseRun: () => trace.push("released"),
      registerParent: () => {},
    } as unknown as NonNullable<
      ConstructorParameters<typeof Orchestrator>[0]["delegationBudgetAuthority"]
    >;
    const res = await new Orchestrator({
      registry: new Map([["impl", recordingImplementer("impl", [])]]),
      runScopes: custodian,
      delegationBudgetAuthority: authority,
    }).run({ repoRoot: repo, prompt: "do it", mode: "agent", harnesses: ["impl"], n: 1 });
    // The drain failure keeps its typed verdict; custody settled BEFORE it was published.
    expect(res.lifecycle).toBe("failed");
    expect(trace.indexOf("drain-reject")).toBeLessThan(trace.indexOf("settle:terminal=false"));
    expect(trace.filter((t) => t.startsWith("settle:"))).toEqual(["settle:terminal=false"]);
    expect(trace.indexOf("released")).toBeGreaterThan(trace.indexOf("settle:terminal=false"));
    expect(existsSync(join(res.runDir, "final", "process_scope.yaml"))).toBe(true);
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"run.failed"');
    expect(events).toContain("delegation_drain");
  }, 60_000);

  it("the in-process custodian records each marker's opening time and hands it to its settle (round 5: the census skips older processes)", async () => {
    const calls: ScopeReapOptions[] = [];
    const custodian = createInProcessRunScopeCustodian(async (opts) => {
      calls.push(opts);
      return failedScopeOutcome("fake");
    });
    const before = Date.now();
    const { marker } = await custodian.open("run-1");
    await custodian.settle("run-1", marker);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.marker).toBe(marker);
    const openedAt = Date.parse(calls[0]?.scopeStartAt ?? "");
    expect(openedAt).toBeGreaterThanOrEqual(before - 1);
    expect(openedAt).toBeLessThanOrEqual(Date.now());
    // A marker this custodian never opened has no opening time: full census.
    await custodian.settle("run-x", mintRunScopeMarker());
    expect(calls[1]?.scopeStartAt).toBeNull();
  });

  it("an abort that arrives DURING the settlement barrier does not turn a completed run into cancelled (item 9)", async () => {
    const repo = await initRepo();
    const controller = new AbortController();
    const custodian: RunScopeCustodian = {
      open: (runId) => inProcessRunScopeCustodian.open(runId),
      async settle(runId, marker) {
        controller.abort("host_cancelled"); // the host cancels while cleanup runs
        return inProcessRunScopeCustodian.settle(runId, marker);
      },
    };
    const res = await new Orchestrator({
      registry: new Map([["impl", recordingImplementer("impl", [])]]),
      runScopes: custodian,
    }).run({
      repoRoot: repo,
      prompt: "do it",
      mode: "agent",
      harnesses: ["impl"],
      n: 1,
      signal: controller.signal,
    });
    expect(res.lifecycle).toBe("succeeded");
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8");
    expect(events).toContain('"type":"run.completed"');
    expect(events).not.toContain('"type":"run.failed"');
    // An abort that arrived BEFORE the strategy finished still cancels.
    const early = new AbortController();
    const impl = recordingImplementer("impl2", [], async function* () {
      early.abort("host_cancelled");
      yield;
    });
    const cancelled = await new Orchestrator({
      registry: new Map([["impl2", impl]]),
      runScopes: inProcessRunScopeCustodian,
    }).run({
      repoRoot: await initRepo(),
      prompt: "do it",
      mode: "agent",
      harnesses: ["impl2"],
      n: 1,
      signal: early.signal,
    });
    expect(cancelled.lifecycle).toBe("cancelled");
  }, 90_000);
});

// Keep `spawn` referenced for the platform-binary shape documented above.
void spawn;
