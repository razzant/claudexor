import { mkdtempSync, promises, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultHighWaterMark } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
import { runCapture } from "@claudexor/core";
import { ConformanceReport, HarnessManifest, type RunEvent } from "@claudexor/schema";
import { orderedAppender } from "@claudexor/util";
import { Orchestrator } from "./orchestrator.js";

// Flow control (#688, D11): a lane loop queues each harness event's lines on
// the ordered appender, and once a file it writes is full it reads the next
// event only after that file drains. Here every write under the run directory
// is held as soon as the harness starts; each message fills half the
// runtime's high-water mark, so the second one fills the run's journal.

const APPLIED_POOL = Symbol.for("claudexor.libuvPoolSize");
const reapDirs: string[] = [];
let savedPool: unknown;

beforeEach(() => {
  const global = globalThis as Record<symbol, unknown>;
  savedPool = global[APPLIED_POOL];
  // Six write slots: held journal writes never starve the run's other writes.
  global[APPLIED_POOL] = 8;
});
afterEach(() => {
  const global = globalThis as Record<symbol, unknown>;
  if (savedPool === undefined) delete global[APPLIED_POOL];
  else global[APPLIED_POOL] = savedPool;
  vi.restoreAllMocks();
});
afterAll(() => {
  for (const dir of reapDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

async function initRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "claudexor-lane-flow-"));
  reapDirs.push(repo);
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

/** Hold every write under `dir` while `holding()` is true; the appender opens
 * each batch through `fs.promises.open`, read at call time. */
function holdWritesUnder(dir: () => string | null, holding: () => boolean) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held: string[] = [];
  const realOpen = promises.open;
  vi.spyOn(promises, "open").mockImplementation((async (
    ...args: Parameters<typeof promises.open>
  ) => {
    const handle = await realOpen(...args);
    const path = String(args[0]);
    const root = dir();
    if (!root || !path.startsWith(root)) return handle;
    const write = handle.write.bind(handle) as (...writeArgs: unknown[]) => Promise<unknown>;
    handle.write = (async (...writeArgs: unknown[]) => {
      if (holding()) {
        held.push(path);
        await gate;
      }
      return write(...writeArgs);
    }) as unknown as typeof handle.write;
    return handle;
  }) as typeof promises.open);
  return { held, release };
}

type Lane = "agent" | "ask" | "plan";

const MESSAGES = 10;
const half = getDefaultHighWaterMark(false) / 2;

/** A harness of `MESSAGES` messages; `start` runs before the first one. */
function streamingAdapter(
  lane: Lane,
  start: () => void,
  progress: { pulled: number; finished: boolean },
): HarnessAdapter {
  const id = "stub";
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "local",
        capabilities:
          lane === "agent" ? { implement: true } : { plan: true, review: true, read_files: true },
        access_profiles_supported: [lane === "agent" ? "workspace_write" : "readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: lane === "agent" ? ["implement"] : ["explain", "audit", "plan", "review"],
      });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      start();
      for (let index = 0; index < MESSAGES; index += 1) {
        progress.pulled += 1;
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: String(index).repeat(half),
        };
      }
      yield { type: "message", session_id: spec.session_id, ts, text: "done", final: true };
      yield { type: "completed", session_id: spec.session_id, ts };
      progress.finished = true;
    },
  };
}

async function quiet(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function until(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("lane loops read the next harness event only once their full files drain (#688)", () => {
  it.each(["agent", "ask", "plan"] as const)(
    "%s: stops at a full run journal while its writes are held, then reads every event",
    async (lane) => {
      const repo = await initRepo();
      const runId = `run-flow-${lane}`;
      const runDir = new ArtifactStore(repo).runPaths(runId).root;
      const eventsPath = join(runDir, "events.jsonl");
      const progress = { pulled: 0, finished: false };
      let holding = false;
      const hold = holdWritesUnder(
        () => runDir,
        () => holding,
      );
      const running = new Orchestrator({
        registry: new Map([
          [
            "stub",
            streamingAdapter(
              lane,
              () => {
                holding = true;
              },
              progress,
            ),
          ],
        ]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt: lane === "ask" ? "explain the fixture" : "do it",
        mode: lane,
        harnesses: ["stub"],
        runId,
      });
      try {
        await until("the run journal is full", () => orderedAppender.full(eventsPath));
        await quiet();
        // The second message filled the journal: the loop asks for no third one.
        expect(progress.pulled).toBe(2);
        expect(hold.held.length).toBeGreaterThan(0);
      } finally {
        holding = false;
        hold.release();
      }
      const result = await running;
      expect(result.runDir).toBe(runDir);
      expect(progress.pulled).toBe(MESSAGES);
      expect(progress.finished).toBe(true);
      const texts = readFileSync(eventsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as RunEvent)
        .filter((event) => event.type === "harness.event" && event.payload["type"] === "message")
        .map((event) => String(event.payload["text"]).slice(0, 1));
      expect(texts).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "d"]);
    },
  );
});
