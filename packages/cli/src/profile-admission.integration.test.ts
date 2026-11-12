import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { updateGlobalConfig, updateTrustConfig } from "@claudexor/config";
import {
  ingress,
  recorder,
  resetRecorder,
  sum,
} from "./test-support/profile-admission-adapters.js";
import {
  closeDaemons,
  configure,
  finishFixture,
  http,
  observe,
  openDaemon,
  repository,
  succeeded,
  terminal,
  upload,
  type Row,
} from "./test-support/profile-admission-daemon.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

// Production-shaped consumers for requirements admission (owner decision:
// account readiness is checked by the normal run): the real Control API,
// queue, daemon runner and Orchestrator (test-support/profile-admission-daemon.ts)
// over real Codex/Claude discovery, doctor and profile probes, with instrumented
// run methods and no native model inventory/processing/continuity. The real fake
// harness is retained (test-support/profile-admission-adapters.ts). No provider starts.

vi.mock("./registry.js", async (original) => {
  const actual = await original<typeof import("./registry.js")>();
  const { HarnessGateway } = await import("@claudexor/gateway");
  const { fixtureRegistry } = await import("./test-support/profile-admission-adapters.js");
  const registry = (options: { includeFakes?: boolean } = {}) =>
    new Map(
      [...fixtureRegistry].filter(
        ([id]) => options.includeFakes !== false || !id.startsWith("fake-"),
      ),
    );
  return {
    ...actual,
    buildRegistry: registry,
    buildGateway: (options: { includeFakes?: boolean } = {}) =>
      new HarnessGateway(registry(options)),
  };
});

afterEachClosed(async () => {
  const handOverFolders = await closeDaemons();
  resetRecorder();
  return handOverFolders;
}, 60_000);
afterAll(() => finishFixture(process.env.CLAUDEXOR_TEST_ADMISSION_OBSERVATIONS), 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

const codexRows: Row[] = [
  { id: "work", harness: "codex" },
  { id: "sticky", harness: "codex" },
  { id: "spare", harness: "codex" },
  { id: "off", harness: "codex", enabled: false },
  { id: "cl-work", harness: "claude" },
];

/** MIME admission fixture, not a PDF parser/reader test; every byte uses HTTP. */
async function uploadPdf(daemon: Awaited<ReturnType<typeof openDaemon>>) {
  const bytes = Buffer.from("%PDF-1.4\n% admission fixture\n%%EOF\n");
  const created = await http(daemon, "POST", "/uploads", {
    kind: "file",
    mime: "application/pdf",
    name: "notes.pdf",
    sizeBytes: bytes.length,
  });
  expect(created.status).toBe(201);
  const uploadId = String(created.body["uploadId"]);
  const written = await fetch(`${daemon.base}/v2/uploads/${uploadId}/bytes`, {
    method: "PUT",
    headers: {
      authorization: "Bearer fixture",
      "X-Claudexor-Protocol-Major": "3",
      "Content-Type": "application/octet-stream",
    },
    body: bytes,
  });
  expect(written.status).toBe(200);
  const finalized = await http(daemon, "POST", `/uploads/${uploadId}/finalize`, {});
  expect(finalized.status).toBe(201);
  return { resourceId: String(finalized.body["resourceId"]) };
}

describe("requirements admission through the production Control API, queue and runner", () => {
  it("admits a named-only pin over a logged-out default HOME with attachments and Browser; the run uses that profile's store", async () => {
    const accounts = configure(codexRows, ["work", "cl-work"]);
    const daemon = await openDaemon();
    const repo = await repository(daemon);
    updateTrustConfig(repo, (config) => ({ ...config, allow_full_access: true }));
    const image = await upload(daemon, "image");
    const started = await http(daemon, "POST", "/runs", {
      prompt: "look at the pixel",
      mode: "agent",
      scope: { kind: "project", root: repo },
      access: "full",
      browser: true,
      credentialProfileId: "work",
      attachments: [image],
    });
    observe("named_only_attachment_browser", {
      status: started.status,
      code: started.body["code"],
    });
    expect(started.status).toBe(200);
    expect(sum(recorder.enqueues[0]!, /\.probe$/)).toBe(0);
    await succeeded(daemon, started);
    expect(recorder.spawns).toEqual([
      expect.objectContaining({
        harness: "codex",
        profile: "work",
        codexHome: accounts.home("work"),
        browser: true,
        attachments: ["image/png"],
      }),
    ]);
    // The exact selected CODEX_HOME above is the isolation assertion;
    // the instrumented run does not prove the native process's HOME.
    expect(String(recorder.spawns[0]!["codexHome"])).not.toMatch(/\/native\/codex$/);
  }, 180_000);

  it("projects request, thread-sticky, Settings and Auto pools exactly as execution does", async () => {
    configure(codexRows, ["work", "cl-work"]);
    const daemon = await openDaemon();
    const repo = await repository(daemon);
    const text = await upload(daemon, "file");
    const pdf = await uploadPdf(daemon);
    const body = (extra: Record<string, unknown>) => ({
      prompt: "read the notes",
      mode: "agent",
      scope: { kind: "project", root: repo },
      attachments: [text],
      ...extra,
    });
    // Both real manifests admit text; Settings still makes the pool strict.
    updateGlobalConfig((config) => ({
      ...config,
      routing: { ...config.routing, eligible_harnesses: ["codex", "claude"] },
    }));
    const settings = await http(daemon, "POST", "/runs", body({}));
    observe("settings_pool_text", { status: settings.status, code: settings.body["code"] });
    expect(settings.status).toBe(200);
    expect(recorder.enqueues).toHaveLength(1);
    expect(sum(recorder.enqueues[0]!, /\.probe$/)).toBe(0);
    await succeeded(daemon, settings);
    expect(recorder.spawns.at(-1)).toMatchObject({ attachments: ["text/plain"] });
    // PDF is supported by Codex and truly incompatible with Claude.
    const settingsPdf = await http(daemon, "POST", "/runs", body({ attachments: [pdf] }));
    observe("settings_pool_pdf", { status: settingsPdf.status, code: settingsPdf.body["code"] });
    expect(settingsPdf.status).toBe(400);
    expect(settingsPdf.body["code"]).toBe("attachment_pool_unsupported");
    expect(recorder.enqueues).toHaveLength(1);
    // An explicit request pool still wins over Settings.
    const explicit = await http(daemon, "POST", "/runs", body({ harnesses: ["claude"] }));
    expect(explicit.status).toBe(200);
    await succeeded(daemon, explicit);
    expect(recorder.spawns.at(-1)).toMatchObject({ harness: "claude", profile: "cl-work" });
    // Pure Auto admits text on both lanes; PDF drops Claude and routes Codex.
    updateGlobalConfig((config) => ({
      ...config,
      routing: { ...config.routing, eligible_harnesses: [] },
    }));
    const auto = await http(daemon, "POST", "/runs", body({}));
    observe("auto_rows_only_text", { status: auto.status, code: auto.body["code"] });
    expect(auto.status).toBe(200);
    await succeeded(daemon, auto);
    expect(recorder.spawns.at(-1)).toMatchObject({ attachments: ["text/plain"] });
    expect(["codex", "claude"]).toContain(recorder.spawns.at(-1)!["harness"]);
    const autoPdf = await http(daemon, "POST", "/runs", body({ attachments: [pdf] }));
    observe("auto_rows_only_pdf", { status: autoPdf.status, code: autoPdf.body["code"] });
    await succeeded(daemon, autoPdf);
    expect(recorder.spawns.at(-1)).toMatchObject({
      harness: "codex",
      profile: "work",
      attachments: ["application/pdf"],
    });
    expect(recorder.enqueues).toHaveLength(4);
    // A thread's projected sticky pool admits text and durably refuses mixed PDF.
    const thread = await http(daemon, "POST", "/threads", {
      scope: { kind: "project", root: repo },
      mode: "agent",
      eligibleHarnesses: ["codex", "claude"],
    });
    expect(thread.status).toBe(200);
    const threadId = String(thread.body["id"]);
    const before = recorder.enqueues.length;
    const sticky = await http(daemon, "POST", `/threads/${threadId}/turns`, {
      prompt: "read the notes",
      attachments: [text],
    });
    await succeeded(daemon, sticky);
    expect(recorder.enqueues).toHaveLength(before + 1);
    expect(daemon.graph.threads.turnsFor(threadId).at(-1)?.run_id).toBe(sticky.body["runId"]);
    const stickyPdf = await http(daemon, "POST", `/threads/${threadId}/turns`, {
      prompt: "read the PDF notes",
      attachments: [pdf],
    });
    expect(stickyPdf.status).toBe(400);
    expect(stickyPdf.body["code"]).toBe("attachment_pool_unsupported");
    expect(recorder.enqueues).toHaveLength(before + 1);
    expect(daemon.graph.threads.turnsFor(threadId).at(-1)?.enqueue_error).toMatchObject({
      code: "attachment_pool_unsupported",
      retryable: false,
    });
    expect(sum(ingress(), /\.probe$/)).toBe(0);
  }, 240_000);

  it("refuses missing, disabled and wrong-harness pins typed with no job, and never substitutes", async () => {
    configure(codexRows, ["work", "cl-work"]);
    const daemon = await openDaemon();
    const repo = await repository(daemon);
    const image = await upload(daemon, "image");
    const refusals: Record<string, unknown> = {};
    for (const [name, extra] of [
      ["auto_missing", { credentialProfileId: "ghost" }],
      ["auto_disabled", { credentialProfileId: "off" }],
      ["explicit_wrong_harness", { credentialProfileId: "work", harnesses: ["claude"] }],
      ["explicit_disabled", { credentialProfileId: "off", harnesses: ["codex"] }],
    ] as const) {
      const answer = await http(daemon, "POST", "/runs", {
        prompt: "look",
        mode: "agent",
        scope: { kind: "project", root: repo },
        attachments: [image],
        ...extra,
      });
      refusals[name] = {
        status: answer.status,
        code: answer.body["code"],
        message: answer.body["message"],
        probes: sum(ingress(), /\.probe$/),
      };
      expect.soft(answer.status, name).toBe(400);
      expect.soft(answer.body["code"], name).toBe("harness_unavailable");
      expect.soft(refusals[name], name).toMatchObject({ probes: 0 });
    }
    observe("strict_pin_refusals", refusals);
    expect(refusals).toMatchObject({
      auto_missing: { message: expect.stringMatching(/ghost.*not registered/) },
      auto_disabled: { message: expect.stringMatching(/off.*disabled/) },
      explicit_wrong_harness: {
        message: expect.stringMatching(/claude: .*"work".*not registered/),
      },
      explicit_disabled: { message: expect.stringMatching(/codex: .*"off".*disabled/) },
    });
    expect(recorder.enqueues).toHaveLength(0);
    expect(recorder.spawns).toEqual([]);
    // The same refusal on a thread turn is durable and is not retryable as a job replay.
    const thread = await http(daemon, "POST", "/threads", {
      scope: { kind: "project", root: repo },
      mode: "agent",
    });
    const threadId = String(thread.body["id"]);
    const turn = await http(daemon, "POST", `/threads/${threadId}/turns`, {
      prompt: "look",
      attachments: [image],
      credentialProfileId: "ghost",
    });
    observe("thread_missing_pin", { status: turn.status, code: turn.body["code"] });
    expect(turn.status).toBe(400);
    expect(turn.body["code"]).toBe("harness_unavailable");
    const refused = daemon.graph.threads.turnsFor(threadId).at(-1)!;
    expect(refused.run_id).toBeNull();
    expect(refused.enqueue_error).toMatchObject({ code: "harness_unavailable", retryable: false });
    const retry = await http(daemon, "POST", `/threads/${threadId}/turns/${refused.id}/retry`, {});
    expect(retry.status).toBe(409);
    expect(recorder.enqueues).toHaveLength(0);
  }, 180_000);

  it("default-only Auto with no member is refused typed", async () => {
    configure([], []);
    const daemon = await openDaemon();
    const repo = await repository(daemon);
    const image = await upload(daemon, "image");
    const answer = await http(daemon, "POST", "/runs", {
      prompt: "look",
      mode: "agent",
      scope: { kind: "project", root: repo },
      attachments: [image],
    });
    observe("default_only_auto_empty", { status: answer.status, code: answer.body["code"] });
    expect(answer.status).toBe(400);
    expect(answer.body["code"]).toBe("harness_unavailable");
    expect(String(answer.body["message"])).toMatch(
      /no doctor-OK default route or enabled account row/,
    );
    expect(recorder.enqueues).toHaveLength(0);
  }, 120_000);

  it("carries omission, id and null through the queue and runner; null keeps the thread's bound account", async () => {
    const accounts = configure(codexRows, ["work", "sticky", "spare", "cl-work"]);
    const daemon = await openDaemon();
    const repo = await repository(daemon);
    const image = await upload(daemon, "image");
    const thread = await http(daemon, "POST", "/threads", {
      scope: { kind: "project", root: repo },
      mode: "ask",
      primaryHarness: "codex",
      eligibleHarnesses: ["codex"],
      credentialProfileId: "sticky",
    });
    expect(thread.status).toBe(200);
    const threadId = String(thread.body["id"]);
    const turn = async (extra: Record<string, unknown>) => {
      const answer = await http(daemon, "POST", `/threads/${threadId}/turns`, {
        prompt: "describe the pixel",
        mode: "ask",
        attachments: [image],
        ...extra,
      });
      const run = await succeeded(daemon, answer);
      return {
        spawn: recorder.spawns.at(-1)!,
        poolSelected: run.events.some((event) => event.type === "route.account.pool_selected"),
        laneSwitch: run.events.find((event) => event.type === "route.account.lane_switch"),
      };
    };
    const explicit = await turn({ credentialProfileId: "work" });
    expect(explicit.spawn).toMatchObject({ profile: "work", codexHome: accounts.home("work") });
    expect(daemon.graph.threads.accountBindings(threadId)).toEqual({ codex: "work" });
    const cleared = await turn({ credentialProfileId: null });
    // Null clears the sticky pin; the durable binding, not the pool, answers.
    expect(cleared.spawn).toMatchObject({ profile: "work" });
    expect(cleared.poolSelected).toBe(false);
    const inherited = await turn({});
    expect(inherited.spawn).toMatchObject({
      profile: "sticky",
      codexHome: accounts.home("sticky"),
    });
    expect(daemon.graph.threads.accountBindings(threadId)).toEqual({ codex: "sticky" });
    // A bound account that stops answering switches lanes visibly; a pin never would.
    recorder.loggedIn.delete(resolve(accounts.home("sticky")));
    const switched = await turn({ credentialProfileId: null });
    expect(switched.spawn["profile"]).not.toBe("sticky");
    expect(switched.laneSwitch?.payload).toMatchObject({ from_profile_id: "sticky" });
    observe("profile_intent_through_runner", {
      explicit: explicit.spawn["profile"],
      cleared: cleared.spawn["profile"],
      inherited: inherited.spawn["profile"],
      switched: switched.spawn["profile"],
    });
    const params = daemon.graph.threads
      .turnsFor(threadId)
      .map((entry) => entry.run_id)
      .filter(Boolean);
    expect(params).toHaveLength(4);
    // Admission read no account for any of these turns.
    expect(recorder.enqueues.map((calls) => sum(calls, /\.probe$/))).toEqual([0, 0, 0, 0]);
  }, 240_000);

  it("replays an accepted run and turn by idempotency key even after admission would now refuse", async () => {
    configure(codexRows, ["work", "cl-work"]);
    const daemon = await openDaemon();
    const repo = await repository(daemon);
    const image = await upload(daemon, "image");
    const run = {
      prompt: "look",
      mode: "agent",
      scope: { kind: "project", root: repo },
      attachments: [image],
      credentialProfileId: "work",
    };
    const first = await http(daemon, "POST", "/runs", run, "replay-run");
    expect(first.status).toBe(200);
    await terminal(daemon, String(first.body["runId"]));
    const thread = await http(daemon, "POST", "/threads", {
      scope: { kind: "project", root: repo },
      mode: "ask",
    });
    const threadId = String(thread.body["id"]);
    const turnBody = {
      prompt: "describe",
      mode: "ask",
      attachments: [image],
      credentialProfileId: "work",
    };
    const firstTurn = await http(
      daemon,
      "POST",
      `/threads/${threadId}/turns`,
      turnBody,
      "replay-turn",
    );
    expect(firstTurn.status).toBe(200);
    await terminal(daemon, String(firstTurn.body["runId"]));
    updateGlobalConfig((config) => ({
      ...config,
      credential_profiles: config.credential_profiles.map((row) =>
        row.profile_id === "work" ? { ...row, enabled: false } : row,
      ),
    }));
    const fresh = await http(daemon, "POST", "/runs", run);
    expect(fresh.status).toBe(400);
    const replay = await http(daemon, "POST", "/runs", run, "replay-run");
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ jobId: first.body["jobId"], runId: first.body["runId"] });
    const replayTurn = await http(
      daemon,
      "POST",
      `/threads/${threadId}/turns`,
      turnBody,
      "replay-turn",
    );
    expect(replayTurn.status).toBe(200);
    expect(replayTurn.body).toMatchObject({
      jobId: firstTurn.body["jobId"],
      turnId: firstTurn.body["turnId"],
    });
  }, 180_000);

  it("Browser needs an effective lane among attachment-compatible lanes; per-adapter access and web stay", async () => {
    configure(codexRows, ["work", "cl-work"]);
    const daemon = await openDaemon();
    const repo = await repository(daemon);
    updateTrustConfig(repo, (config) => ({ ...config, allow_full_access: true }));
    const text = await upload(daemon, "file");
    const image = await upload(daemon, "image");
    const start = (extra: Record<string, unknown>) =>
      http(daemon, "POST", "/runs", {
        prompt: "browse",
        mode: "agent",
        scope: { kind: "project", root: repo },
        browser: true,
        ...extra,
      });
    const pdf = await uploadPdf(daemon);
    const verdicts: Record<string, unknown> = {};
    for (const [name, extra, status, code] of [
      [
        "codex_workspace_write",
        { harnesses: ["codex"], access: "workspace_write" },
        400,
        "browser_unavailable",
      ],
      ["claude_plan_readonly", { harnesses: ["claude"], mode: "plan" }, 400, "browser_unavailable"],
      [
        "codex_full_web_off",
        { harnesses: ["codex"], access: "full", web: "off" },
        400,
        "browser_unavailable",
      ],
      [
        "explicit_text_codex_claude",
        { harnesses: ["codex", "claude"], attachments: [text], access: "full" },
        200,
        undefined,
      ],
      [
        "explicit_pdf_codex_claude",
        { harnesses: ["codex", "claude"], attachments: [pdf], access: "full" },
        400,
        "attachment_pool_unsupported",
      ],
      [
        "auto_pdf_browser_workspace_write",
        { attachments: [pdf], access: "workspace_write" },
        400,
        "browser_unavailable",
      ],
    ] as const) {
      const answer = await start(extra);
      verdicts[name] = { status: answer.status, code: answer.body["code"] };
      expect.soft(answer.status, name).toBe(status);
      expect.soft(answer.body["code"], name).toBe(code);
      if (answer.status === 200) {
        await succeeded(daemon, answer);
        expect(recorder.spawns.at(-1)).toMatchObject({
          browser: true,
          attachments: ["text/plain"],
        });
      }
    }
    expect(recorder.enqueues).toHaveLength(1);
    // Both lanes now admit text. Keep the Auto pool, but prefer the lane whose
    // native MCP policy supports Browser at workspace_write for this success case.
    const textAuto = await start({
      attachments: [text],
      access: "workspace_write",
      primaryHarness: "claude",
    });
    verdicts["auto_text_browser"] = { status: textAuto.status };
    expect(textAuto.status).toBe(200);
    await succeeded(daemon, textAuto);
    expect(recorder.spawns.at(-1)).toMatchObject({
      harness: "claude",
      browser: true,
      attachments: ["text/plain"],
    });
    const imageCodex = await start({ harnesses: ["codex"], attachments: [image], access: "full" });
    verdicts["codex_image_full"] = { status: imageCodex.status };
    expect(imageCodex.status).toBe(200);
    await succeeded(daemon, imageCodex);
    expect(recorder.spawns.at(-1)).toMatchObject({
      harness: "codex",
      browser: true,
      attachments: ["image/png"],
    });
    expect(recorder.enqueues).toHaveLength(3);
    observe("browser_matrix", verdicts);
  }, 240_000);

  it("fixture regression: an explicit fake-success + codex Browser pool is judged by manifests", async () => {
    configure(codexRows, ["work", "cl-work"]);
    const daemon = await openDaemon();
    const repo = await repository(daemon);
    updateTrustConfig(repo, (config) => ({ ...config, allow_full_access: true }));
    const verdicts: Record<string, unknown> = {};
    for (const access of ["workspace_write", "full"] as const) {
      const answer = await http(daemon, "POST", "/runs", {
        prompt: "browse",
        mode: "agent",
        scope: { kind: "project", root: repo },
        harnesses: ["fake-success", "codex"],
        browser: true,
        access,
      });
      verdicts[access] = {
        status: answer.status,
        code: answer.body["code"],
        message: answer.body["message"],
      };
      if (answer.status === 200) await terminal(daemon, String(answer.body["runId"]));
    }
    observe("fake_codex_browser", verdicts);
    expect(verdicts).toMatchObject({
      workspace_write: { status: 400, code: "browser_unavailable" },
      full: { status: 200 },
    });
  }, 180_000);

  it("Ouroboros-shaped runs and turns without attachments or Browser add no admission reads", async () => {
    configure(codexRows, ["work", "cl-work"]);
    const daemon = await openDaemon();
    const repo = await repository(daemon);
    const delegate = await http(daemon, "POST", "/runs", {
      prompt: "implement the task",
      instructions: "contract",
      authPreference: "subscription",
      mode: "agent",
      scope: { kind: "project", root: repo },
      harnesses: ["codex"],
      primaryHarness: "codex",
      access: "workspace_write",
      model: "gpt-5.5",
      credentialProfileId: "work",
      maxSeconds: 600,
    });
    expect(delegate.status).toBe(200);
    const delegateIngress = recorder.enqueues[0]!;
    await succeeded(daemon, delegate);
    const thread = await http(daemon, "POST", "/threads", {
      title: "Ouroboros review · slot",
      scope: { kind: "project", root: repo },
      mode: "ask",
      workspace: "in_place",
      authPreference: "subscription",
      primaryHarness: "codex",
      eligibleHarnesses: ["codex"],
      access: "readonly",
    });
    const threadId = String(thread.body["id"]);
    const review = await http(daemon, "POST", `/threads/${threadId}/turns`, {
      prompt: "review",
      instructions: "review contract",
      authPreference: "subscription",
      mode: "ask",
      access: "readonly",
      harnesses: ["codex"],
      primaryHarness: "codex",
      maxSeconds: 300,
      model: "gpt-5.5",
      credentialProfileId: null,
    });
    expect(review.status).toBe(200);
    const reviewIngress = recorder.enqueues[1]!;
    await succeeded(daemon, review);
    observe("ouroboros_shaped_ingress_reads", { delegate: delegateIngress, review: reviewIngress });
    for (const calls of [delegateIngress, reviewIngress])
      expect(sum(calls, /^(codex|claude|fake-success)\./)).toBe(0);
    expect(recorder.spawns.map((spawn) => [spawn["profile"], spawn["model"]])).toEqual([
      ["work", "gpt-5.5"],
      [expect.any(String), "gpt-5.5"],
    ]);
  }, 180_000);

  it("an account the run rejects fails after run preparation with no spawn; Exact Retry replays it unchanged", async () => {
    const accounts = configure(codexRows, ["work", "cl-work"]);
    const daemon = await openDaemon();
    const repo = await repository(daemon, { git: false, agents: true });
    const image = await upload(daemon, "image");
    const started = await http(daemon, "POST", "/runs", {
      prompt: "look",
      mode: "agent",
      scope: { kind: "project", root: repo },
      harnesses: ["codex"],
      access: "workspace_write",
      attachments: [image],
      credentialProfileId: "spare",
    });
    observe("unready_pin_admission", { status: started.status, code: started.body["code"] });
    expect(started.status).toBe(200);
    const runId = String(started.body["runId"]);
    const failed = await terminal(daemon, runId);
    expect(failed.state).toBe("failed");
    expect(failed.error ?? "").toMatch(/credential profile is not ready/);
    // The price of checking readiness in the run: preparation already happened.
    expect(existsSync(join(failed.runDir, "events.jsonl"))).toBe(true);
    expect(failed.events.map((event) => event.type)).toContain("project.git.initialized");
    expect(failed.events.map((event) => event.type)).not.toContain("project.claude_bridge.created");
    expect(existsSync(join(repo, ".git"))).toBe(true);
    expect(existsSync(join(repo, "CLAUDE.md"))).toBe(false);
    expect(recorder.spawns).toEqual([]);
    // Exact Retry is a fresh linked command; it replays the same pin.
    const retried = await http(daemon, "POST", `/runs/${runId}/retry`, {});
    expect(retried.status).toBe(200);
    expect((await terminal(daemon, String(retried.body["runId"]))).state).toBe("failed");
    expect(recorder.spawns).toEqual([]);
    const draft = await http(daemon, "GET", `/runs/${runId}/run-again`, undefined, null);
    expect(draft.status).toBe(200);
    accounts.login("spare");
    const healed = await http(daemon, "POST", `/runs/${runId}/retry`, {});
    expect(healed.status).toBe(200);
    await succeeded(daemon, healed);
    expect(recorder.spawns).toEqual([
      expect.objectContaining({ profile: "spare", codexHome: accounts.home("spare") }),
    ]);
  }, 240_000);

  it("execution resolves map > scalar primary > settings default before model-scoped account evidence", async () => {
    configure(codexRows, ["work", "cl-work"], (config) => ({
      harnesses: {
        ...config.harnesses,
        codex: { ...config.harnesses["codex"], default_model: "gpt-5.5" },
      },
    }));
    const daemon = await openDaemon();
    const repo = await repository(daemon);
    const image = await upload(daemon, "image");
    const now = Date.now();
    daemon.graph.accounts.unusable.record({
      harness_id: "codex",
      profile_id: "work",
      model: "gpt-5.5",
      code: "capability_refused",
      source: "attempt_stream",
      detail: "model refused for this account",
      observed_at: new Date(now).toISOString(),
      expires_at: new Date(now + 10 * 60_000).toISOString(),
    });
    const start = (extra: Record<string, unknown>) =>
      http(daemon, "POST", "/runs", {
        prompt: "look",
        mode: "agent",
        scope: { kind: "project", root: repo },
        harnesses: ["codex"],
        primaryHarness: "codex",
        access: "workspace_write",
        attachments: [image],
        credentialProfileId: "work",
        ...extra,
      });
    const outcomes: Record<string, unknown> = {};
    for (const [name, extra] of [
      ["settings_default", {}],
      ["map_over_scalar", { models: { codex: "gpt-5.5" }, model: "gpt-5.4" }],
      ["scalar_primary", { model: "gpt-5.4" }],
    ] as const) {
      const before = recorder.spawns.length;
      const answer = await start(extra);
      const run =
        answer.status === 200 ? await terminal(daemon, String(answer.body["runId"])) : null;
      outcomes[name] = {
        status: answer.status,
        code: answer.body["code"],
        state: run?.state ?? null,
        spawnedModel: recorder.spawns.length > before ? recorder.spawns.at(-1)!["model"] : null,
      };
    }
    observe("model_precedence", outcomes);
    expect(outcomes).toEqual({
      // Negative controls: the evidence binds the model execution selects.
      settings_default: { status: 200, code: undefined, state: "failed", spawnedModel: null },
      map_over_scalar: { status: 200, code: undefined, state: "failed", spawnedModel: null },
      // The scalar names the primary's model, so this account may serve it.
      scalar_primary: { status: 200, code: undefined, state: "succeeded", spawnedModel: "gpt-5.4" },
    });
  }, 240_000);

  it("a direct run carrying threadId is refused before admission reads its thread", async () => {
    configure(codexRows, ["work", "cl-work"]);
    const daemon = await openDaemon();
    const repo = await repository(daemon);
    const image = await upload(daemon, "image");
    const thread = await http(daemon, "POST", "/threads", {
      scope: { kind: "project", root: repo },
      mode: "agent",
      credentialProfileId: "sticky",
    });
    const answer = await http(daemon, "POST", "/runs", {
      prompt: "look",
      mode: "agent",
      scope: { kind: "project", root: repo },
      attachments: [image],
      threadId: thread.body["id"],
    });
    observe("direct_thread_id", { status: answer.status, reads: ingress() });
    expect(answer.status).toBe(400);
    expect(String(answer.body["message"])).toMatch(/threadId is not accepted on POST \/runs/);
    expect(ingress()).toEqual({});
    expect(recorder.enqueues).toHaveLength(0);
  }, 120_000);
});
