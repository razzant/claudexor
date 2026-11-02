/**
 * #405 (INV-137): a thread turn that ended without a final answer still
 * reaches the next lane with what it said, marked as unfinished.
 *
 * Turn 1 runs on lane A and stops after speaking (a broken stream, or the
 * #299 max-turns cap). Turn 2 switches to lane B. The thread facts come from
 * the daemon's own producer (`threadContinuityContext`) over a thread-store
 * stand-in, the real Orchestrator builds the packet, and the assertions read
 * the file lane B's process is pointed at: the next turn's actual input.
 */
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { runCapture, turnLimitError, type HarnessAdapter } from "@claudexor/core";
import {
  ConformanceReport,
  HarnessManifest,
  type HarnessEvent,
  type HarnessRunSpec,
} from "@claudexor/schema";
import { readThreadSummary, writeThreadSummary } from "@claudexor/workspace";
import { threadContinuityContext } from "../../cli/src/thread-continuity-context.js";
import { buildContinuation } from "./continuity.js";
import { threadContinuityRequest } from "./continuity-facts.js";
import { Orchestrator } from "./orchestrator.js";

const reapDirs: string[] = [];
function reapMk(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  reapDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of reapDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function initRepo(): Promise<string> {
  const repo = reapMk("claudexor-thread-partial-");
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

const PARTIAL = "PARTIAL-ALPHA-FINDING: the retry loop ignores the deadline";
/** A long unfinished turn: its newest state is its last line, past the 4 KiB output allowance. */
const STEPS = Array.from({ length: 400 }, (_, i) => `step ${i}: read module ${i}, nothing new.`);
const LONG_PARTIAL = `${STEPS.join("\n")}\nLATEST-STATE: the deadline check belongs in retry.ts`;
const PREAMBLE = "Attempts and physical sessions are kept separate.";
type Ending = "stream_broke" | "turn_cap" | "answered" | "planned";
/** A long answered turn: three of them after turn 1 outgrow the 24 KiB packet budget. */
const filler = (kind: "PROMPT" | "ANSWER", n: number) => `FILLER-${kind}-${n} ${"f".repeat(6144)}`;
const FRESH_SUMMARY = "FRESH-SUMMARY: the earlier turns read the retry modules.";
/** What a summary cached before #405 says: nothing of the unfinished turn. */
const CACHED_SUMMARY = "CACHED-SUMMARY: the earlier turns read the retry modules.";

/** Lane A: speaks, then ends the way the case says; a filler prompt gets its long answer. */
function laneA(ending: Ending, speech: string): HarnessAdapter {
  return lane("lane-a", (spec) => {
    const ts = new Date().toISOString();
    const base = { session_id: spec.session_id, ts };
    const started: HarnessEvent = {
      ...base,
      type: "started",
      payload: { native_session_id: "native-a" },
    };
    const fill = /FILLER-PROMPT-(\d)/.exec(spec.prompt)?.[1];
    if (fill)
      return [
        started,
        { ...base, type: "message", text: filler("ANSWER", Number(fill)), final: true },
        { ...base, type: "completed", payload: { exit_code: 0 } },
      ];
    const events: HarnessEvent[] = [started, { ...base, type: "message", text: speech }];
    if (ending === "answered" || ending === "planned")
      events.push({ ...base, type: "message", text: "FINAL-ANSWER-ALPHA", final: true });
    if (ending === "stream_broke")
      events.push({ ...base, type: "error", error: "vendor stream closed mid-turn" });
    if (ending === "turn_cap")
      events.push(turnLimitError(spec.session_id, ts, "error_max_turns", 3));
    events.push({
      ...base,
      type: "completed",
      payload:
        ending === "answered" || ending === "planned"
          ? { exit_code: 0 }
          : { exit_code: 1, harness_reported_error: true },
    });
    return events;
  });
}

function lane(id: string, script: (spec: HarnessRunSpec) => HarnessEvent[]): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "local",
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
      for (const event of script(spec)) yield event;
    },
  };
}

/** Two turns of one thread; returns the packet lane B's process was pointed at.
 * `forget` deletes turn 1's named final files: its terminal facts, as when they
 * cannot be read, and its retained output, as when its terminal never wrote it.
 * With `summary`, three long answered turns follow turn 1 on lane A, so lane B's
 * packet collapses turns 1 and 2 under a summary keyed by turn 2: lane B's own
 * summary pass writes it (`fresh`), or it was already cached (`cached`). */
async function nextLaneInput(
  ending: Ending,
  options: {
    forget?: ReadonlyArray<"run_facts.yaml" | "retained-output.md">;
    mode?: "ask" | "plan";
    speech?: string;
    summary?: "fresh" | "cached";
  } = {},
) {
  const repo = await initRepo();
  const received: string[] = [];
  let summaryPasses = 0;
  const laneB = lane("lane-b", (spec) => {
    // The bounded summary pass (V9c) runs on the switching lane before its turn.
    const summarizing = spec.prompt.includes("successor agent");
    if (summarizing) summaryPasses += 1;
    else received.push(spec.prompt);
    const text = summarizing ? FRESH_SUMMARY : "answer from lane-b";
    const ts = new Date().toISOString();
    return [
      {
        session_id: spec.session_id,
        ts,
        type: "started",
        payload: { native_session_id: "native-b" },
      },
      { session_id: spec.session_id, ts, type: "message", text, final: true },
      { session_id: spec.session_id, ts, type: "completed" },
    ];
  });
  const registry = new Map<string, HarnessAdapter>([
    ["lane-a", laneA(ending, options.speech ?? PARTIAL)],
    ["lane-b", laneB],
  ]);
  // Thread-store stand-in: exactly the rows the daemon projection reads.
  const turns: { id: string; prompt: string; run_id: string | null; created_at: string }[] = [];
  const checkpoints: { harness_id: string; profile_id: string | null; turn_id: string }[] = [];
  const store = {
    getTurn: (id: string) => turns.find((t) => t.id === id),
    turnsFor: () => turns,
    laneCheckpointsForThread: () => checkpoints,
  };
  async function turn(id: string, harness: string, prompt: string, mode: "ask" | "plan") {
    turns.push({ id, prompt, run_id: null, created_at: `2026-11-01T00:00:0${turns.length}Z` });
    const result = await new Orchestrator({ registry, reviewers: [] }).run({
      repoRoot: repo,
      prompt,
      mode,
      harnesses: [harness],
      threadId: "th-partial",
      threadContinuity: threadContinuityContext({
        threads: store,
        threadId: "th-partial",
        turnId: id,
        profileId: null,
      }),
      onSessionObserved: (h, _nid, _model, profileId) => {
        checkpoints.push({ harness_id: h, profile_id: profileId ?? null, turn_id: id });
      },
    });
    turns.find((t) => t.id === id)!.run_id = result.runId;
    return result;
  }
  const planned = ending === "planned";
  const first = await turn(
    "t1",
    "lane-a",
    "SEED-PROMPT: audit the retry loop",
    options.mode ?? (planned ? "plan" : "ask"),
  );
  expect(first.lifecycle === "succeeded").toBe(ending === "answered" || planned);
  for (const name of options.forget ?? []) unlinkSync(join(first.runDir, "final", name));
  if (options.summary) {
    for (const n of [2, 3, 4]) await turn(`t${n}`, "lane-a", filler("PROMPT", n), "ask");
    if (options.summary === "cached") writeThreadSummary(repo, "th-partial", "t2", CACHED_SUMMARY);
  }
  await turn(options.summary ? "t5" : "t2", "lane-b", "NEXT-PROMPT: continue the audit", "ask");
  const prompt = received.at(-1) ?? "";
  const path = /context for this thread is at: (.+?) — read it/.exec(prompt)?.[1];
  return {
    prompt,
    packet: path ? readFileSync(path, "utf8") : "",
    firstRunDir: first.runDir,
    summaryPasses,
    repo,
    threads: store,
  };
}

describe("#405 a turn without a final answer reaches the next lane as unfinished, not lost", () => {
  it.each<Ending>(["stream_broke", "turn_cap"])(
    "%s: lane B's packet carries turn 1's recorded output, labelled as no final answer",
    async (ending) => {
      const { packet } = await nextLaneInput(ending);
      expect(packet).toContain("SEED-PROMPT: audit the retry loop");
      expect(packet).toContain(PARTIAL);
      expect(packet).toContain("ended without a final answer");
      expect(packet).not.toContain("_(no recorded output)_");
      // An unfinished turn is never presented as the assistant's answer.
      expect(packet).not.toContain("**The assistant answered:**");
    },
  );

  it("control: a successful plan turn (no answer.md by design) is not called unfinished", async () => {
    const { packet } = await nextLaneInput("planned");
    expect(packet).toContain("SEED-PROMPT: audit the retry loop");
    expect(packet).toContain("## Active plan");
    expect(packet).not.toContain("ended without a final answer");
  });

  it("positive control: an answered turn is still carried as the answer", async () => {
    const { packet } = await nextLaneInput("answered");
    expect(packet).toContain("**The assistant answered:**");
    expect(packet).toContain("FINAL-ANSWER-ALPHA");
    expect(packet).not.toContain("ended without a final answer");
  });

  it("a turn whose outcome cannot be read is carried without a claim about how it ended", async () => {
    const { packet } = await nextLaneInput("stream_broke", { forget: ["run_facts.yaml"] });
    expect(packet).toContain(PARTIAL);
    expect(packet).toContain(
      "No final answer is recorded for this turn, and its outcome could not be read.",
    );
    expect(packet).not.toContain("ended without a final answer");
    expect(packet).not.toContain("**The assistant answered:**");
  });

  it.each<Ending>(["stream_broke", "turn_cap"])(
    "%s in a Plan turn: lane B's packet carries it as unfinished, with no plan to point at",
    async (ending) => {
      const { packet } = await nextLaneInput(ending, { mode: "plan" });
      expect(packet).toContain("SEED-PROMPT: audit the retry loop");
      expect(packet).toContain(PARTIAL);
      expect(packet).toContain("The turn ended without a final answer.");
      expect(packet).not.toContain("## Active plan");
      expect(packet).not.toContain("**The assistant answered:**");
    },
  );

  it("a long unfinished turn keeps its newest output within the budget and names its retained file", async () => {
    const { packet, firstRunDir } = await nextLaneInput("turn_cap", { speech: LONG_PARTIAL });
    const retained = join(firstRunDir, "final", "retained-output.md");
    expect(packet).toContain("The turn ended without a final answer.");
    expect(packet).toContain("LATEST-STATE: the deadline check belongs in retry.ts");
    expect(packet).toContain("[earlier output truncated; the whole output is ");
    expect(packet).toContain(`complete in ${retained}]\n…`);
    // The retained file's fixed preamble and oldest lines are what the cut leaves out.
    expect(packet).not.toContain(PREAMBLE);
    expect(packet).not.toContain("step 0: read module 0");
  });

  // An engine restart leaves events.jsonl but neither terminal facts nor the
  // retained file; deleting both stands in for a terminal that never ran.
  it("a turn whose terminal never wrote its retained output is read from its event log, outcome unknown", async () => {
    const { packet } = await nextLaneInput("stream_broke", {
      forget: ["run_facts.yaml", "retained-output.md"],
    });
    expect(packet).toContain(PARTIAL);
    expect(packet).toContain(
      "No final answer is recorded for this turn, and its outcome could not be read.",
    );
    expect(packet).not.toContain("_(no recorded output)_");
    expect(packet).not.toContain("ended without a final answer");
    expect(packet).not.toContain("**The assistant answered:**");
  });

  it("a long turn read from its event log names the event log where it is cut", async () => {
    const { packet, firstRunDir } = await nextLaneInput("stream_broke", {
      forget: ["run_facts.yaml", "retained-output.md"],
      speech: LONG_PARTIAL,
    });
    expect(packet).toContain("LATEST-STATE: the deadline check belongs in retry.ts");
    expect(packet).toContain(`complete in ${join(firstRunDir, "events.jsonl")}]\n…`);
    expect(packet).not.toContain("ended without a final answer");
  });
});

const LEAD =
  "Recorded output of the summarized turns that have no final answer (not a completion verdict):";
const turn1Line = (packet: string) => packet.split("\n").find((l) => l.startsWith("- Turn 1 "));

describe("#405 a summary of the collapsed turns keeps an unfinished turn's output and file", () => {
  it.each([
    ["fresh", "retained file", []],
    ["cached", "retained file", []],
    ["fresh", "event log", ["run_facts.yaml", "retained-output.md"]],
    ["cached", "event log", ["run_facts.yaml", "retained-output.md"]],
  ] as const)("%s summary, turn 1 read from its %s", async (summary, from, forget) => {
    const { packet, firstRunDir, summaryPasses, repo } = await nextLaneInput("stream_broke", {
      summary,
      forget,
      speech: LONG_PARTIAL,
    });
    const text = summary === "fresh" ? FRESH_SUMMARY : CACHED_SUMMARY;
    const [file, note] =
      from === "event log"
        ? [join(firstRunDir, "events.jsonl"), "no final answer recorded; outcome could not be read"]
        : [join(firstRunDir, "final", "retained-output.md"), "ended without a final answer"];
    expect(packet).toContain(
      `## Earlier conversation (summary)\n\n${text}\n\n${LEAD}\n\n` +
        `- Turn 1 — user: SEED-PROMPT: audit the retry loop · assistant (${note}): …`,
    );
    expect(turn1Line(packet)).toContain("LATEST-STATE: the deadline check belongs in retry.ts");
    expect(turn1Line(packet)?.endsWith(` (whole output: ${file})`)).toBe(true);
    // The answered turn 2 stays replaced by the summary; turns 3 and 4 are verbatim.
    expect(packet).not.toContain("FILLER-ANSWER-2");
    expect(packet).toContain("\n\n## Recent turns\n\n### Turn 3\n");
    expect(packet).toContain("FILLER-ANSWER-4");
    // Fresh: lane B's one pass wrote the boundary's cache entry. Cached: no pass ran.
    expect(summaryPasses).toBe(summary === "fresh" ? 1 : 0);
    expect(readThreadSummary(repo, "th-partial", "t2")).toBe(text);
  });

  it("a capped Plan turn is kept beside the summary like an Ask turn, with no plan to point at", async () => {
    const { packet, firstRunDir } = await nextLaneInput("turn_cap", {
      summary: "fresh",
      mode: "plan",
      speech: LONG_PARTIAL,
    });
    const file = join(firstRunDir, "final", "retained-output.md");
    expect(packet).toContain(`${LEAD}\n\n- Turn 1 — user: SEED-PROMPT: audit the retry loop · `);
    expect(turn1Line(packet)).toContain("assistant (ended without a final answer): …");
    expect(turn1Line(packet)?.endsWith(` (whole output: ${file})`)).toBe(true);
    expect(packet).not.toContain("## Active plan");
  });

  it("control: an answered or planned turn 1 stays replaced by the summary, as before", async () => {
    for (const ending of ["answered", "planned"] as const) {
      const { packet } = await nextLaneInput(ending, { summary: "fresh" });
      expect(packet).toContain(
        `## Earlier conversation (summary)\n\n${FRESH_SUMMARY}\n\n## Recent turns\n`,
      );
      expect(packet).not.toContain(LEAD);
      expect(turn1Line(packet)).toBeUndefined();
      expect(packet).not.toContain("FINAL-ANSWER-ALPHA");
      expect(packet.includes("## Active plan")).toBe(ending === "planned");
    }
  });
});

describe("#405 a prior turn's output is read only for the turns a packet carries", () => {
  it("a turn the lane's native session holds is never read, and the packet is unchanged", async () => {
    // t1 ended unfinished on lane A, t2 answered on lane B; the next turn is t3.
    const { threads, repo } = await nextLaneInput("stream_broke");
    const ctx = threadContinuityContext({
      threads,
      threadId: "th-partial",
      turnId: "t3",
      profileId: null,
    })!;
    const store = new ArtifactStore(repo);
    const request = (harness: string, resume: boolean) =>
      threadContinuityRequest(ctx, { harness, profileId: null }, resume, store, repo);
    const read = async (harness: string, resume: boolean) =>
      (await request(harness, resume)).priorTurns.map((t) => t.outputText !== "");
    // Lane A holds t1 natively and is told t2; lane B holds both; a lane that
    // cannot resume natively is told, and reads, every turn.
    expect(await read("lane-a", true)).toEqual([false, true]);
    expect(await read("lane-b", true)).toEqual([false, false]);
    expect(await read("lane-b", false)).toEqual([true, true]);
    expect((await request("lane-b", false)).priorTurns[0]).toMatchObject({
      noFinalAnswer: "ended",
      outputSource: expect.any(String),
    });
    // What a packet renders does not depend on the turns it never carries.
    const told = await request("lane-a", true);
    const everything = await request("lane-a", false);
    expect(buildContinuation(told)).toEqual(
      buildContinuation({ ...told, priorTurns: everything.priorTurns }),
    );
    expect(buildContinuation(told).packetMarkdown).toContain("answer from lane-b");
  });
});

/** The same harness on another account is another lane (INV-137): the unfinished
 * turn reaches it the same way. Accounts are registry rows of a fake harness. */
describe("#405 an unfinished turn reaches the next account of the same harness", () => {
  async function nextAccountInput(ending: "stream_broke" | "turn_cap") {
    const repo = await initRepo();
    const configDir = reapMk("claudexor-thread-accounts-");
    // vitest.setup.ts restores the sandbox config dir after each test.
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    writeFileSync(
      join(configDir, "config.yaml"),
      JSON.stringify({
        credential_profiles: ["a", "b"].map((id) => ({
          profile_id: id,
          harness_id: "acct",
          display_name: id,
          credential_kind: "config_dir_login",
          isolation_locator: join(configDir, `store-${id}`),
        })),
      }),
    );
    const spawns: { profile: string | null; prompt: string }[] = [];
    const adapter: HarnessAdapter = {
      id: "acct",
      async discover() {
        return HarnessManifest.parse({
          id: "acct",
          display_name: "acct",
          kind: "local_cli",
          provider_family: "local",
          capabilities: {
            plan: true,
            review: true,
            explain: true,
            audit: true,
            read_files: true,
            web_policy: "none",
          },
          auth_modes: ["local_session"],
          access_profiles_supported: ["readonly"],
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: "acct",
          status: "ok",
          enabled_intents: ["explain", "audit", "plan", "review"],
          auth_sources: [
            { source: "native_session", availability: "available", verification: "passed" },
          ],
        });
      },
      async probeCredentialProfile(profile) {
        return {
          profile_id: profile.profile_id,
          harness_id: "acct",
          availability: "available",
          verification: "passed",
          verification_source: "local_store",
          last_verified_at: new Date().toISOString(),
        };
      },
      // eslint-disable-next-line require-yield
      async *run(spec: HarnessRunSpec) {
        const profile = spec.credential_profile?.profile_id ?? null;
        spawns.push({ profile, prompt: spec.prompt });
        const ts = new Date().toISOString();
        const base = {
          session_id: spec.session_id,
          ts,
          credential_profile_id: profile ?? undefined,
        };
        const events: HarnessEvent[] = [
          { ...base, type: "started", payload: { native_session_id: `native-${profile}` } },
        ];
        if (profile === "a") {
          events.push({ ...base, type: "message", text: PARTIAL });
          events.push(
            ending === "turn_cap"
              ? turnLimitError(spec.session_id, ts, "error_max_turns", 3)
              : { ...base, type: "error", error: "vendor stream closed mid-turn" },
          );
          events.push({
            ...base,
            type: "completed",
            payload: { exit_code: 1, harness_reported_error: true },
          });
        } else {
          events.push({ ...base, type: "message", text: "answer from account b", final: true });
          events.push({ ...base, type: "completed" });
        }
        for (const event of events) yield event;
      },
    };
    const turns: { id: string; prompt: string; run_id: string | null; created_at: string }[] = [];
    const checkpoints: { harness_id: string; profile_id: string | null; turn_id: string }[] = [];
    const store = {
      getTurn: (id: string) => turns.find((t) => t.id === id),
      turnsFor: () => turns,
      laneCheckpointsForThread: () => checkpoints,
    };
    async function turn(id: string, profile: "a" | "b", prompt: string) {
      turns.push({ id, prompt, run_id: null, created_at: `2026-11-01T00:00:0${turns.length}Z` });
      const result = await new Orchestrator({
        registry: new Map([["acct", adapter]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        prompt,
        mode: "ask",
        harnesses: ["acct"],
        credentialProfileId: profile,
        authPreference: "subscription",
        threadId: "th-accounts",
        threadContinuity: threadContinuityContext({
          threads: store,
          threadId: "th-accounts",
          turnId: id,
          profileId: profile,
        }),
        onSessionObserved: (h, _nid, _model, profileId) => {
          checkpoints.push({ harness_id: h, profile_id: profileId ?? null, turn_id: id });
        },
      });
      turns.find((t) => t.id === id)!.run_id = result.runId;
      return result;
    }
    const first = await turn("t1", "a", "SEED-PROMPT: audit the retry loop");
    await turn("t2", "b", "NEXT-PROMPT: continue the audit");
    const prompt = spawns.at(-1)?.prompt ?? "";
    const path = /context for this thread is at: (.+?) — read it/.exec(prompt)?.[1];
    return {
      first: first.lifecycle,
      profiles: spawns.map((s) => s.profile),
      packet: path ? readFileSync(path, "utf8") : "",
    };
  }

  it.each(["stream_broke", "turn_cap"] as const)(
    "%s on account a: account b's packet carries it as unfinished",
    async (ending) => {
      const { first, profiles, packet } = await nextAccountInput(ending);
      expect({ first, profiles }).toEqual({
        first: ending === "turn_cap" ? "interrupted" : "failed",
        profiles: ["a", "b"],
      });
      expect(packet).toContain("SEED-PROMPT: audit the retry loop");
      expect(packet).toContain(PARTIAL);
      expect(packet).toContain("The turn ended without a final answer.");
      expect(packet).not.toContain("**The assistant answered:**");
    },
  );
});
