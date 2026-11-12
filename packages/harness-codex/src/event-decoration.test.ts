import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { HarnessRunSpec, type CredentialProfile, type HarnessEvent } from "@claudexor/schema";
import { decorateCodexEvent, type CodexEventDecoration } from "./event-decoration.js";
import { createCodexAdapter } from "./index.js";
import { resetRolloutReadStatsForTests, rolloutReadStatsForTests } from "./rollout-file.js";

// The decoration reads the run's rollout while codex is still writing it.
// Codex records a turn's `turn_context` seconds after the turn starts (2.3–3.1 s
// in the recorded 0.153.3 rollouts), so on a resumed session the previous
// turn's record is the last one for a while: it must not become this run's
// observed model, and looking again must not re-read the history.

const THREAD = "0199ffff-0000-7111-8222-333344445555";
const homes: string[] = [];
afterAll(() => homes.forEach((home) => rmSync(home, { recursive: true, force: true })), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
beforeEach(() => resetRolloutReadStatsForTests());

const json = (record: unknown) => JSON.stringify(record) + "\n";
const started = (turn: string) =>
  json({ type: "event_msg", payload: { type: "task_started", turn_id: turn, started_at: 1 } });
const turnContext = (turn: string, model: string) =>
  json({ type: "turn_context", payload: { turn_id: turn, model } });
const tokens = (used: number) =>
  json({
    type: "event_msg",
    payload: { type: "token_count", rate_limits: { primary: { used_percent: used } } },
  });
const item = (text: string) => json({ type: "response_item", payload: { type: "message", text } });

function rollout(content: string, home = mkdtempSync(join(tmpdir(), "codex-decoration-"))) {
  homes.push(home);
  const day = join(home, "sessions", "2026", "10", "28");
  mkdirSync(day, { recursive: true });
  const file = join(day, `rollout-2026-10-28T10-00-00-${THREAD}.jsonl`);
  writeFileSync(file, content);
  return { home, file };
}

function context(home: string, extra: Record<string, unknown> = {}): CodexEventDecoration {
  return {
    spec: HarnessRunSpec.parse({
      session_id: "s",
      intent: "explain",
      prompt: "p",
      cwd: "/w",
      ...extra,
    }),
    env: { CODEX_HOME: home },
    credentialRoute: "vendor_native",
    credentialSource: "native_session",
    tempCodexHome: null,
    model: null,
  };
}
const event = (type: HarnessEvent["type"], payload?: Record<string, unknown>): HarnessEvent => ({
  type,
  session_id: "s",
  ts: "2026-10-28T10:00:00.000Z",
  ...(type === "usage" ? { usage: { input_tokens: 1 } } : {}),
  ...(payload ? { payload } : {}),
});
const resumedHistory = started("t1") + turnContext("t1", "gpt-old") + tokens(40) + item("done");

describe("decorateCodexEvent transcript model (#336)", () => {
  it("a resumed run is stamped only once codex records the started turn, then keeps that model", () => {
    const { home, file } = rollout(resumedHistory);
    const ctx = context(home);
    const early = [
      decorateCodexEvent(
        event("started", { native_session_id: THREAD, native_turn_id: "t2" }),
        ctx,
      ),
      decorateCodexEvent(event("status"), ctx),
    ];
    expect(early.map((e) => e.observed_model)).toEqual([undefined, undefined]);
    appendFileSync(file, started("t2") + turnContext("t2", "gpt-new"));
    const later = decorateCodexEvent(event("status"), ctx);
    expect(later).toMatchObject({
      observed_model: "gpt-new",
      payload: { observed_model_source: "transcript" },
    });
    appendFileSync(file, turnContext("t3", "gpt-other"));
    expect(decorateCodexEvent(event("usage"), ctx).observed_model).toBe("gpt-new");
  });

  // Review finding: app-server goal continuations start later root turns in
  // the same run while `started` names only the first. When codex records the
  // next turn before the decoration reads again, the started turn's record
  // must still supply the model, without another pass over the file.
  it("keeps the started turn's model when a goal continuation is recorded before the next read", () => {
    const { home, file } = rollout(resumedHistory);
    const ctx = context(home);
    decorateCodexEvent(event("started", { native_session_id: THREAD, native_turn_id: "t2" }), ctx);
    const goal =
      started("t2") + turnContext("t2", "gpt-new") + started("t3") + turnContext("t3", "gpt-goal");
    appendFileSync(file, goal);
    const status = decorateCodexEvent(event("status"), ctx);
    const completed = decorateCodexEvent(
      event("completed", { native_session_id: THREAD, native_turn_id: "t3" }),
      ctx,
    );
    expect([status.observed_model, completed.observed_model]).toEqual(["gpt-new", "gpt-new"]);
    expect(rolloutReadStatsForTests().bytes).toBe(
      Buffer.byteLength(resumedHistory) + Buffer.byteLength(goal),
    );
  });

  it("an unreadable turn record after the started turn's leaves the model unknown", () => {
    const { home, file } = rollout(resumedHistory);
    const ctx = context(home);
    decorateCodexEvent(event("started", { native_session_id: THREAD, native_turn_id: "t2" }), ctx);
    const torn = turnContext("t3", "gpt-goal").slice(0, 40) + "\n";
    appendFileSync(file, turnContext("t2", "gpt-new") + torn + turnContext("t3", "gpt-goal"));
    expect(decorateCodexEvent(event("status"), ctx).observed_model).toBeUndefined();
    appendFileSync(file, turnContext("t2", "gpt-new"));
    expect(decorateCodexEvent(event("status"), ctx).observed_model).toBe("gpt-new");
  });

  // DISCLOSED RESIDUAL, pinned: the exec `--json` stream (reachable only from
  // tests; production runs the app-server, which names its turn) carries no
  // turn id, and no identity is guessed for it. Read before codex records the
  // resumed turn, the previous turn's record is taken, as before #336.
  it("RESIDUAL: without a native turn id the last recorded turn_context is taken", () => {
    const { home } = rollout(resumedHistory);
    const ctx = context(home);
    expect(
      decorateCodexEvent(event("started", { native_session_id: THREAD }), ctx).observed_model,
    ).toBe("gpt-old");
  });

  it("looking again for a missing model reads only the appended bytes, never the history", () => {
    const history = Array.from({ length: 2000 }, (_, i) =>
      item(`turn_context-free ${i} ` + "x".repeat(400)),
    ).join("");
    const { home, file } = rollout(history);
    const ctx = context(home);
    decorateCodexEvent(event("started", { native_session_id: THREAD, native_turn_id: "t1" }), ctx);
    for (let i = 0; i < 50; i++)
      expect(decorateCodexEvent(event("status"), ctx).observed_model).toBeUndefined();
    expect(rolloutReadStatsForTests().bytes).toBe(Buffer.byteLength(history));
    // Rewriting consumed bytes in place is invisible: they are not read again.
    const planted = turnContext("t1", "planted");
    writeFileSync(
      file,
      planted + " ".repeat(Buffer.byteLength(history) - Buffer.byteLength(planted) - 1) + "\n",
    );
    expect(decorateCodexEvent(event("status"), ctx).observed_model).toBeUndefined();
    const appended = started("t1") + turnContext("t1", "gpt-5.5") + tokens(12);
    appendFileSync(file, appended);
    const usage = decorateCodexEvent(event("usage"), ctx);
    expect(usage.observed_model).toBe("gpt-5.5");
    expect(usage.quota?.constraints[0]?.used_ratio).toBe(0.12);
    expect(rolloutReadStatsForTests().bytes).toBe(
      Buffer.byteLength(history) + Buffer.byteLength(appended),
    );
  });

  it("stream_only never touches the rollout, and a linked rollout yields neither model nor quota", () => {
    const plain = rollout(resumedHistory + started("t2") + turnContext("t2", "gpt-new"));
    const quiet = context(plain.home, { evidence_policy: "stream_only" });
    decorateCodexEvent(
      event("started", { native_session_id: THREAD, native_turn_id: "t2" }),
      quiet,
    );
    const usage = decorateCodexEvent(event("usage"), quiet);
    expect(usage.observed_model).toBeUndefined();
    expect(usage.quota).toBeUndefined();
    expect(rolloutReadStatsForTests()).toMatchObject({ bytes: 0, reads: 0 });
    if (process.platform === "win32") return;
    const linked = rollout("");
    rmSync(linked.file);
    symlinkSync(plain.file, linked.file);
    const ctx = context(linked.home);
    decorateCodexEvent(event("started", { native_session_id: THREAD, native_turn_id: "t2" }), ctx);
    const linkedUsage = decorateCodexEvent(event("usage"), ctx);
    expect(linkedUsage.observed_model).toBeUndefined();
    expect(linkedUsage.quota).toBeUndefined();
  });
});

// The real adapter wiring: the app-server stream names its turn on `started`,
// the decoration binds to it, and the events after codex records that turn
// carry the transcript model and quota of the run's own CODEX_HOME.
describe("codex adapter app-server run (wiring)", () => {
  /** Run the real adapter over a resumed profile rollout; `recorded` is what
   * codex writes after `started` and before `usage`. */
  async function run(recorded: string, completedTurn: string) {
    const owned = join(process.env.CLAUDEXOR_CONFIG_DIR as string, "test-tmp");
    mkdirSync(owned, { recursive: true });
    const profileHome = mkdtempSync(join(owned, "claudexor-codex-decoration-"));
    const { file } = rollout(resumedHistory, profileHome);
    const adapter = createCodexAdapter({
      detectVersion: async () => "codex-cli 0.162.1",
      probeEfforts: async () => null,
      probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
      hasApiKey: () => false,
      resolveProfileSecret: () => null,
      runAppServer: async function* (input): AsyncGenerator<HarnessEvent> {
        const at = (
          type: HarnessEvent["type"],
          extra: Partial<HarnessEvent> = {},
        ): HarnessEvent => ({
          type,
          session_id: input.spec.session_id,
          ts: "2026-10-28T10:00:00.000Z",
          ...extra,
        });
        yield at("started", { payload: { native_session_id: THREAD, native_turn_id: "t2" } });
        yield at("status", { text: "working" });
        // Codex records the resumed turn while the stream goes on.
        appendFileSync(file, recorded);
        yield at("usage", { usage: { input_tokens: 10, output_tokens: 2 } });
        yield at("completed", {
          payload: { native_session_id: THREAD, native_turn_id: completedTurn },
        });
      },
    });
    const credential_profile = {
      profile_id: "acc-resumed",
      harness_id: "codex",
      display_name: "Resumed",
      credential_kind: "config_dir_login",
      isolation_locator: profileHome,
      secret_ref: null,
      enabled: true,
      created_at: null,
    } as CredentialProfile;
    const events: HarnessEvent[] = [];
    for await (const ev of adapter.run(
      HarnessRunSpec.parse({
        session_id: "s-wiring",
        intent: "explain",
        prompt: "continue",
        cwd: process.cwd(),
        credential_profile,
      }),
    ))
      events.push(ev);
    return { file, byType: (type: string) => events.find((ev) => ev.type === type) };
  }

  it("binds the transcript model of a resumed profile rollout to the started turn", async () => {
    const { file, byType } = await run(
      started("t2") + turnContext("t2", "gpt-new") + tokens(25),
      "t2",
    );
    expect(byType("started")?.observed_model).toBeUndefined();
    expect(byType("status")?.observed_model).toBeUndefined();
    expect(byType("usage")).toMatchObject({
      observed_model: "gpt-new",
      quota: { source: "codex_rollout", subject_id: "acc-resumed" },
    });
    expect(byType("usage")?.quota?.constraints[0]?.used_ratio).toBe(0.25);
    expect(byType("completed")?.observed_model).toBe("gpt-new");
    expect(readFileSync(file, "utf8")).toContain("gpt-old"); // the history stays the vendor's
  });

  it("keeps the started turn's model when a goal continuation is recorded before the next event", async () => {
    const { byType } = await run(
      started("t2") +
        turnContext("t2", "gpt-new") +
        started("t3") +
        turnContext("t3", "gpt-goal") +
        tokens(30),
      "t3",
    );
    expect(byType("usage")?.observed_model).toBe("gpt-new");
    expect(byType("usage")?.quota?.constraints[0]?.used_ratio).toBe(0.3);
    expect(byType("completed")?.observed_model).toBe("gpt-new");
  });
});
