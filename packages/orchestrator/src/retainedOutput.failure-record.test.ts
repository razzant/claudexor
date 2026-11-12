/** A failed run that retained text names it in its failure record: the native
 * cause stays the message's first line (route health still groups by it), the
 * notice follows that line, before the rest of the original message (its
 * account attempts), so a reader that bounds a real-sized record still meets
 * it, and `logRefs` addresses the file. That optional enrichment never costs
 * the saved retained output its announcement, nor the original record its
 * bytes: the record is replaced atomically, and a replacement that fails has a
 * diagnostic of its own. Scripted fake harness through the real Orchestrator
 * terminal and the control API's own route-health read (no daemon, no account). */
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { EventLog } from "@claudexor/event-log";
import {
  RunFailure,
  makeOutcomeFacts,
  type HarnessEvent,
  type ModeKind,
  type PoolAttemptFailure,
} from "@claudexor/schema";
import { aggregateRouteHealth, failureMessageLine } from "../../control-api/src/route-health.js";
import { routeHealthFactsOf } from "../../control-api/src/route-health-facts.js";
import { run } from "./inrun-continuity.test-support.js";
import { withPoolAttempts } from "./pool-attempt-evidence.js";
import { namingRetainedOutput } from "./retainedOutput.js";
import { writeFailure } from "./runTerminalResults.js";
import { guardAnnouncedRun } from "./runTerminals.js";

const RETAINED = "final/retained-output.md";
const NOTICE =
  "The assistant text this run retained (not an accepted final answer) is in final/retained-output.md.";

// SYNTHETIC vendor words at the sizes recorded failure records carry (three
// failed tries; cause lines of 69-260 and messages of 590-1,354 characters).
const DROPPED =
  "The connection to the model service was interrupted before the turn completed; please try again.";
const PIPE =
  'agent executor error: generating and executing: request failed: Post "https://model.example.test/v1internal:streamGenerateContent?alt=sse": write tcp 192.0.2.10:64004->198.51.100.4:443: write: broken pipe';
const AUTH =
  "UNAUTHENTICATED (code 401): Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://identity.example.test/sign-in/web/devconsole-project.";

const fault = vi.hoisted(() => {
  /** Fault selectors compare path SEGMENTS, never a separator literal, so the
   * hooks select the same files on Windows paths: a file directly inside the
   * run's `final/` directory, and the failure record there. */
  type PathApi = { basename(path: string): string; dirname(path: string): string };
  const inFinal = (api: PathApi, file: string) => api.basename(api.dirname(file)) === "final";
  return {
    rename: false,
    original: null as string | null,
    inFinal,
    isFailureRecord: (api: PathApi, file: string) =>
      inFinal(api, file) && api.basename(file) === "failure.yaml",
  };
});
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const path = await import("node:path");
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (fault.rename && fault.isFailureRecord(path, String(args[1]))) {
        fault.original = fs.readFileSync(args[1], "utf8");
        throw Object.assign(new Error("EIO: injected rename failure"), { code: "EIO" });
      }
      return fs.renameSync(...args);
    },
  };
});

type Emit = (ev: Partial<HarnessEvent>) => HarnessEvent;
const stop = (emit: Emit, cause: string) => [
  emit({ type: "error", error: cause }),
  emit({ type: "completed", payload: { exit_code: 1, harness_reported_error: true } }),
];

/** Three failed tries after progress (a tool call; the first try also streams
 * `retainedText`), each with its own real-sized words; the last is the cause. */
async function failedRun(
  mode: "agent" | "ask",
  causes: readonly [string, string, string],
  retainedText: string | null,
) {
  return run({
    mode,
    profiles: ["a"],
    continuity: null,
    maxRetries: 2,
    script: function* ({ emit, tryOfProfile }) {
      yield emit({ type: "started" });
      yield emit({ type: "tool_call", tool: { name: "Read", kind: "file" } });
      if (retainedText !== null && tryOfProfile === 1)
        yield emit({ type: "message", text: retainedText, payload: { delta: true } });
      yield* stop(emit, causes[tryOfProfile - 1]!);
    },
  });
}

const finalPath = (runDir: string, rel: string) => join(runDir, "final", rel);
const failureOf = (runDir: string) =>
  RunFailure.parse(new ArtifactStore(runDir).readYaml(finalPath(runDir, "failure.yaml")));

describe("failure record names the retained output right after its cause line", () => {
  it("route health keeps grouping real-sized three-try agent and ask failures by their own cause", async () => {
    const variants = [
      ["agent", PIPE, "Exact partial answer\n"],
      ["agent", PIPE, null],
      ["agent", AUTH, "Another partial answer\n"],
      ["ask", PIPE, "Exact partial answer\n"],
      ["ask", PIPE, null],
      ["ask", AUTH, "Another partial answer\n"],
    ] as const;
    const runs: {
      mode: "agent" | "ask";
      cause: string;
      text: string | null;
      runDir: string;
      failure: RunFailure;
    }[] = [];
    for (const [mode, cause, text] of variants) {
      const out = await failedRun(mode, [AUTH, DROPPED, cause], text);
      expect(out.result.lifecycle).toBe("failed");
      expect(out.spawns).toHaveLength(3);
      runs.push({
        mode,
        cause,
        text,
        runDir: out.result.runDir,
        failure: failureOf(out.result.runDir),
      });
    }
    for (const item of runs) {
      const message = item.failure.safeMessage;
      const lineEnd = message.indexOf("\n");
      const causeLine = message.slice(0, lineEnd);
      expect(causeLine).toContain(item.cause);
      expect(item.failure.poolAttempts.map((row) => row.error)).toEqual([
        AUTH,
        DROPPED,
        item.cause,
      ]);
      if (item.text === null) {
        expect(message).not.toContain(NOTICE);
        expect(item.failure.logRefs).not.toContain(RETAINED);
        expect(message.slice(lineEnd)).toMatch(/^\n\nAccount attempts:\n/);
        continue;
      }
      // The cause line, the notice, then the original remainder (its account attempts).
      expect(message.slice(lineEnd)).toMatch(/^\n\nThe assistant text this run retained /);
      expect(message.slice(lineEnd + 2 + NOTICE.length)).toMatch(/^\n\nAccount attempts:\n/);
      expect(item.failure.logRefs).toContain(RETAINED);
      expect(failureMessageLine(message)).toBe(failureMessageLine(causeLine));
      // A real-sized record: appended after it, the notice would start past
      // 512 characters; after the cause line it ends well within them.
      expect(message.length - NOTICE.length - 2).toBeGreaterThanOrEqual(590);
      expect(message.indexOf(NOTICE) + NOTICE.length).toBeLessThanOrEqual(512);
      // With the same tries, the record without retained text is exactly the
      // original message: everything but the inserted notice is unchanged.
      const twin = runs.find(
        (other) => other.mode === item.mode && other.cause === item.cause && other.text === null,
      );
      if (twin) {
        const original = twin.failure.safeMessage;
        const end = original.indexOf("\n");
        expect(message).toBe(`${original.slice(0, end)}\n\n${NOTICE}${original.slice(end)}`);
      }
    }
    const health = aggregateRouteHealth(
      runs.map((item, index) => ({
        lifecycle: "failed",
        facts: routeHealthFactsOf({
          id: `job-${index}`,
          runId: `run-${index}`,
          state: "failed",
          runDir: item.runDir,
          params: { primaryHarness: "fake" },
        }),
      })),
      {
        from: "2026-10-26T00:00:00.000Z",
        generatedAt: "2026-11-02T00:00:00.000Z",
        complete: true,
        incompleteReason: null,
      },
    );
    expect(health.routes).toHaveLength(2);
    for (const route of health.routes) {
      const mode = route.access === "readonly" ? "ask" : "agent";
      const line = (cause: string) =>
        failureMessageLine(
          runs.find((item) => item.mode === mode && item.cause === cause)!.failure.safeMessage,
        );
      // With and without retained text, one cause is one group; a distinct cause stays distinct.
      expect(route.topFailures.map((group) => [group.message, group.count])).toEqual([
        [line(PIPE), 2],
        [line(AUTH), 1],
      ]);
      expect(route.topFailures.some((group) => group.message.includes("retained"))).toBe(false);
    }
  });

  it("fault selectors are path-aware: they select the same files on Windows paths", () => {
    for (const [api, root] of [
      [posix, "/test-run"],
      [win32, "C:\\test-run"],
    ] as const) {
      const record = api.join(root, "final", "failure.yaml");
      const temporary = api.join(root, "final", ".failure-unique.tmp");
      expect(fault.isFailureRecord(api, record)).toBe(true);
      expect(fault.inFinal(api, temporary)).toBe(true);
      // Strict negatives: another file, another directory, a look-alike name.
      expect(fault.isFailureRecord(api, temporary)).toBe(false);
      expect(fault.inFinal(api, api.join(root, "attempts", "a01", "failure.yaml"))).toBe(false);
      expect(fault.isFailureRecord(api, api.join(root, "finalx", "failure.yaml"))).toBe(false);
      expect(fault.inFinal(api, api.join(root, "final"))).toBe(false);
    }
  });

  it.each([
    ["before any byte is written", "before_write"],
    ["after a partial write", "partial_write"],
    ["when the replacement cannot be renamed into place", "rename"],
  ] as const)(
    "a failed record update %s keeps the announced output and the original record",
    async (_label, kind) => {
      const write = ArtifactStore.prototype.writeYaml;
      const spy = vi.spyOn(ArtifactStore.prototype, "writeYaml").mockImplementation(function (
        this: ArtifactStore,
        path: string,
        value: unknown,
      ) {
        const enrichment =
          kind !== "rename" &&
          fault.inFinal({ basename, dirname }, path) &&
          (value as RunFailure | null)?.logRefs?.includes(RETAINED) === true;
        if (!enrichment) return write.call(this, path, value);
        fault.original = readFileSync(join(path, "..", "failure.yaml"), "utf8");
        // node:fs writeFileSync opens (truncating) its target before ENOSPC.
        if (kind === "partial_write") writeFileSync(path, "phase: ask\ncateg");
        const code = kind === "before_write" ? "EACCES" : "ENOSPC";
        throw Object.assign(new Error(`${code}: injected ${kind} failure`), { code });
      });
      fault.rename = kind === "rename";
      fault.original = null;
      try {
        const out = await failedRun(
          "ask",
          [AUTH, DROPPED, PIPE],
          "Exact partial answer retained\n",
        );
        const runDir = out.result.runDir;
        expect(out.result.lifecycle).toBe("failed");
        expect(fault.original).not.toBeNull();
        // The original failure record survives byte for byte; no replacement is left behind.
        expect(readFileSync(finalPath(runDir, "failure.yaml"), "utf8")).toBe(fault.original);
        expect(failureOf(runDir).safeMessage).toContain(PIPE);
        expect(failureOf(runDir).safeMessage).not.toContain(NOTICE);
        expect(readdirSync(join(runDir, "final")).filter((name) => name.startsWith("."))).toEqual(
          [],
        );
        // The saved retained output is still announced and presented.
        expect(readFileSync(finalPath(runDir, "retained-output.md"), "utf8")).toContain(
          "Exact partial answer retained\n",
        );
        expect(
          out.events.filter(
            (e) => e.type === "output.ready" && e.payload["path"] === "final/retained-output.md",
          ),
        ).toHaveLength(1);
        const facts = new ArtifactStore(runDir).readYaml<Record<string, any>>(
          finalPath(runDir, "run_facts.yaml"),
        );
        expect(facts?.["presentation"]?.["primary"]).toEqual({
          kind: "report",
          path: "final/retained-output.md",
        });
        // Its own diagnostic, never the claim that the output was not saved.
        const statuses = out.events
          .filter((e) => e.type === "harness.event" && e.payload["type"] === "status")
          .map((e) => String(e.payload["text"]));
        expect(statuses.some((text) => text.includes("Retained output could not be saved"))).toBe(
          false,
        );
        expect(
          statuses.filter(
            (text) =>
              text.startsWith("The failure record could not name final/retained-output.md") &&
              text.includes("the original record is unchanged"),
          ),
        ).toHaveLength(1);
      } finally {
        spy.mockRestore();
        fault.rename = false;
      }
    },
  );
});

describe("a later terminal-facts failure record keeps naming the retained output", () => {
  it.each(["failed", "succeeded"] as const)(
    "the replacement record after a %s strategy terminal states its own cause first",
    async (lifecycle) => {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), "cx-retained-facts-")));
      try {
        const store = new ArtifactStore(repo);
        const paths = store.createRun("run-facts");
        const log = new EventLog(paths.eventsPath, "run-facts", "task-facts");
        // The terminal projection fails closed on an unreadable decision record.
        store.writeText(join(paths.arbitrationDir, "decision.yaml"), "winner: [malformed\n");
        const mode: ModeKind = "ask";
        const result = await guardAnnouncedRun(undefined, async (announce) => {
          log.emit("run.created", { mode, prompt: "x" });
          announce({
            log,
            store,
            paths,
            runId: "run-facts",
            taskId: "task-facts",
            mode,
            phase: "ask",
            spend: () => 0,
            recheckBudgetAfterBarrier: () => false,
          });
          const at = { attempt_id: "a01", harness_id: "fake", session_id: "ses-1" };
          log.emit("harness.event", {
            ...at,
            type: "message",
            text: "Draft kept\n",
            payload: { delta: true },
          });
          if (lifecycle === "succeeded")
            log.emit("harness.event", {
              ...at,
              type: "message",
              text: "Final answer",
              final: true,
            });
          if (lifecycle === "failed")
            writeFailure(store, paths, {
              phase: "ask",
              category: "harness_error",
              safeMessage: "strategy cause",
              runDir: paths.root,
            });
          log.emit(lifecycle === "failed" ? "run.failed" : "run.completed", {
            lifecycle,
            facts: makeOutcomeFacts(
              lifecycle,
              lifecycle === "failed" ? { reason: "harness_failed" } : {},
            ),
          });
          return {
            runId: "run-facts",
            taskId: "task-facts",
            mode,
            lifecycle,
            facts: makeOutcomeFacts(
              lifecycle,
              lifecycle === "failed" ? { reason: "harness_failed" } : {},
            ),
            winner: null,
            runDir: paths.root,
            summary: "strategy summary",
            candidates: [],
          };
        });
        expect(result.lifecycle).toBe("failed");
        const failure = RunFailure.parse(store.readYaml(join(paths.finalDir, "failure.yaml")));
        expect(failure.phase).toBe("terminal_facts");
        expect(readFileSync(join(paths.finalDir, "retained-output.md"), "utf8")).toContain(
          "Draft kept\n",
        );
        expect(failure.logRefs).toContain(RETAINED);
        expect(failure.safeMessage.startsWith("terminal facts preparation failed")).toBe(true);
        // The notice follows the cause line; the rest is the terminal's own text,
        // which summary.md keeps without it.
        const lineEnd = failure.safeMessage.indexOf("\n");
        const noticeEnd = lineEnd + 2 + NOTICE.length;
        expect(failure.safeMessage.slice(lineEnd, noticeEnd)).toBe(`\n\n${NOTICE}`);
        const original =
          failure.safeMessage.slice(0, lineEnd) + failure.safeMessage.slice(noticeEnd);
        expect(readFileSync(join(paths.finalDir, "summary.md"), "utf8")).toContain(
          `\n\n${original}\n`,
        );
        // Only the failure record carries the notice; the terminal's other texts keep the cause.
        expect(result.summary).not.toContain(NOTICE);
        log.dispose();
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );
});

describe("the notice in real-sized failure records (namingRetainedOutput)", () => {
  // SYNTHETIC three-try rows rendered by the one shared rendering (withPoolAttempts).
  const attempt = (tryIndex: number, error: string): PoolAttemptFailure => ({
    harnessId: "agy",
    profileId: "fixture-account",
    profileDisplayName: "fixture-account",
    requestedModel: "gemini-fixture-high",
    attemptId: "a01",
    tryIndex,
    observedAt: "2026-11-01T22:00:00.000Z",
    phase: "after_progress",
    category: "unknown_harness_error",
    error,
    vendorFailure: null,
  });
  const cause = `a01/agy: ${PIPE}`;
  const record = withPoolAttempts(cause, [attempt(0, AUTH), attempt(1, DROPPED), attempt(2, PIPE)]);

  it("follows the cause line, precedes the account attempts and ends within 512 characters", () => {
    // Real-sized: appended after the whole record, the notice would start past 512.
    expect(record.length).toBeGreaterThanOrEqual(590);
    const named = namingRetainedOutput(record, ["events.jsonl"], RETAINED);
    expect(named.safeMessage).toBe(`${cause}\n\n${NOTICE}${record.slice(cause.length)}`);
    expect(named.safeMessage.startsWith(`${cause}\n\n${NOTICE}\n\nAccount attempts:\n`)).toBe(true);
    expect(named.safeMessage.indexOf(NOTICE) + NOTICE.length).toBeLessThanOrEqual(512);
    expect(failureMessageLine(named.safeMessage)).toBe(failureMessageLine(record));
    expect(named.logRefs).toEqual(["events.jsonl", RETAINED]);
    expect(namingRetainedOutput(record, named.logRefs, RETAINED).logRefs).toEqual(named.logRefs);
  });

  it("keeps a multi-line cause's own next line, a single line and an empty message exact", () => {
    const multi = withPoolAttempts(`a01/agy: ${DROPPED}\nsecondary diagnostic`, [
      attempt(0, AUTH),
      attempt(1, PIPE),
      attempt(2, DROPPED),
    ]);
    const firstLine = `a01/agy: ${DROPPED}`;
    expect(namingRetainedOutput(multi, [], RETAINED).safeMessage).toBe(
      `${firstLine}\n\n${NOTICE}${multi.slice(firstLine.length)}`,
    );
    expect(namingRetainedOutput("strategy cause", [], RETAINED).safeMessage).toBe(
      `strategy cause\n\n${NOTICE}`,
    );
    expect(namingRetainedOutput("cause\r\nnext", [], RETAINED).safeMessage).toBe(
      `cause\n\n${NOTICE}\r\nnext`,
    );
    expect(namingRetainedOutput("", [], RETAINED).safeMessage).toBe(NOTICE);
  });

  it("a cause line longer than a reader's bound still leaves the notice past it", () => {
    const long = `a01/agy: ${"detail ".repeat(80)}`.trimEnd();
    const named = namingRetainedOutput(withPoolAttempts(long, [attempt(0, PIPE)]), [], RETAINED);
    expect(named.safeMessage.indexOf(NOTICE)).toBeGreaterThan(512);
    expect(failureMessageLine(named.safeMessage)).toBe(failureMessageLine(long));
    expect(named.logRefs).toEqual([RETAINED]);
  });
});
