import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  defaultProcessIdentityService,
  onChildProcessRegistered,
  runCapture,
  type HarnessAdapter,
} from "@claudexor/core";
import { ConformanceReport, HarnessManifest, type RunEvent } from "@claudexor/schema";

/**
 * A run's main thread does not wait for the disk per harness event (#688,
 * design section 8(a), in the style of daemon/src/store/main-thread-sync.test.ts).
 * The mocks count every synchronous `node:fs` call and every synchronous child
 * process call made by any module of this test's graph while a run is measured.
 */
const { calls, count } = vi.hoisted(() => {
  const calls = { counting: false, byName: new Map<string, number>() };
  const count = (name: string): void => {
    if (calls.counting) calls.byName.set(name, (calls.byName.get(name) ?? 0) + 1);
  };
  return { calls, count };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const patched: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual))
    if (name.endsWith("Sync") && typeof value === "function")
      patched[name] = (...args: unknown[]) => {
        count(`fs.${name}`);
        return (value as (...callArgs: unknown[]) => unknown)(...args);
      };
  return { ...actual, ...patched, default: { ...actual, ...patched } };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const patched: Record<string, unknown> = {};
  for (const name of ["execFileSync", "execSync", "spawnSync"] as const)
    patched[name] = (...args: unknown[]) => {
      count(`child_process.${name}`);
      return (actual[name] as (...callArgs: unknown[]) => unknown)(...args);
    };
  return { ...actual, ...patched, default: { ...actual, ...patched } };
});
const { Orchestrator } = await import("./orchestrator.js");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

async function initRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "claudexor-run-main-thread-"));
  roots.push(repo);
  await runCapture("git", ["-C", repo, "init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  await runCapture("git", ["-C", repo, "add", "-A"]);
  await runCapture("git", [
    "-C",
    repo,
    ...["-c", "user.email=t@t.dev", "-c", "user.name=t"],
    ...["commit", "-m", "init"],
  ]);
  return repo;
}

/** A harness that streams `events` messages, edits one file and finishes. */
function streaming(events: number): HarnessAdapter {
  return {
    id: "stream",
    async discover() {
      return HarnessManifest.parse({
        id: "stream",
        display_name: "stream",
        kind: "local_cli",
        provider_family: "local",
        capabilities: { implement: true },
        access_profiles_supported: ["workspace_write"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: "stream",
        status: "ok",
        enabled_intents: ["implement"],
      });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      for (let index = 0; index < events; index += 1)
        yield { type: "message", session_id: spec.session_id, ts, text: `step ${index}` };
      writeFileSync(join(spec.cwd, "CHANGED.txt"), "change\n");
      yield { type: "message", session_id: spec.session_id, ts, text: "done", final: true };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
}

/** One agent run of `events` streamed events, with what its main thread did. */
async function measuredRun(events: number) {
  const repo = await initRepo();
  const children: { pid: number; pgid: number }[] = [];
  const off = onChildProcessRegistered((child) =>
    children.push({ pid: child.pid, pgid: child.processGroup.pgid }),
  );
  const reads = vi.spyOn(defaultProcessIdentityService, "read");
  calls.byName.clear();
  calls.counting = true;
  try {
    const result = await new Orchestrator({
      registry: new Map([["stream", streaming(events)]]),
    }).run({ repoRoot: repo, prompt: "do it", mode: "agent", harnesses: ["stream"], n: 1 });
    calls.counting = false;
    const total = (prefix: string) =>
      [...calls.byName].filter(([name]) => name.startsWith(prefix)).reduce((n, [, v]) => n + v, 0);
    const messages = readFileSync(join(result.runDir, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunEvent)
      .filter((event) => event.type === "harness.event" && event.payload["type"] === "message");
    return {
      result,
      messages: messages.length,
      fsSync: total("fs."),
      childSync: total("child_process."),
      terminalFsyncs: calls.byName.get("fs.fsyncSync") ?? 0,
      children,
      // The identity helper's runs for other processes than this one.
      childReads: reads.mock.calls.map(([pid]) => pid).filter((pid) => pid !== process.pid),
    };
  } finally {
    calls.counting = false;
    off();
    reads.mockRestore();
  }
}

describe("a run's main thread and its streamed harness events (#688)", { timeout: 120_000 }, () => {
  it("makes as many synchronous storage and child-process calls for 500 events as for 50", async () => {
    // The first run of the process may learn its own start time and identity once.
    await measuredRun(1);
    const fifty = await measuredRun(50);
    const fiveHundred = await measuredRun(500);
    // Direction 1: the count does not grow with the events (inline writes made
    // one synchronous append per event).
    expect(fiveHundred.fsSync).toBe(fifty.fsSync);
    expect(fiveHundred.childSync).toBe(fifty.childSync);
    // Direction 2: every event still landed in the run journal, and the spies
    // see the synchronous work that stays (the terminal's synchronous commit).
    for (const [measured, events] of [
      [fifty, 50],
      [fiveHundred, 500],
    ] as const) {
      expect(measured.result.lifecycle).toBe("succeeded");
      expect(measured.messages).toBe(events + 1);
      expect(measured.terminalFsyncs).toBeGreaterThan(0);
    }
  });

  it.runIf(process.platform !== "win32")(
    "runs the identity helper once per spawned child",
    async () => {
      const run = await measuredRun(50);
      expect(run.result.lifecycle).toBe("succeeded");
      // Direction 1: no child's identity is read twice: helper runs equal children.
      expect(run.childReads.length).toBeGreaterThan(0);
      expect(new Set(run.childReads).size).toBe(run.childReads.length);
      // Direction 2: each child the run registered was read once, at spawn, and
      // recorded as its own process group's leader.
      expect(run.children.length).toBeGreaterThan(0);
      for (const child of run.children) {
        expect(run.childReads.filter((pid) => pid === child.pid)).toHaveLength(1);
        expect(child.pgid).toBe(child.pid);
      }
    },
  );
});
