import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { EventLog, readRunEvents } from "@claudexor/event-log";
import { RunFailure } from "@claudexor/schema";
import { orderedAppender } from "@claudexor/util";
import { cancelledResult, failTerminally, writeFailure } from "./runTerminalResults.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function written(failure: Parameters<typeof writeFailure>[2]): RunFailure {
  const root = mkdtempSync(join(tmpdir(), "claudexor-write-failure-"));
  dirs.push(root);
  const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
  const paths = store.createRun("run-1");
  writeFailure(store, paths, failure);
  return RunFailure.parse(store.readYaml(join(paths.finalDir, "failure.yaml")));
}

const base = { phase: "harness", category: "harness_error", safeMessage: "at capacity" };

describe("writeFailure vendorFailure", () => {
  it("writes the vendor's typed failure verbatim beside the engine's own record", () => {
    const vendorFailure = {
      code: "server_overloaded",
      message: "Selected model is at capacity. Please try a different model.",
      source: "codex_rollout",
    };
    const failure = written({ ...base, vendorFailure });
    expect(failure.vendorFailure).toEqual(vendorFailure);
    // The engine's own classification is untouched by the vendor's code.
    expect(failure.category).toBe("harness_error");
    expect(failure.code).toBeNull();
  });

  it("writes null when there is no vendor-typed evidence (omitted or null)", () => {
    expect(written(base).vendorFailure).toBeNull();
    expect(written({ ...base, vendorFailure: null }).vendorFailure).toBeNull();
  });

  it("redacts a secret-like token inside the vendor's words and keeps null parts null (INV-146)", () => {
    // Assembled at runtime so the source never holds a contiguous secret-like token.
    const token = ["sk-or-v1", "c".repeat(40)].join("-");
    const failure = written({
      ...base,
      vendorFailure: { code: null, message: `rejected key ${token}`, source: "codex_rollout" },
    });
    expect(failure.vendorFailure?.code).toBeNull();
    expect(failure.vendorFailure?.message).not.toContain(token);
    expect(failure.vendorFailure?.message).toContain("[redacted]");
    expect(failure.vendorFailure?.source).toBe("codex_rollout");
  });
});

describe("a terminal helper meets a line its run lost (#704)", () => {
  /** A queued run log whose durable sink refuses the line with text "lost";
   * that line has landed and its failure is held, nobody awaiting it. */
  async function heldLoss(runId: string) {
    const root = mkdtempSync(join(tmpdir(), "claudexor-held-loss-"));
    dirs.push(root);
    const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
    const paths = store.createRun(runId);
    const log = new EventLog(
      paths.eventsPath,
      runId,
      "task-1",
      (event) => {
        if (event.payload["text"] === "lost") throw new Error("journal refused the line");
      },
      undefined,
      undefined,
      { queued: true },
    );
    log.emit("run.created", {});
    log.deferTerminal();
    log.emit("harness.event", { text: "lost" });
    await orderedAppender.drained(paths.eventsPath);
    return { store, paths, log };
  }

  const statement = "Run events did not reach the journal: journal refused the line";

  it("failTerminally still stashes its output and run.failed, and states the loss", async () => {
    const { store, paths, log } = await heldLoss("run-fail");
    const result = failTerminally(
      log,
      store,
      paths,
      "run-fail",
      "task-1",
      "agent",
      "race",
      new Error("all candidates failed"),
    );
    // Direction 1: neither its output nor its terminal is lost to the held failure.
    expect(log.deferredTerminalPending()?.type).toBe("run.failed");
    expect(String(log.deferredTerminalPending()?.payload["error"])).toContain(statement);
    await log.commitDeferredTerminal();
    expect(readRunEvents(paths.eventsPath).events.map((event) => event.type)).toEqual([
      "run.created",
      "harness.event",
      "output.ready",
      "run.failed",
    ]);
    // Direction 2: the strategy's own verdict and cause stand, the loss beside it.
    expect(result.lifecycle).toBe("failed");
    expect(result.summary).toContain("all candidates failed");
    expect(result.summary).toContain(statement);
    expect(
      RunFailure.parse(store.readYaml(join(paths.finalDir, "failure.yaml"))).safeMessage,
    ).toContain(statement);
  });

  it("cancelledResult still stashes its output and cancelled terminal, and states the loss", async () => {
    const { store, paths, log } = await heldLoss("run-cancel");
    const result = cancelledResult(
      log,
      "run-cancel",
      "task-1",
      "agent",
      paths.root,
      [],
      undefined,
      null,
      undefined,
      store,
    );
    expect(log.deferredTerminalPending()?.payload["lifecycle"]).toBe("cancelled");
    await log.commitDeferredTerminal();
    expect(
      readRunEvents(paths.eventsPath)
        .events.map((event) => event.type)
        .slice(-2),
    ).toEqual(["output.ready", "run.failed"]);
    expect(result.lifecycle).toBe("cancelled");
    expect(result.summary).toContain("run cancelled");
    expect(result.summary).toContain(statement);
    expect(readFileSync(join(paths.finalDir, "summary.md"), "utf8")).toContain(statement);
  });
});
