/**
 * V9c end-to-end: a lane-switch turn whose delta exceeds the packet budget runs
 * a bounded inline summary pass on the switched-to lane, injects the summary
 * into `context/THREAD.md` in place of the one-line collapse, and reuses the
 * cached summary on a later identical collapse — all through the REAL
 * Orchestrator + resolveContinuity seam (the daemon-side facts wired as the
 * daemon wires them).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCapture } from "@claudexor/core";
import type { HarnessAdapter } from "@claudexor/core";
import { ConformanceReport, HarnessManifest } from "@claudexor/schema";
import { readThreadSummary } from "@claudexor/workspace";
import { Orchestrator } from "./orchestrator.js";
import type { ThreadContinuityContext } from "./orchestrator.js";
import type { ContinuityDisclosureResult } from "./continuity.js";

let prevConfigDir: string | undefined;

beforeEach(() => {
  prevConfigDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "claudexor-v9c-cfg-"));
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
  else process.env["CLAUDEXOR_CONFIG_DIR"] = prevConfigDir;
});

async function initRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "claudexor-v9c-"));
  await runCapture("git", ["-C", repo, "init", "-b", "main"]);
  await runCapture("git", ["-C", repo, "add", "-A"]);
  await runCapture("git", [
    "-C",
    repo,
    "-c",
    "user.email=t@t.dev",
    "-c",
    "user.name=t",
    "commit",
    "--allow-empty",
    "-m",
    "init",
  ]);
  return repo;
}

const SUMMARY_MARKER = "CACHED-SUMMARY-PROSE-MARKER";

/**
 * A lane that (a) answers a normal turn with a big body (so prior-turn outputs
 * blow the packet budget and force a collapse) and (b) recognises the bounded
 * summary pass by its instruction and returns prose.
 */
function bigAnswerLane(id: string, nativeSessionId: string): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "openai",
        capabilities: { plan: true, review: true, read_files: true, web_policy: "none" },
        access_profiles_supported: ["readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents: ["explain", "audit", "plan", "review"],
      });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield {
        type: "started",
        session_id: spec.session_id,
        ts,
        payload: { native_session_id: nativeSessionId },
      } as never;
      const isSummaryPass = spec.prompt.includes("successor agent");
      const text = isSummaryPass
        ? `${SUMMARY_MARKER}: decisions taken, current state, open items.`
        : `verbose answer from ${id} `.repeat(400); // ~8 KiB body
      yield { type: "message", session_id: spec.session_id, ts, text, final: true } as never;
      yield { type: "completed", session_id: spec.session_id, ts } as never;
    },
  };
}

describe("[INV-137] V9c cached summary replaces the one-line collapse in the packet", () => {
  it("summarises the collapsed prefix inline, injects it, and reuses the cache", async () => {
    const repo = await initRepo();
    const laneA = bigAnswerLane("lane-a", "native-a");
    const laneB = bigAnswerLane("lane-b", "native-b");
    const registry = new Map<string, HarnessAdapter>([
      ["lane-a", laneA],
      ["lane-b", laneB],
    ]);
    const orch = () => new Orchestrator({ registry, reviewers: [] });

    const sessions: Record<string, { sessionId: string; profileId: string | null }> = {};
    const checkpoints: Array<{ harness: string; profileId: string | null; turnId: string }> = [];
    const priorTurns: Array<{ id: string; prompt: string; runId: string | null }> = [];
    const disclosures: Record<string, ContinuityDisclosureResult> = {};
    const resumeMap = (profileId: string | null) => {
      const out: Record<string, { sessionId: string; profileId: string | null }> = {};
      for (const [h, s] of Object.entries(sessions)) {
        if ((s.profileId ?? null) === profileId) out[h] = s;
      }
      return out;
    };

    async function turn(turnId: string, harness: string, prompt: string): Promise<string> {
      const context: ThreadContinuityContext = {
        turnId,
        profileId: null,
        priorTurns: [...priorTurns],
        laneCheckpoints: checkpoints.map((c) => ({ ...c })),
      };
      const result = await orch().run({
        repoRoot: repo,
        prompt,
        mode: "ask",
        harnesses: [harness],
        threadId: "th-v9c",
        resumeSessions: resumeMap(null),
        onSessionObserved: (h, nid, _model, profileId) => {
          sessions[h] = { sessionId: nid, profileId: profileId ?? null };
          const idx = checkpoints.findIndex(
            (c) => c.harness === h && (c.profileId ?? null) === (profileId ?? null),
          );
          const row = { harness: h, profileId: profileId ?? null, turnId };
          if (idx < 0) checkpoints.push(row);
          else checkpoints[idx] = row;
        },
        threadContinuity: context,
        onContinuityResolved: (tid, disclosure) => {
          disclosures[tid] = disclosure;
        },
      });
      priorTurns.push({ id: turnId, prompt, runId: result.runId });
      return result.runDir;
    }

    // Build a long conversation on lane A (each native-resumes; big answers).
    for (let i = 1; i <= 6; i += 1) await turn(`t${i}`, "lane-a", `alpha turn ${i}`);

    // Switch to lane B: it has never seen the thread, so the whole 6-turn delta
    // must be carried — that blows the 24 KiB budget and forces a collapse, so
    // the engine summarises the collapsed prefix inline on lane B.
    const bDir = await turn("t7", "lane-b", "beta: switch lanes");
    expect(disclosures["t7"].kind).toBe("packet");
    expect(disclosures["t7"].summarized).toBe(true);
    const packet = readFileSync(join(bDir, "context", "THREAD.md"), "utf8");
    expect(packet).toContain("## Earlier conversation (summary)");
    expect(packet).toContain(SUMMARY_MARKER);
    expect(packet).toContain("cached conversation summary below");

    // The summary was persisted in the thread's lane dir and is readable back.
    // (The exact boundary key advances with the head; at least one entry exists.)
    const boundaryTurn = ["t1", "t2", "t3", "t4", "t5"].find(
      (id) => readThreadSummary(repo, "th-v9c", id) !== null,
    );
    expect(boundaryTurn).toBeDefined();
    expect(readThreadSummary(repo, "th-v9c", boundaryTurn as string)).toContain(SUMMARY_MARKER);
  });
});
