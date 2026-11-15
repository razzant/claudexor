// #694 r12: a stop whose end was not proven is disclosed the same way on every
// strategy — a stopped race candidate's completion, and the run's cancelled
// terminal also where no attempt began (convergence, the in-place pre-turn
// snapshot) — and what it holds is released by the run's barrier once the scope
// settled. Real Git and real processes: the survivor is this test's own
// grandchild, started by a clean filter in its own process group, holding Git's
// stderr and carrying the run's preparation marker; it is ended by the run's
// scope settlement, and otherwise by this test by its exact identity.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createFakeHarness } from "@claudexor/harness-fake";
import type { RunEvent } from "@claudexor/schema";
import { scopeMarkerOf } from "@claudexor/workspace";
import { Orchestrator, type OrchestratorResult, type RunInput } from "./orchestrator.js";
import { openRunScopeCustody } from "./runScope.js";
import {
  endIdentified,
  startOf,
  until,
  type Identity,
} from "../../core/src/test-support/process-fixtures.js";

const posix = process.platform !== "win32";
const roots: string[] = [];
const own: Identity[] = [];
/** End this test's own processes by measured identity (`endIdentified`). */
const endOwn = (): Promise<void> => endIdentified(own);
afterEach(async () => {
  await endOwn();
  delete process.env.GIT_CONFIG_COUNT;
});
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

/** The held part of the filter: ONE process (the shell `exec`s it) that announces
 * itself (`holding`, by rename), blocks while the test directory exists, then
 * passes its input through. A `/bin/sh` loop of short `sleep`s does not end
 * reliably on a group SIGINT: the shell can miss one that lands just as a `sleep`
 * exits and would stand for a survivor no test meant. A test stops
 * only once the holder announced itself: then no shell is left in Git's group. */
const HOLD_JS =
  "const fs=require('node:fs');const [root,holding]=process.argv.slice(2);" +
  "fs.writeFileSync(holding+'.tmp','');fs.renameSync(holding+'.tmp',holding);" +
  "const t=setInterval(()=>{if(!fs.existsSync(root)){" +
  "clearInterval(t);process.stdin.pipe(process.stdout);}},20);";
/** A committed project whose dirty `x.held` passes a clean filter that, while
 * `hold` exists, starts the survivor (own group, Git's stderr, inherited env —
 * so the preparation's marker) and blocks. */
function world() {
  const root = mkdtempSync(join(tmpdir(), "cx-prep-disclose-"));
  roots.push(root);
  const repo = join(root, "project");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: GIT_ENV });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: GIT_ENV });
  writeFileSync(join(repo, ".gitattributes"), "*.held filter=held\n");
  writeFileSync(join(repo, "README.md"), "base\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  writeFileSync(join(repo, "x.held"), "dirty\n");
  const hold = join(root, "hold");
  const survivorFile = join(root, "survivor");
  const spawnSurvivor = join(root, "survivor.cjs");
  // The PID file is published whole (rename), never read half-written.
  writeFileSync(
    spawnSurvivor,
    `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','ignore',2]});const f=require('node:fs');f.writeFileSync(${JSON.stringify(`${survivorFile}.tmp`)},String(c.pid));f.renameSync(${JSON.stringify(`${survivorFile}.tmp`)},${JSON.stringify(survivorFile)});c.unref();`,
  );
  const holder = join(root, "hold.cjs");
  const holding = join(root, "holding");
  writeFileSync(holder, HOLD_JS);
  const program = join(root, "filter.sh");
  writeFileSync(
    program,
    `#!/bin/sh\nif [ -e '${hold}' ] && [ ! -e '${survivorFile}' ]; then '${process.execPath}' '${spawnSurvivor}'; exec '${process.execPath}' '${holder}' '${root}' '${holding}'; fi\nexec cat\n`,
    { mode: 0o755 },
  );
  process.env.GIT_CONFIG_COUNT = "2";
  process.env.GIT_CONFIG_KEY_0 = "filter.held.clean";
  process.env.GIT_CONFIG_VALUE_0 = program;
  process.env.GIT_CONFIG_KEY_1 = "filter.held.smudge";
  process.env.GIT_CONFIG_VALUE_1 = "cat";
  return {
    repo,
    hold: () => writeFileSync(hold, ""),
    /** The filter's holder announced itself: the shell is gone from Git's group. */
    holding: () => until("the holder to announce itself", () => existsSync(holding)),
    /** The survivor, joined to this test's custody by its measured start. */
    survivor: async () => {
      await until("the survivor to report", () => existsSync(survivorFile));
      const pid = Number(readFileSync(survivorFile, "utf8"));
      let start: string | "gone" | null = null;
      await until("the survivor's start time", () => (start = startOf(pid)) !== null);
      if (start === "gone") throw new Error(`survivor ${pid} ended before it was identified`);
      const entry = { pid, start: start as unknown as string };
      own.push(entry);
      return entry;
    },
  };
}

const request = (repo: string, signal: AbortSignal, extra: Partial<RunInput> = {}): RunInput => ({
  repoRoot: repo,
  prompt: "edit",
  mode: "agent",
  harnesses: ["fake-success"],
  paidBudget: { kind: "finite", maxUsd: 5 },
  signal,
  ...extra,
});
const orchestrator = () =>
  new Orchestrator({
    registry: new Map([["fake-success", createFakeHarness("fake-success")]]),
    reviewers: [],
  });
const events = (result: OrchestratorResult): RunEvent[] =>
  readFileSync(join(result.runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RunEvent);
const terminalOf = (result: OrchestratorResult) =>
  events(result).find((event) => event.type === "run.failed" || event.type === "run.completed");
const unconfirmed = expect.objectContaining({
  survivors: [],
  unresolved: [expect.objectContaining({ reason: "output_held" })],
  reason: "output_held",
});

async function stoppedWhileHeld(extra: Partial<RunInput>) {
  const w = world();
  w.hold();
  const stop = new AbortController();
  const run = orchestrator().run(request(w.repo, stop.signal, extra));
  const survivor = await w.survivor();
  await w.holding();
  stop.abort();
  const result = await run;
  return { result, survivor };
}

describe.runIf(posix)(
  "an unconfirmed preparation stop is disclosed on every strategy (#694 r12)",
  () => {
    it("race (isolated): the candidate's completion and the terminal disclose it; the barrier ends the survivor and releases the held base", async () => {
      const { result, survivor } = await stoppedWhileHeld({ inPlace: false });
      expect(result.lifecycle).toBe("cancelled");
      const completion = events(result).find((event) => event.type === "harness.completed");
      expect(completion?.payload).toMatchObject({
        status: "cancelled",
        phase: "workspace",
        termination_unconfirmed: unconfirmed,
        held: [expect.stringContaining("workspaces")],
      });
      const base = (completion?.payload["held"] as string[])[0]!;
      // The run's scope settled at its barrier: its marked survivor was ended by
      // identity, and the base held for it was then released before the terminal.
      expect(startOf(survivor.pid)).not.toBe(survivor.start);
      expect(existsSync(base)).toBe(false);
      expect(terminalOf(result)?.payload).toMatchObject({
        lifecycle: "cancelled",
        termination_unconfirmed: unconfirmed,
        held: [],
      });
    }, 120_000);

    it("convergence: no attempt began, and the cancelled terminal still discloses it", async () => {
      const { result } = await stoppedWhileHeld({ inPlace: false, attempts: 2, review: false });
      expect(result.lifecycle).toBe("cancelled");
      const all = events(result);
      expect(all.filter((event) => event.type === "harness.started")).toEqual([]);
      expect(all.filter((event) => event.type === "harness.completed")).toEqual([]);
      expect(terminalOf(result)?.payload).toMatchObject({
        lifecycle: "cancelled",
        termination_unconfirmed: unconfirmed,
      });
    }, 120_000);

    it("in-place: the pre-turn snapshot's stop is disclosed on the terminal, with nothing held", async () => {
      const { result } = await stoppedWhileHeld({ inPlace: true });
      expect(result.lifecycle).toBe("cancelled");
      expect(events(result).filter((event) => event.type === "harness.started")).toEqual([]);
      expect(terminalOf(result)?.payload).toMatchObject({
        lifecycle: "cancelled",
        termination_unconfirmed: unconfirmed,
        held: [],
      });
    }, 120_000);

    it("the same run without a stop discloses nothing and runs", async () => {
      const w = world();
      const result = await orchestrator().run(
        request(w.repo, new AbortController().signal, { inPlace: false }),
      );
      // (Its unknown fake cost under a finite cap decides the verdict; only the stop matters.)
      expect(result.lifecycle).not.toBe("cancelled");
      expect(events(result).some((event) => event.type === "harness.started")).toBe(true);
      const terminal = terminalOf(result)?.payload ?? {};
      expect(terminal).not.toHaveProperty("termination_unconfirmed");
      expect(terminal).not.toHaveProperty("held");
      expect(readdirSync(w.repo)).toContain("x.held");
    }, 120_000);
  },
);

describe("the run's preparation carrier (#694 r12)", () => {
  it("is private per run: the external stop stays the same object, and two runs sharing it never share a scope", async () => {
    const external = new AbortController();
    const input = { signal: external.signal };
    const first = (await openRunScopeCustody(undefined, "run-a")).scope(input);
    const second = (await openRunScopeCustody(undefined, "run-b")).scope(input);
    expect(first.signal).toBe(external.signal);
    expect(second.signal).toBe(external.signal);
    expect(scopeMarkerOf(external.signal)).toBeUndefined();
    expect(scopeMarkerOf(first.preparationSignal)).toBe(first.runScopeMarker);
    expect(scopeMarkerOf(second.preparationSignal)).toBe(second.runScopeMarker);
    expect(first.runScopeMarker).not.toBe(second.runScopeMarker);
    // A stop reaches the carriers; a run without a stop still gets one.
    external.abort("stop");
    expect(first.preparationSignal.aborted && second.preparationSignal.aborted).toBe(true);
    const none = (await openRunScopeCustody(undefined, "run-c")).scope({});
    expect(scopeMarkerOf(none.preparationSignal)).toBe(none.runScopeMarker);
    expect(none.preparationSignal.aborted).toBe(false);
  });
});
