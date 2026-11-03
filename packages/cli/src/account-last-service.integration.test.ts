import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { DaemonControlApiServer } from "@claudexor/control-api";
import { bindCredentialMutationWindow, runCapture, type HarnessAdapter } from "@claudexor/core";
import {
  EngineStore,
  createPartition,
  createSqlDaemonServices,
  setGlobalGenerationInTx,
} from "@claudexor/daemon";
import {
  ConformanceReport,
  ControlAccountRoutingEvidenceResponse,
  ControlCredentialProfileUpdateResponse,
  CredentialProfile,
  HarnessManifest,
  RunFailure,
  type HarnessEvent,
} from "@claudexor/schema";
import { createCredentialProfilesService } from "./accounts-services.js";
import { controlServices } from "./control-services.js";
import {
  bustCredentialStatusCaches,
  bustLoginCredentialState,
} from "./credential-status-invalidation.js";
import { projectImmediateRunDetail } from "./mcp-run-projections.js";
import { createSqlDaemonRuntime } from "./sql-daemon-runtime.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

// Production-shaped consumer evidence for per-try attribution and the durable
// last-served order: a real engine store, the real SQL services graph and SQL
// runtime (its agent runner builds the real Orchestrator), reopened as NEW
// objects to model a daemon restart. Only the harness registry is replaced by
// an offline stub whose answer depends on the account it runs on.

/** How one account answers a spawn. */
type Behavior =
  | "serve"
  | "refuse_usage"
  | "refuse_invoice"
  | "alias"
  | "foreign"
  | "paid"
  | "empty"
  | "message_error";
const REFUSAL: Record<string, string> = {
  refuse_usage: "You're out of usage. Switch to Auto.",
  refuse_invoice: "You have an unpaid invoice\n  (team account)",
};
const script = vi.hoisted(() => ({
  lane: "agent" as "agent" | "ask",
  behavior: {} as Record<string, string>,
  afterStart: {} as Record<string, () => void | Promise<void>>,
  spawns: [] as Array<string | null>,
  registry: new Map<string, unknown>(),
}));
vi.mock("./registry.js", async (original) => ({
  ...(await original<typeof import("./registry.js")>()),
  buildRegistry: () => script.registry,
}));

const MODELS = ["model-m", "model-other", "fable", "model-f", "model-p", "model-e", "model-x"];
const MORE = ["model-c", "model-w", "model-in", "model-s"];

function stubAdapter(): HarnessAdapter {
  const id = "stub";
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "local",
        capabilities: {
          ...(script.lane === "ask"
            ? { plan: true, review: true, read_files: true }
            : { implement: true }),
          known_models: [...MODELS, ...MORE],
        },
        access_profiles_supported: [script.lane === "ask" ? "readonly" : "workspace_write"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "ok",
        enabled_intents:
          script.lane === "ask" ? ["explain", "audit", "plan", "review"] : ["implement"],
      });
    },
    async probeCredentialProfile(profile) {
      return {
        profile_id: profile.profile_id,
        harness_id: id,
        availability: "available",
        verification: "passed",
        verification_source: "local_store",
        detail: "fixture profile verified",
        last_verified_at: new Date().toISOString(),
      };
    },
    async *run(spec) {
      const profileId = spec.credential_profile?.profile_id ?? null;
      script.spawns.push(profileId);
      const mode = (script.behavior[profileId ?? ""] ?? "serve") as Behavior;
      const at = () => new Date().toISOString();
      const ev = (event: Omit<HarnessEvent, "session_id" | "ts">): HarnessEvent =>
        ({ session_id: spec.session_id, ts: at(), ...event }) as HarnessEvent;
      const identity =
        mode === "foreign"
          ? { credential_profile_id: "intruder" }
          : mode === "paid"
            ? { credential_route: "managed_api_key" as const }
            : mode === "alias"
              ? { observed_model: "claude-fable-5-1" }
              : {};
      yield ev({ type: "started", ...identity });
      await script.afterStart[profileId ?? ""]?.();
      if (mode === "refuse_usage" || mode === "refuse_invoice") {
        // Unclassified vendor prose: no typed limit, no dictionary.
        yield ev({ type: "error", error: REFUSAL[mode] });
        yield ev({ type: "completed", payload: { exit_code: 1, harness_reported_error: true } });
        return;
      }
      if (mode === "empty") {
        yield ev({ type: "completed", payload: { exit_code: 0 } });
        return;
      }
      if (mode === "message_error") {
        yield ev({ type: "message", text: "partial answer" });
        yield ev({ type: "error", error: "stream broke" });
        yield ev({ type: "completed", payload: { exit_code: 1, harness_reported_error: true } });
        return;
      }
      yield ev({ type: "thinking", text: "working", ...identity });
      if (script.lane === "agent")
        writeFileSync(join(spec.cwd, "CHANGED.txt"), `served by ${profileId}\n`);
      yield ev({ type: "message", text: "4", ...identity });
      yield ev({ type: "completed", payload: { exit_code: 0 } });
    },
  };
}

/** Each case chains several full daemon runs; a generous hang detector, not a perf gate. */
const RUNS_TIMEOUT_MS = 180_000;
const reap: string[] = [];
const closers: Array<() => Promise<void>> = [];
/** Folders whose test closed its daemons in time: the only ones removed at file end (#376). */
const closedRoots: string[] = [];
afterEachClosed(async () => {
  // This test's folders, taken before its closes: a later test never hands them over.
  const ownedRoots = reap.splice(0);
  for (const close of closers.splice(0).reverse()) await close();
  script.behavior = {};
  script.afterStart = {};
  script.spawns = [];
  return () => {
    closedRoots.push(...ownedRoots);
  };
}, 60_000);
afterAll(() => {
  for (const dir of closedRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
beforeAll(() => {
  script.registry = new Map([["stub", stubAdapter()]]);
});
let windowOpen = false;
beforeAll(() =>
  bindCredentialMutationWindow(
    (harness) => windowOpen && (harness === undefined || harness === "stub"),
  ),
);
afterAll(() => bindCredentialMutationWindow(null));

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  reap.push(dir);
  return dir;
}

/** Two subscription rows `a`/`b` of the stub harness, scoped to this test. */
function accountsConfig(): CredentialProfile[] {
  const configDir = temp("cx-last-service-config-");
  process.env.CLAUDEXOR_CONFIG_DIR = configDir;
  const row = (id: string) => ({
    profile_id: id,
    harness_id: "stub",
    display_name: `Account ${id.toUpperCase()}`,
    credential_kind: "config_dir_login" as const,
    isolation_locator: join(configDir, "profiles", `stub-${id}`),
  });
  writeFileSync(
    join(configDir, "config.yaml"),
    [
      "credential_profiles:",
      ...[row("a"), row("b")].flatMap((r) => [
        `  - profile_id: ${r.profile_id}`,
        "    harness_id: stub",
        `    display_name: ${r.display_name}`,
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${JSON.stringify(r.isolation_locator)}`,
      ]),
      "runtime:",
      "  transient_retry:",
      "    max_retries: 0",
      "",
    ].join("\n"),
  );
  return [row("a"), row("b")].map((r) => CredentialProfile.parse(r));
}

/** A daemon over one data root, served on loopback HTTP: opening the same
 * root again yields NEW store, graph, runtime and control objects. */
async function openDaemon(root: string) {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/flusher-worker.js"),
  });
  if (!store.prepare("SELECT value FROM meta WHERE key='global_pid'").get())
    store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
  const graph = createSqlDaemonServices(store, { purgeFiles: async () => [root] });
  const runtime = createSqlDaemonRuntime(graph, {
    server: { socketPath: join(root, "unused.sock"), token: "fixture" },
    authReadiness: () => ({ invalidate: () => {} }),
  });
  const control = new DaemonControlApiServer({
    token: "fixture",
    daemon: runtime.client,
    bus: runtime.bus,
    pollMs: 5,
    terminalFilesPending: runtime.terminalFilesPending,
    // The same Accounts service owner claudexord binds, over this store's graph,
    // and the real control-plane Enabled PATCH beside it.
    services: {
      ...createCredentialProfilesService(() => graph.quota, graph.accounts),
      updateCredentialProfile: controlServices(
        graph.interactions,
        graph.liveInputs,
        () => graph.projects,
        graph.threads as never,
        { current: () => ({ list: () => [] }) } as never,
        undefined as never,
        undefined as never,
        () => graph.resources,
        () => graph.quota,
        graph.accounts,
        () => [],
      ).updateCredentialProfile,
    },
  });
  const { host, port } = await control.start();
  let closing: Promise<void> | undefined;
  /** One close: a later caller gets its outcome, not a success it never saw (#376). */
  const close = () =>
    (closing ??= (async () => {
      await control.stop();
      await runtime.stop();
      await graph.close();
      await store.close();
    })());
  closers.push(close);
  return { store, graph, runtime, close, base: `http://${host}:${port}` };
}
type Daemon = Awaited<ReturnType<typeof openDaemon>>;
const headers = { authorization: "Bearer fixture", "X-Claudexor-Protocol-Major": "3" };

async function initRepo(): Promise<string> {
  const repo = temp("cx-last-service-repo-");
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

/** A fresh repository registered with this daemon's project registry. */
async function project(daemon: Daemon): Promise<string> {
  const repo = await initRepo();
  daemon.graph.projects.register({ root: repo, idempotencyKey: repo, clientId: "fixture" });
  return repo;
}

let key = 0;
/** One run through the real queue: POST /v2/runs, then the terminal GET /v2/runs/:id. */
async function run(
  daemon: Daemon,
  model: string,
  options: { pin?: string; cancel?: boolean } = {},
) {
  const repo = await project(daemon);
  script.spawns = [];
  let jobOf!: (id: string) => void;
  const jobId = new Promise<string>((resolveJob) => (jobOf = resolveJob));
  // Cancellation arrives from outside while the account's session is in flight.
  if (options.cancel)
    script.afterStart = { a: async () => void (await daemon.runtime.client.cancel(await jobId)) };
  const posted = await fetch(`${daemon.base}/v2/runs`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": `k-${++key}` },
    body: JSON.stringify({
      mode: script.lane,
      prompt: script.lane === "ask" ? "2+2?" : "do it",
      scope: { kind: "project", root: repo },
      harnesses: ["stub"],
      model,
      ...(options.pin ? { credentialProfileId: options.pin } : {}),
    }),
  });
  expect(posted.status).toBe(200);
  const receipt = (await posted.json()) as { runId: string; jobId: string };
  jobOf(receipt.jobId);
  let detail: Record<string, unknown> = {};
  await vi.waitFor(
    async () => {
      const response = await fetch(`${daemon.base}/v2/runs/${receipt.runId}`, { headers });
      detail = (await response.json()) as Record<string, unknown>;
      const state = (detail["summary"] as { state?: string } | undefined)?.state;
      expect(["succeeded", "failed", "cancelled", "interrupted"]).toContain(state);
    },
    { timeout: 60_000, interval: 50 },
  );
  const summary = detail["summary"] as { state: string; runDir: string; error?: string | null };
  const events = readFileSync(join(summary.runDir, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
  const failurePath = join(summary.runDir, "final", "failure.yaml");
  return {
    runId: receipt.runId,
    detail,
    lifecycle: summary.state,
    error: summary.error ?? null,
    spawns: [...script.spawns],
    events,
    selected: events
      .filter((e) => e.type === "route.account.pool_selected")
      .map((e) => e.payload["profile_id"]),
    failure: existsSync(failurePath)
      ? RunFailure.parse(new ArtifactStore(repo).readYaml(failurePath))
      : null,
    summaryMd: readFileSync(join(summary.runDir, "final", "summary.md"), "utf8"),
  };
}

const served = (daemon: Daemon, model: string, rows: CredentialProfile[]) =>
  Object.fromEntries(daemon.graph.accounts.services!.orders("stub", model, rows));

/** PATCH /v2/credential-profiles/stub/:id — the Accounts Enabled control. */
async function patchEnabled(daemon: Daemon, profileId: string, enabled: boolean) {
  const response = await fetch(`${daemon.base}/v2/credential-profiles/stub/${profileId}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  expect(response.status).toBe(200);
  return ControlCredentialProfileUpdateResponse.parse(await response.json()).profile;
}

/** GET /v2/accounts/routing-evidence, as the CLI and the app read it. */
const routingEvidence = async (daemon: Daemon) =>
  ControlAccountRoutingEvidenceResponse.parse(
    await (await fetch(`${daemon.base}/v2/accounts/routing-evidence`, { headers })).json(),
  );

describe("an Enabled toggle keeps the row's own service history", () => {
  it(
    "real PATCHes keep last-served through the read, a restart and ranking; a late old try stays fenced; a login still clears",
    async () => {
      script.lane = "agent";
      const [a, b] = accountsConfig();
      const root = temp("cx-last-service-root-");
      let daemon = await openDaemon(root);
      // A refuses model M; B serves it.
      script.behavior = { a: "refuse_usage", b: "serve" };
      expect((await run(daemon, "model-m")).spawns).toEqual(["a", "b"]);
      const servedB = (await routingEvidence(daemon)).lastService;
      expect(servedB.map((row) => [row.profile_id, row.requested_model])).toEqual([
        ["b", "model-m"],
      ]);
      // An Enabled PATCH that changes nothing, then off and on: same binding, same history.
      expect((await patchEnabled(daemon, "b", true)).enabled).toBe(true);
      expect((await routingEvidence(daemon)).lastService).toEqual(servedB);
      expect((await patchEnabled(daemon, "b", false)).enabled).toBe(false);
      expect((await patchEnabled(daemon, "b", true)).enabled).toBe(true);
      expect((await routingEvidence(daemon)).lastService).toEqual(servedB);
      // A restart forgets A's in-memory refusal; B's durable service still ranks it first.
      await daemon.close();
      daemon = await openDaemon(root);
      expect((await routingEvidence(daemon)).lastService).toEqual(servedB);
      script.behavior = { a: "serve", b: "serve" };
      const ranked = await run(daemon, "model-m");
      expect(ranked.selected[0]).toBe("b");
      expect(ranked.spawns).toEqual(["b"]);
      // The toggle still moves the credential generation: a try bound before it
      // records nothing after it, and the row's earlier history stays.
      script.afterStart = {
        b: async () => {
          await patchEnabled(daemon, "b", false);
          await patchEnabled(daemon, "b", true);
        },
      };
      expect((await run(daemon, "model-c", { pin: "b" })).lifecycle).toBe("succeeded");
      script.afterStart = {};
      expect(served(daemon, "model-c", [a!, b!])).toEqual({});
      expect(served(daemon, "model-m", [a!, b!])).toEqual({ b: expect.any(Number) });
      // A login lifecycle may replace the credential behind the same binding: its facts go.
      bustLoginCredentialState(
        () => daemon.graph.quota,
        daemon.graph.accounts,
        { invalidate() {} },
        "stub",
      );
      expect((await routingEvidence(daemon)).lastService).toEqual([]);
    },
    RUNS_TIMEOUT_MS,
  );
});

for (const lane of ["agent", "ask"] as const) {
  describe(`durable last-served order across a daemon restart (${lane} lane)`, () => {
    it(
      "the account that last served the model leads after a reopen; the reverse holds; other models keep id order",
      async () => {
        script.lane = lane;
        const [a, b] = accountsConfig();
        const root = temp("cx-last-service-root-");
        let daemon = await openDaemon(root);
        // A refuses model M before progress; B serves it.
        script.behavior = { a: "refuse_usage", b: "serve" };
        const first = await run(daemon, "model-m");
        expect(first.spawns).toEqual(["a", "b"]);
        expect(first.lifecycle).toBe("succeeded");
        expect(served(daemon, "model-m", [a!, b!])).toEqual({ b: expect.any(Number) });
        await daemon.close();

        // NEW store, graph and runtime: the in-memory refusal mark is gone,
        // the durable fact is not.
        daemon = await openDaemon(root);
        expect(daemon.graph.accounts.refusals.live()).toEqual([]);
        script.behavior = { a: "serve", b: "serve" };
        const afterRestart = await run(daemon, "model-m");
        expect(afterRestart.selected[0]).toBe("b");
        expect(afterRestart.spawns).toEqual(["b"]);
        // Another model has no history: deterministic id order.
        expect((await run(daemon, "model-other")).selected[0]).toBe("a");

        // Reverse: B refuses, A serves, and A leads after the next restart.
        script.behavior = { a: "serve", b: "refuse_invoice" };
        const reverse = await run(daemon, "model-m");
        expect(reverse.spawns).toEqual(["b", "a"]);
        expect(reverse.lifecycle).toBe("succeeded");
        await daemon.close();
        daemon = await openDaemon(root);
        script.behavior = { a: "serve", b: "serve" };
        const reopened = await run(daemon, "model-m");
        expect(reopened.selected[0]).toBe("a");
        expect(reopened.spawns).toEqual(["a"]);

        // A changed credential (the daemon's own invalidation owner) drops A's preference.
        bustCredentialStatusCaches(() => daemon.graph.quota, daemon.graph.accounts, {
          harnessId: "stub",
          profileId: "a",
        });
        expect(served(daemon, "model-m", [a!, b!])).toEqual({ b: expect.any(Number) });
        expect((await run(daemon, "model-m")).selected[0]).toBe("b");
        // A pin is strict: it runs where it is told, and its served try is real service.
        const pinned = await run(daemon, "model-m", { pin: "a" });
        expect(pinned.spawns).toEqual(["a"]);
        expect(pinned.selected).toEqual([]);
        expect((await run(daemon, "model-m")).selected[0]).toBe("a");
      },
      RUNS_TIMEOUT_MS,
    );

    it(
      "only a served request under this account's own identity becomes a fact",
      async () => {
        script.lane = lane;
        const [a] = accountsConfig();
        const daemon = await openDaemon(temp("cx-last-service-root-"));
        const facts = (model: string) => served(daemon, model, [a!]);
        // A picker/alias request answered under a resolved model label still serves.
        script.behavior = { a: "alias" };
        expect((await run(daemon, "fable", { pin: "a" })).lifecycle).toBe("succeeded");
        expect(facts("fable")).toEqual({ a: expect.any(Number) });
        // Events naming another account, or a paid API-key route, are not this row's service.
        script.behavior = { a: "foreign" };
        await run(daemon, "model-f", { pin: "a" });
        expect(facts("model-f")).toEqual({});
        script.behavior = { a: "paid" };
        await run(daemon, "model-p", { pin: "a" });
        expect(facts("model-p")).toEqual({});
        // An empty try or an errored message-only try served nothing.
        script.behavior = { a: "empty" };
        await run(daemon, "model-e", { pin: "a" });
        expect(facts("model-e")).toEqual({});
        script.behavior = { a: "message_error" };
        await run(daemon, "model-x", { pin: "a" });
        expect(facts("model-x")).toEqual({});
        // A try cancelled before progress served nothing.
        script.behavior = { a: "serve" };
        expect((await run(daemon, "model-c", { pin: "a", cancel: true })).lifecycle).toBe(
          "cancelled",
        );
        expect(facts("model-c")).toEqual({});
      },
      RUNS_TIMEOUT_MS,
    );

    it(
      "a login window or a credential change during the try publishes nothing, and a late old try never recreates a cleared fact",
      async () => {
        script.lane = lane;
        const [a] = accountsConfig();
        const daemon = await openDaemon(temp("cx-last-service-root-"));
        const facts = (model: string) => served(daemon, model, [a!]);
        const noReadiness = { invalidate() {} };
        const login = {
          open() {
            windowOpen = true;
            bustLoginCredentialState(
              () => daemon.graph.quota,
              daemon.graph.accounts,
              noReadiness,
              "stub",
            );
          },
          close() {
            windowOpen = false;
            bustLoginCredentialState(
              () => daemon.graph.quota,
              daemon.graph.accounts,
              noReadiness,
              "stub",
            );
          },
        };
        script.behavior = { a: "serve" };
        try {
          // The window opens while the session is in flight.
          script.afterStart = { a: () => login.open() };
          await run(daemon, "model-w", { pin: "a" });
          expect(facts("model-w")).toEqual({});
          // A try bound inside the open window.
          script.afterStart = {};
          await run(daemon, "model-in", { pin: "a" });
          expect(facts("model-in")).toEqual({});
        } finally {
          login.close();
        }
        // After the proven close the account's service counts again.
        await run(daemon, "model-w", { pin: "a" });
        expect(facts("model-w")).toEqual({ a: expect.any(Number) });

        // A served fact, then a credential change lands mid-try: the old try's
        // late progress must not recreate what the change cleared.
        await run(daemon, "model-s", { pin: "a" });
        expect(facts("model-s")).toEqual({ a: expect.any(Number) });
        script.afterStart = {
          a: () =>
            bustCredentialStatusCaches(() => daemon.graph.quota, daemon.graph.accounts, {
              harnessId: "stub",
              profileId: "a",
            }),
        };
        expect((await run(daemon, "model-s", { pin: "a" })).lifecycle).toBe("succeeded");
        expect(facts("model-s")).toEqual({});
      },
      RUNS_TIMEOUT_MS,
    );
  });
}

for (const lane of ["agent", "ask"] as const) {
  describe(`per-try refusals reach every terminal consumer (${lane} lane)`, () => {
    it(
      "two accounts' different refusals survive in order through failure.yaml, events, summaries, GET /v2/runs and MCP",
      async () => {
        script.lane = lane;
        accountsConfig();
        const daemon = await openDaemon(temp("cx-last-service-root-"));
        script.behavior = { a: "refuse_usage", b: "refuse_invoice" };
        const result = await run(daemon, "model-m");
        expect(result.spawns).toEqual(["a", "b"]);
        expect(result.lifecycle).toBe("failed");
        const failure = RunFailure.parse(result.detail["failure"]);
        // Untyped refusals keep the original harness classification.
        expect(failure).toMatchObject({ category: "harness_error", code: null });
        expect(
          failure.poolAttempts.map((row) => [row.profileId, row.tryIndex, row.phase, row.error]),
        ).toEqual([
          ["a", 0, "pre_progress", REFUSAL["refuse_usage"]],
          ["b", 1, "pre_progress", REFUSAL["refuse_invoice"]],
        ]);
        // The artifact, the run detail and its summary carry the same record.
        expect(result.failure).toEqual(failure);
        const attempts = (text: string) => text.slice(text.indexOf("Account attempts:"));
        for (const text of [failure.safeMessage, result.summaryMd, String(result.error)]) {
          const listed = attempts(text);
          expect(listed.indexOf(REFUSAL["refuse_usage"]!)).toBeGreaterThan(0);
          expect(listed.indexOf(REFUSAL["refuse_invoice"]!)).toBeGreaterThan(
            listed.indexOf(REFUSAL["refuse_usage"]!),
          );
        }
        // The run list projects the same record.
        const list = (await (
          await fetch(`${daemon.base}/v2/runs?limit=5`, { headers })
        ).json()) as Record<string, unknown>;
        const items = Object.values(list).find(Array.isArray) as Array<Record<string, unknown>>;
        const item = items.find((entry) => entry["runId"] === result.runId);
        expect(RunFailure.parse(item?.["failure"]).poolAttempts).toEqual(failure.poolAttempts);
        // The MCP run projection preserves it.
        expect(projectImmediateRunDetail(result.detail).failure).toEqual(failure);
        // Terminal and rotation events carry the same ordered list.
        const failed = result.events.find((e) => e.type === "run.failed")!;
        expect(failed.payload["pool_attempts"]).toEqual(failure.poolAttempts);
        const exhausted = result.events.find((e) => e.type === "route.profile.rotation_exhausted")!;
        expect(exhausted.payload["pool_attempts"]).toEqual(failure.poolAttempts);
        expect(
          (exhausted.payload["candidates"] as Array<Record<string, unknown>>).map((c) => [
            c["profile_id"],
            (c["attempt_failures"] as Array<{ error: string }>).map((f) => f.error),
          ]),
        ).toEqual([
          ["a", [REFUSAL["refuse_usage"]]],
          ["b", [REFUSAL["refuse_invoice"]]],
        ]);

        // The additive Accounts read reports the live marks from the real service.
        const evidence = ControlAccountRoutingEvidenceResponse.parse(
          await (await fetch(`${daemon.base}/v2/accounts/routing-evidence`, { headers })).json(),
        );
        expect(evidence.refusals.map((mark) => [mark.profile_id, mark.requested_model])).toEqual([
          ["a", "model-m"],
          ["b", "model-m"],
        ]);
        expect(evidence.lastService).toEqual([]);
      },
      RUNS_TIMEOUT_MS,
    );

    it(
      "rewording the refusals changes no decision, and a success after fallback has no failure",
      async () => {
        script.lane = lane;
        accountsConfig();
        const daemon = await openDaemon(temp("cx-last-service-root-"));
        script.behavior = { a: "refuse_invoice", b: "refuse_usage" };
        const reworded = await run(daemon, "model-m");
        script.behavior = { a: "refuse_usage", b: "refuse_invoice" };
        const original = await run(daemon, "model-other");
        for (const result of [reworded, original]) {
          expect(result.spawns).toEqual(["a", "b"]);
          expect(result.failure).toMatchObject({ category: "harness_error", code: null });
          expect(result.failure?.poolAttempts.map((row) => row.phase)).toEqual([
            "pre_progress",
            "pre_progress",
          ]);
          expect(result.events.map((e) => e.type)).toContain("route.profile.rotation_exhausted");
        }
        expect(reworded.failure?.poolAttempts.map((row) => row.error)).toEqual([
          REFUSAL["refuse_invoice"],
          REFUSAL["refuse_usage"],
        ]);
        // A served fallback is a success: no failure record, no account list.
        script.behavior = { a: "refuse_usage", b: "serve" };
        const fallback = await run(daemon, "model-e");
        expect(fallback.lifecycle).toBe("succeeded");
        expect(fallback.failure).toBeNull();
        expect(fallback.detail["failure"]).toBeNull();
        expect(fallback.summaryMd).not.toContain("Account attempts:");
      },
      RUNS_TIMEOUT_MS,
    );
  });
}
