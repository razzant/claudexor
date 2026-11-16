/**
 * The in-run hop target's account refusal before work, through the real
 * orchestrator with an offline scripted harness (no vendor calls). `a` works and
 * hits its typed limit; the work moves to `b`, whose vendor holds the account
 * (the typed `verification_required` denial, as the Claude adapter emits it)
 * before `b` does anything; `c` would serve. The proven account refusal carries
 * the SAME work on; every other shape keeps its existing stop.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HarnessEvent, QuotaSnapshot } from "@claudexor/schema";
import { ArtifactStore } from "@claudexor/artifact-store";
import { WorkspaceManager, type CapturedWorkspaceDiff } from "@claudexor/workspace";
import { OrchestratorCredentials } from "./orchestrator-credentials.js";
import { crash, limit, run, seedSession, tempStoreRoot } from "./inrun-continuity.test-support.js";

type Ctx = Parameters<Parameters<typeof run>[0]["script"]>[0];
type Emit = Ctx["emit"];
type Carrier = "native" | "packet";

const HELD =
  "API Error: Your account can't receive replies from Claude right now. You can find the next step in the Anthropic Verification Portal: https://portal.example.test/verify?org=fixture";
const HELD_RECORD = { code: "verification_required", message: HELD, source: "claude_stdout" };

/** A typed status frame of the vendor's own category. */
const status = (emit: Emit, category: string, denied = false) =>
  emit({
    type: "status",
    text: `${category}: fixture`,
    status: { kind: "api_retry", error_category: category as never },
    ...(denied ? { payload: { entitlement_denied: true } } : {}),
  });

/** The failed result as the Claude adapter types a 403 `verification_required`,
 * after the request's zero-token usage (usage alone is no work). */
function* held(emit: Emit, ...before: HarnessEvent[]): Generator<HarnessEvent> {
  yield emit({ type: "usage", usage: { input_tokens: 0, output_tokens: 0 } });
  yield status(emit, "verification_required", true);
  yield* before;
  yield emit({
    type: "error",
    error: HELD,
    payload: { api_error_status: 403, vendor_failure: HELD_RECORD },
  });
  yield emit({
    type: "completed",
    payload: { exit_code: 1, harness_reported_error: true, vendor_failure: HELD_RECORD },
  });
}

/** Another typed refusal ending the try, never the proven account denial. */
function* refused(emit: Emit, category: string): Generator<HarnessEvent> {
  yield status(emit, category);
  yield emit({ type: "error", error: `${category} refusal` });
  yield emit({ type: "completed", payload: { exit_code: 1, harness_reported_error: true } });
}

const resumed = (emit: Emit, sid = "sid-A") =>
  emit({ type: "started", observed_model: "m1", payload: { native_session_id: sid } });

/** `a`'s decision lives only in its vendor transcript (native) or its output (packet). */
function* aWorks(
  { spec, emit }: Ctx,
  mode: "agent" | "ask",
  carrier: Carrier,
  stores: string,
  marker: string,
  reopens: string | null = null,
): Generator<HarnessEvent> {
  if (carrier === "native") {
    seedSession(stores, "a", "sid-A");
    const transcript = join(stores, "store-a", "sessions", "sid-A.jsonl");
    appendFileSync(
      transcript,
      `${JSON.stringify({ role: "assistant", text: `decision: ${marker}` })}\n`,
    );
  }
  yield resumed(emit);
  if (mode === "agent") {
    writeFileSync(join(spec.cwd, "part1.txt"), "first half\n");
    yield emit({ type: "file_change", payload: { path: "part1.txt" } });
  } else yield emit({ type: "tool_call", tool: { name: "Grep", kind: "search", target: "TODO" } });
  if (carrier === "packet") yield emit({ type: "message", text: `decision: ${marker}` });
  yield* limit(emit, reopens);
}

/** What `c` recovers from the material its carrier delivered, never from this test:
 * the moved transcript in its own store, or the packet's evidence index file. */
function recovered(spec: Ctx["spec"], carrier: Carrier): string {
  const material =
    carrier === "native"
      ? readFileSync(
          join(
            spec.credential_profile!.isolation_locator!,
            "sessions",
            `${spec.resume_session_id}.jsonl`,
          ),
          "utf8",
        )
      : readFileSync(/Its evidence index is at: (.+?) — read it/.exec(spec.prompt)![1]!, "utf8");
  return /decision: (\S+)/.exec(material)?.[1] ?? "nothing recovered";
}

function* cFinishes(
  { spec, emit }: Ctx,
  mode: "agent" | "ask",
  carrier: Carrier,
): Generator<HarnessEvent> {
  yield resumed(emit, carrier === "native" ? "sid-A" : "sid-C");
  const decision = recovered(spec, carrier);
  if (mode === "agent") {
    writeFileSync(join(spec.cwd, "part2.txt"), "second half\n");
    yield emit({ type: "file_change", payload: { path: "part2.txt" } });
  }
  yield emit({ type: "message", text: `continued after ${decision}`, final: true });
  yield emit({ type: "completed" });
}

/** The agent/native chain where `b` runs `bTry`. */
const chain = (stores: string, bTry: (ctx: Ctx) => Generator<HarnessEvent>) =>
  function* (ctx: Ctx): Generator<HarnessEvent> {
    if (ctx.profile === "a") yield* aWorks(ctx, "agent", "native", stores, "unused");
    else if (ctx.profile === "b") yield* bTry(ctx);
    else yield* cFinishes(ctx, "agent", "native");
  };

function* heldBeforeWork({ emit }: Ctx): Generator<HarnessEvent> {
  yield resumed(emit);
  yield* held(emit);
}

/** The failure record a pool terminal leaves: its own message and every account's try. */
const failureRecord = (o: Awaited<ReturnType<typeof run>>) =>
  new ArtifactStore(o.root).readYaml(join(o.result.runDir, "final", "failure.yaml")) as {
    code: string;
    category: string;
    resetsAt: string | null;
    safeMessage: string;
    vendorFailure: unknown;
    poolAttempts: Array<{ profileId: string; category: string; vendorFailure: unknown }>;
  };

const unusableEvents = (o: Awaited<ReturnType<typeof run>>) =>
  o.events
    .filter((event) => event.type === "route.profile.credential_unusable")
    .map((event) => event.payload);

describe("a hop target held before its own work carries the SAME work on: a, b, c once each", () => {
  it.each([
    ["agent", "native", false],
    ["agent", "native", true],
    ["ask", "native", false],
    ["ask", "native", true],
    ["agent", "packet", false],
    ["ask", "packet", false],
  ] as const)(
    "%s × %s (b refused before its session started: %s)",
    async (mode, carrier, beforeInit) => {
      const marker = `A-DECISION-${randomUUID()}`;
      const resetsAt = new Date(Date.now() + 60_000).toISOString();
      const retryDelayMs = 1_234;
      const stores = tempStoreRoot();
      const o = await run({
        mode,
        profiles: ["a", "b", "c"],
        storeRoot: stores,
        ...(carrier === "packet" ? { continuity: null } : {}),
        script: function* (ctx) {
          if (ctx.profile === "a") {
            for (const event of aWorks(ctx, mode, carrier, stores, marker, resetsAt)) {
              yield event.rate_limit
                ? { ...event, rate_limit: { ...event.rate_limit, retry_delay_ms: retryDelayMs } }
                : event;
            }
          } else if (ctx.profile === "c") yield* cFinishes(ctx, mode, carrier);
          else {
            if (!beforeInit) yield resumed(ctx.emit, carrier === "native" ? "sid-A" : "sid-B");
            yield* held(ctx.emit);
          }
        },
      });
      expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
      expect(o.spawns.map((s) => [s.profile, s.model])).toEqual([
        ["a", "m1"],
        ["b", "m1"],
        ["c", "m1"],
      ]);
      expect(o.spawns.map((s) => s.resume)).toEqual(
        carrier === "native" ? [null, "sid-A", "sid-A"] : [null, null, null],
      );
      // Both continued tries carried the work (a fresh try has no receipt).
      const moved = carrier === "native" ? "native_moved" : "packet";
      expect(
        o.receipts.map((r) => [
          r["carrier"],
          r["cause"],
          (r["from"] as { profileId: string }).profileId,
          (r["to"] as { profileId: string }).profileId,
        ]),
      ).toEqual([
        [moved, "vendor_limit", "a", "b"],
        [moved, "other", "b", "c"],
      ]);
      // Each rotation reports only its departing try's limit, never an earlier account's.
      expect(
        o.rotated.map((r) => [
          r["from_profile_id"],
          r["to_profile_id"],
          r["reason"],
          r["resets_at"],
          r["retry_delay_ms"],
        ]),
      ).toEqual([
        ["a", "b", "vendor_limit_rejected", resetsAt, retryDelayMs],
        ["b", "c", "structural_pre_progress_failure", null, null],
      ]);
      // c answered from a's decision, which reached it only through its carrier.
      expect(readFileSync(join(o.result.runDir, "final", "answer.md"), "utf8")).toContain(
        `continued after ${marker}`,
      );
      if (carrier === "native") {
        expect(o.spawns[2]!.prompt).toContain("The previous process stopped (an interruption)");
        expect(o.spawns[2]!.prompt).not.toContain(marker);
        expect(o.spawns[2]!.prompt).not.toContain("WORK-ORDER-7f3a");
        expect(o.capsule).toMatchObject({ nativeSessionId: "sid-A", holderProfileId: "c" });
        expect(existsSync(join(stores, "store-b", "sessions", "sid-A.jsonl"))).toBe(false);
      } else {
        expect(o.spawns[2]!.prompt).toContain("# Evidence index of the interrupted work");
        expect(o.receipts.map((r) => r["memory"])).toEqual(["partial", "partial"]);
      }
      if (mode === "agent") {
        expect(readFileSync(join(o.root, "part1.txt"), "utf8")).toBe("first half\n");
        expect(existsSync(join(o.root, "part2.txt"))).toBe(true);
      }
      // b's own verdict: every model of that row, under the vendor's real code.
      expect(unusableEvents(o)).toMatchObject([
        {
          profile_id: "b",
          model: null,
          code: "capability_refused",
          detail: "verification_required",
        },
      ]);
      expect(o.resumable).toBeUndefined();
    },
  );

  it("each held account moves the work on in turn until one serves", async () => {
    const stores = tempStoreRoot();
    const finish = chain(stores, heldBeforeWork);
    const o = await run({
      mode: "agent",
      profiles: ["a", "b", "c", "d"],
      storeRoot: stores,
      script: (ctx) => (ctx.profile === "c" ? heldBeforeWork(ctx) : finish(ctx)),
    });
    expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
    expect(o.spawns.map((s) => [s.profile, s.resume])).toEqual([
      ["a", null],
      ["b", "sid-A"],
      ["c", "sid-A"],
      ["d", "sid-A"],
    ]);
    expect(o.receipts.map((r) => r["cause"])).toEqual(["vendor_limit", "other", "other"]);
    expect(o.capsule).toMatchObject({ nativeSessionId: "sid-A", holderProfileId: "d" });
  });

  it.each([false, true])(
    "a read-only Agent is judged on its markers and answer alone (b disclosed a file change: %s)",
    async (bChanged) => {
      const marker = `A-DECISION-${randomUUID()}`;
      const stores = tempStoreRoot();
      const access: string[] = [];
      const o = await run({
        mode: "agent",
        profiles: ["a", "b", "c"],
        storeRoot: stores,
        input: { access: "readonly" },
        // Read-only work: a searches, c only answers.
        script: function* (ctx) {
          access.push(ctx.spec.access);
          if (ctx.profile === "a") yield* aWorks(ctx, "ask", "native", stores, marker);
          else if (ctx.profile === "c") yield* cFinishes(ctx, "ask", "native");
          else {
            yield resumed(ctx.emit);
            const before = bChanged
              ? [ctx.emit({ type: "file_change", payload: { path: "b.txt" } })]
              : [];
            yield* held(ctx.emit, ...before);
          }
        },
      });
      expect(access).toEqual(o.spawns.map(() => "readonly"));
      if (bChanged) {
        expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
        expect(o.rotated).toHaveLength(1);
        expect(o.resumable).toMatchObject({ cause: "other" });
        return;
      }
      expect(o.result.lifecycle, o.result.summary).toBe("succeeded");
      expect(o.spawns.map((s) => [s.profile, s.resume])).toEqual([
        ["a", null],
        ["b", "sid-A"],
        ["c", "sid-A"],
      ]);
      expect(o.receipts.map((r) => [r["carrier"], r["cause"]])).toEqual([
        ["native_moved", "vendor_limit"],
        ["native_moved", "other"],
      ]);
      expect(o.rotated.map((r) => r["reason"])).toEqual([
        "vendor_limit_rejected",
        "structural_pre_progress_failure",
      ]);
      expect(readFileSync(join(o.result.runDir, "final", "answer.md"), "utf8")).toContain(
        `continued after ${marker}`,
      );
      expect(unusableEvents(o)).toMatchObject([
        { profile_id: "b", code: "capability_refused", detail: "verification_required" },
      ]);
    },
  );
});

describe("no eligible account left", () => {
  it("ends on the typed pool terminal with b's own words; no same-account retry", async () => {
    const stores = tempStoreRoot();
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      storeRoot: stores,
      maxRetries: 2,
      script: chain(stores, heldBeforeWork),
    });
    expect(o.result.lifecycle).toBe("failed");
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expect(o.resumable).toMatchObject({
      cause: "pool_exhausted",
      limitCode: "credential_pool_exhausted",
      resetsAt: null,
      carriers: ["native", "native_moved", "packet"],
      session: { harness: "fake", nativeSessionId: "sid-A", holderProfileId: "b" },
      workspace: { kind: "in_place", root: o.root },
    });
    expect(readFileSync(join(o.root, "part1.txt"), "utf8")).toBe("first half\n");
    expect(
      o.events.find((event) => event.type === "route.profile.rotation_exhausted")?.payload,
    ).toMatchObject({ from_profile_id: "b", reason: "structural_pre_progress_failure" });
    // The typed pool outcome, each account's own reason, and b's vendor record
    // with its guidance; no reopening time is promised for a held account.
    const failure = failureRecord(o);
    expect(failure).toMatchObject({
      code: "credential_pool_exhausted",
      category: "harness_unavailable",
      resetsAt: null,
      vendorFailure: HELD_RECORD,
    });
    expect(failure.safeMessage).toContain("(vendor claude_stdout: verification_required)");
    expect(failure.safeMessage).toContain("portal.example.test/verify?org=fixture");
    expect(failure.poolAttempts.map((a) => [a.profileId, a.category])).toEqual([
      ["a", "rate_limited"],
      ["b", "capability_refused"],
    ]);
    expect(failure.poolAttempts[1]!.vendorFailure).toEqual(HELD_RECORD);
  });

  it("a's quota reopening stays a's: the pool names it, b's hold promises no time", async () => {
    const stores = tempStoreRoot();
    const reopens = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const snapshots: QuotaSnapshot[] = [];
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      storeRoot: stores,
      snapshots,
      script: function* (ctx) {
        if (ctx.profile === "b") {
          yield* heldBeforeWork(ctx);
          return;
        }
        // a's own spent window, as its vendor reports it during the try.
        snapshots.push({
          subject: {
            harness: "fake",
            credential_route: "vendor_native",
            plan_label: null,
            subject_id: "a",
          },
          constraints: [
            {
              id: "five_hour",
              label: "five_hour",
              used_ratio: 1,
              window_seconds: 18_000,
              resets_at: reopens,
              cooldown_until: null,
            },
          ],
          source: "claude_oauth_usage",
          observed_at: new Date().toISOString(),
          freshness: "fresh",
        });
        yield* aWorks(ctx, "agent", "native", stores, "unused", reopens);
      },
    });
    expect(o.resumable).toMatchObject({ cause: "pool_exhausted", resetsAt: reopens });
    const candidates = o.events.find((event) => event.type === "route.profile.rotation_exhausted")
      ?.payload["candidates"] as Array<{
      profile_id: string;
      rejected: string;
      resets_at: unknown;
    }>;
    expect(candidates.map((c) => [c.profile_id, c.rejected, c.resets_at])).toEqual([
      ["a", "already_tried", reopens],
      ["b", "current", null],
    ]);
    expect(failureRecord(o)).toMatchObject({
      code: "credential_pool_exhausted",
      resetsAt: reopens,
      vendorFailure: HELD_RECORD,
    });
  });

  it("a disabled account or one of another credential kind is never the next eligible one", async () => {
    const stores = tempStoreRoot();
    const o = await run({
      mode: "agent",
      profiles: ["a", "b", "c", "d"],
      storeRoot: stores,
      registryProfiles: (profiles) =>
        profiles.map((profile) =>
          profile.profile_id === "c"
            ? { ...profile, enabled: false }
            : profile.profile_id === "d"
              ? {
                  ...profile,
                  credential_kind: "api_key" as const,
                  isolation_locator: null,
                  secret_ref: "raw:d",
                }
              : profile,
        ),
      script: chain(stores, heldBeforeWork),
    });
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expect(o.resumable).toMatchObject({ cause: "pool_exhausted" });
    const candidates = o.events.find((event) => event.type === "route.profile.rotation_exhausted")
      ?.payload["candidates"] as Array<{ profile_id: string; rejected: string }>;
    expect(candidates.map((c) => [c.profile_id, c.rejected])).toEqual([
      ["a", "already_tried"],
      ["b", "current"],
      ["d", "credential_kind_mismatch"],
    ]);
  });
});

describe("everything else keeps its existing stop", () => {
  it.each([false, true])(
    "non-Git live convergence cannot prove no new work from equal binary previews (b changed bytes: %s)",
    async (changed) => {
      const folder = tempStoreRoot();
      const binary = join(folder, "image.bin");
      const aBytes = Buffer.from([0, 1, 2, 3]);
      const bBytes = changed ? Buffer.from([0, 4, 5, 6]) : aBytes;
      writeFileSync(binary, Buffer.from([0, 0, 0, 0]));
      const stores = tempStoreRoot();
      const captures: Array<{ capture: CapturedWorkspaceDiff; bytes: Buffer }> = [];
      const original = WorkspaceManager.prototype.captureDiff;
      const capture = vi
        .spyOn(WorkspaceManager.prototype, "captureDiff")
        .mockImplementation(async function (this: WorkspaceManager, ...args) {
          const observed = await original.apply(this, args);
          if (args[0].repo_root === folder)
            captures.push({ capture: observed, bytes: readFileSync(binary) });
          return observed;
        });
      try {
        const o = await run({
          mode: "agent",
          profiles: ["a", "b", "c"],
          storeRoot: stores,
          input: { repoRoot: folder, attempts: 1 },
          script: function* (ctx) {
            if (ctx.profile === "a") {
              writeFileSync(binary, aBytes);
              yield* aWorks(ctx, "agent", "native", stores, "binary-decision");
            } else if (ctx.profile === "b") {
              // No event announces this write. The real capture must decide.
              if (changed) writeFileSync(binary, bBytes);
              yield* heldBeforeWork(ctx);
            } else yield* cFinishes(ctx, "agent", "native");
          },
        });
        expect(existsSync(join(folder, ".git"))).toBe(false);
        expect(captures.length).toBeGreaterThanOrEqual(2);
        const [a, b] = captures;
        expect(a!.bytes).toEqual(aBytes);
        expect(b!.bytes).toEqual(bBytes);
        for (const observed of [a!, b!]) {
          // A successfully rendered preview still carries no exact byte identity.
          expect(observed.capture.captureIncomplete).toBe(false);
          expect(observed.capture.result).toBeUndefined();
          expect(observed.capture.diff).toMatch(/Binary files .*image\.bin.* differ/);
        }
        expect(a!.capture.diff).toBe(b!.capture.diff);
        expect(o.spawns.map((s) => [s.profile, s.resume])).toEqual([
          ["a", null],
          ["b", "sid-A"],
        ]);
        expect(o.result.lifecycle).toBe("failed");
        expect(o.rotated).toHaveLength(1);
        expect(o.resumable).toMatchObject({
          cause: "other",
          session: { nativeSessionId: "sid-A", holderProfileId: "b" },
          workspace: { kind: "in_place", root: folder },
        });
        expect(readFileSync(binary)).toEqual(bBytes);
        expect(existsSync(join(folder, "part2.txt"))).toBe(false);
      } finally {
        capture.mockRestore();
      }
    },
  );

  it.each<[string, (ctx: Ctx) => Generator<HarnessEvent>, string]>([
    [
      "b started a tool call whose effect is unknown",
      function* ({ emit }) {
        yield resumed(emit);
        yield* held(emit, emit({ type: "tool_call", tool: { name: "Bash", kind: "command" } }));
      },
      "other",
    ],
    [
      "b received a tool result",
      function* ({ emit }) {
        yield resumed(emit);
        yield* held(emit, emit({ type: "tool_result", tool: { name: "Read", kind: "file" } }));
      },
      "other",
    ],
    [
      "b was thinking",
      function* ({ emit }) {
        yield resumed(emit);
        yield* held(emit, emit({ type: "thinking", text: "planning the second half" }));
      },
      "other",
    ],
    [
      "b completed a compaction",
      function* ({ emit }) {
        yield resumed(emit);
        yield* held(
          emit,
          emit({
            type: "context",
            context: {
              kind: "compaction_completed",
              cause: "unknown",
              native_code: null,
              trigger: "auto",
              pre_tokens: null,
            },
          }),
        );
      },
      "other",
    ],
    [
      "b disclosed a tool-less file change",
      function* ({ spec, emit }) {
        yield resumed(emit);
        writeFileSync(join(spec.cwd, "b.txt"), "b\n");
        yield* held(emit, emit({ type: "file_change", payload: { path: "b.txt" } }));
      },
      "other",
    ],
    [
      "b wrote and reverted a file (the tree matches, the event remains)",
      function* ({ spec, emit }) {
        yield resumed(emit);
        writeFileSync(join(spec.cwd, "b.txt"), "b\n");
        const change = emit({ type: "file_change", payload: { path: "b.txt" } });
        rmSync(join(spec.cwd, "b.txt"));
        yield* held(emit, change);
      },
      "other",
    ],
    [
      "b changed the workspace without any event",
      function* ({ spec, emit }) {
        yield resumed(emit);
        writeFileSync(join(spec.cwd, "silent.txt"), "b\n");
        yield* held(emit);
      },
      "other",
    ],
    [
      "b delivered a typed final answer",
      function* ({ emit }) {
        yield resumed(emit);
        yield* held(emit, emit({ type: "message", text: "partial answer", final: true }));
      },
      "other",
    ],
    [
      "b met an authentication rejection, not the proven denial",
      function* ({ emit }) {
        yield resumed(emit);
        yield* refused(emit, "authentication_failed");
      },
      "other",
    ],
    [
      "b met a model refusal, not the proven denial",
      function* ({ emit }) {
        yield resumed(emit);
        yield* refused(emit, "model_not_found");
      },
      "other",
    ],
    [
      "b met the organization category only prose inferred (no proof)",
      function* ({ emit }) {
        yield resumed(emit);
        yield* refused(emit, "oauth_org_not_allowed");
      },
      "other",
    ],
    [
      "b met a request/configuration refusal",
      function* ({ emit }) {
        yield resumed(emit);
        yield* refused(emit, "invalid_request");
      },
      "other",
    ],
    [
      "b met the proven denial together with a configuration refusal",
      function* ({ emit }) {
        yield resumed(emit);
        yield* held(emit, status(emit, "invalid_request"));
      },
      "other",
    ],
    [
      "b met a request-level restriction no account can lift, beside the proven denial",
      function* ({ emit }) {
        yield resumed(emit);
        yield* held(
          emit,
          emit({
            type: "error",
            error: "the installed CLI is too old",
            request_refusal: {
              kind: "vendor_cli_too_old",
              native_code: "claude_code_version_too_old",
              source: "claude_stdout",
              binary_path: null,
              installed_version: null,
            },
          }),
        );
      },
      "other",
    ],
    [
      "b met a native permission refusal",
      function* ({ emit }) {
        yield resumed(emit);
        yield* held(
          emit,
          emit({ type: "status", permission_denial: { permission: "Bash", source: "fixture" } }),
        );
      },
      "permission_denied",
    ],
  ])("%s → the attempt stops on b, nothing rotates", async (_name, bTry, cause) => {
    const stores = tempStoreRoot();
    const o = await run({
      mode: "agent",
      profiles: ["a", "b", "c"],
      storeRoot: stores,
      script: chain(stores, bTry),
    });
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expect(o.rotated).toHaveLength(1);
    expect(o.resumable).toMatchObject({ cause });
  });

  it("an untyped failure of b before work stays transport: b resumes, bounded, nothing rotates", async () => {
    const stores = tempStoreRoot();
    const o = await run({
      mode: "agent",
      profiles: ["a", "b", "c"],
      storeRoot: stores,
      maxRetries: 1,
      script: chain(stores, function* ({ emit }) {
        yield resumed(emit);
        yield* crash(emit);
      }),
    });
    expect(o.spawns.map((s) => [s.profile, s.resume])).toEqual([
      ["a", null],
      ["b", "sid-A"],
      ["b", "sid-A"],
    ]);
    expect(o.rotated).toHaveLength(1);
    expect(o.resumable).toMatchObject({ cause: "transport" });
  });

  it.each([false, true])(
    "the same account held on its own resume stops at once: not newly selected, no replay (pinned=%s)",
    async (pinned) => {
      const stores = tempStoreRoot();
      const o = await run({
        mode: "agent",
        profiles: ["a", "b"],
        storeRoot: stores,
        maxRetries: 2,
        ...(pinned ? { pinned: "a" } : {}),
        script: function* ({ spec, emit, tryOfProfile }) {
          if (tryOfProfile === 1) {
            seedSession(stores, "a", "sid-A");
            yield resumed(emit);
            writeFileSync(join(spec.cwd, "part1.txt"), "x\n");
            yield emit({ type: "file_change", payload: { path: "part1.txt" } });
            yield* crash(emit);
            return;
          }
          yield resumed(emit);
          yield* held(emit);
        },
      });
      expect(o.spawns.map((s) => [s.profile, s.resume])).toEqual([
        ["a", null],
        ["a", "sid-A"],
      ]);
      expect(o.rotated).toEqual([]);
      expect(o.resumable).toMatchObject({ cause: "other" });
    },
  );

  it("a Stop during b's try ends the attempt: nothing probes, rotates or continues", async () => {
    const stores = tempStoreRoot();
    const stop = new AbortController();
    const o = await run({
      mode: "agent",
      profiles: ["a", "b", "c"],
      storeRoot: stores,
      input: { signal: stop.signal },
      script: chain(stores, function* ({ emit }) {
        yield resumed(emit);
        stop.abort("user_cancelled");
        yield* held(emit);
      }),
    });
    expect(o.result.lifecycle).toBe("cancelled");
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expect(o.rotated).toHaveLength(1);
    expect(unusableEvents(o)).toEqual([]);
  });

  it("a Stop during b's post-try capture ends the attempt: nothing probes, rotates or continues", async () => {
    const stores = tempStoreRoot();
    const stop = new AbortController();
    const original = WorkspaceManager.prototype.captureDiff;
    let calls = 0;
    const capture = vi
      .spyOn(WorkspaceManager.prototype, "captureDiff")
      .mockImplementation(async function (this: WorkspaceManager, ...args) {
        // The first capture follows a's try, the second follows b's.
        if ((calls += 1) === 2) stop.abort("user_cancelled");
        return original.apply(this, args as Parameters<typeof original>);
      });
    const probes = vi.spyOn(OrchestratorCredentials.prototype, "rotationObservations");
    try {
      const o = await run({
        mode: "agent",
        profiles: ["a", "b", "c"],
        storeRoot: stores,
        input: { signal: stop.signal },
        script: chain(stores, heldBeforeWork),
      });
      expect(o.result.lifecycle).toBe("cancelled");
      expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
      expect(o.rotated).toHaveLength(1);
      // Only a's limit hop consulted the account evidence.
      expect(probes).toHaveBeenCalledTimes(1);
      expect(unusableEvents(o)).toEqual([]);
    } finally {
      capture.mockRestore();
      probes.mockRestore();
    }
  });

  it("a hard budget stop in b's try ends the attempt as before: nothing rotates", async () => {
    const stores = tempStoreRoot();
    const o = await run({
      mode: "agent",
      profiles: ["a", "b", "c"],
      storeRoot: stores,
      input: { paidBudget: { kind: "finite", maxUsd: 0.05 } },
      script: chain(stores, function* ({ emit }) {
        yield resumed(emit);
        yield emit({
          type: "usage",
          usage: { cost_usd: 2, cost_basis: { kind: "cash", source: "fixture" } },
        });
        yield* held(emit);
      }),
    });
    expect(o.spawns.map((s) => s.profile)).toEqual(["a", "b"]);
    expect(o.rotated).toHaveLength(1);
    expect(o.resumable).toMatchObject({ cause: "other" });
  });
});
