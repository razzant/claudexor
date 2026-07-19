/**
 * A→B→A continuity canary (INV-137, D7). If this fails, a thread turn silently
 * lost the rest of its conversation when it switched lanes — a release-blocking
 * data-loss-class bug. Fix the product, never the story (unless the owner
 * approved a CONCEPT-CHANGE for INV-137).
 *
 * The story runs three ask turns of ONE thread across two harness lanes
 * (A → B → A) through the REAL Orchestrator, wiring the per-turn continuity
 * facts exactly as the daemon does, and asserts the marker of an earlier turn
 * is CARRIED into the switched lane's `context/THREAD.md` packet — plus the
 * visible disclosure (fresh → packet → packet, native-resume delta on return).
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCapture } from "@claudexor/core";
import type { HarnessAdapter } from "@claudexor/core";
import { ConformanceReport, HarnessManifest } from "@claudexor/schema";
import { Orchestrator } from "./orchestrator.js";
import type { ThreadContinuityContext } from "./orchestrator.js";
import type { ContinuityDisclosureResult } from "./continuity.js";

async function initRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "claudexor-continuity-"));
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

/** An ask harness that emits a stable native session id and echoes a marker. */
function askLane(id: string, nativeSessionId: string): HarnessAdapter {
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
    // eslint-disable-next-line require-yield
    async *run(spec) {
      const ts = new Date().toISOString();
      yield {
        type: "started",
        session_id: spec.session_id,
        ts,
        payload: { native_session_id: nativeSessionId },
      } as never;
      yield {
        type: "message",
        session_id: spec.session_id,
        ts,
        text: `answer from ${id}`,
      } as never;
      yield { type: "completed", session_id: spec.session_id, ts } as never;
    },
  };
}

describe("[INV-137:a-b-a-continuity] A→B→A thread continuity carries the missed delta across lanes", () => {
  it("discloses fresh → packet → packet and materializes the earlier turn into the switched lane's THREAD.md", async () => {
    const repo = await initRepo();
    const laneA = askLane("lane-a", "native-a");
    const laneB = askLane("lane-b", "native-b");
    const registry = new Map<string, HarnessAdapter>([
      ["lane-a", laneA],
      ["lane-b", laneB],
    ]);
    const orch = () => new Orchestrator({ registry, reviewers: [] });

    // --- Daemon-side state the runner owns (thread store stand-in) ---
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
        threadId: "th-aba",
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

    // Turn 1 on lane A: the thread's first move — nothing to carry.
    await turn("t1", "lane-a", "SEED-PROMPT-ALPHA: teach me about widgets");
    expect(disclosures["t1"].kind).toBe("fresh");

    // Turn 2 switches to lane B: B has never seen the conversation, so the
    // engine must hydrate it with a packet carrying turn 1 verbatim.
    const t2Dir = await turn("t2", "lane-b", "BETA-PROMPT: now compare them");
    expect(disclosures["t2"].kind).toBe("packet");
    expect(disclosures["t2"].packetTurns).toBe(1);
    expect(disclosures["t2"].laneSwitchedFrom?.harness).toBe("lane-a");
    const t2Packet = readFileSync(join(t2Dir, "context", "THREAD.md"), "utf8");
    // MARKER CARRY: turn 1's prompt (and answer) reached lane B's context.
    expect(t2Packet).toContain("SEED-PROMPT-ALPHA");
    expect(t2Packet).toContain("answer from lane-a");

    // Turn 3 returns to lane A: A's native session already holds turn 1, so the
    // engine resumes it natively and carries ONLY the missed delta (turn 2).
    const t3Dir = await turn("t3", "lane-a", "GAMMA-PROMPT: wrap up");
    expect(disclosures["t3"].kind).toBe("packet");
    expect(disclosures["t3"].packetTurns).toBe(1); // only turn 2, not turn 1
    expect(disclosures["t3"].laneSwitchedFrom?.harness).toBe("lane-b");
    const t3Packet = readFileSync(join(t3Dir, "context", "THREAD.md"), "utf8");
    // The delta is turn 2 only — turn 1 is already in lane A's native session.
    expect(t3Packet).toContain("BETA-PROMPT");
    expect(t3Packet).not.toContain("SEED-PROMPT-ALPHA");
    // The packet was delivered as a FILE, never embedded in the prompt body.
    expect(existsSync(join(t3Dir, "context", "THREAD.md"))).toBe(true);
  });
});
