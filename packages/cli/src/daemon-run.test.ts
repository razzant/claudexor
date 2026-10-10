import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { type Server as NetServer, createServer as createNetServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeOutcomeFacts } from "@claudexor/schema";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError } from "./cli-error.js";
import * as daemonApi from "@claudexor/daemon";
import * as daemonLaunch from "./daemon-launch.js";
import { daemonCommand } from "./ops-commands.js";
import { parseArgs } from "./args.js";
import { ENGINE_STOP_REMEDY, observedEngineSkew, recordEngineSkew } from "./engine-skew.js";
import {
  DAEMON_CONTROL_API_FRESH_START_TAIL_MS,
  DAEMON_START_READY_TIMEOUT_MS,
  connectDaemonIfRunning,
  daemonOutcomeSummary,
  ensureDaemon,
  enqueueAndAwait,
  exitCodeForState,
  mergeDaemonRunOutcome,
  waitForDaemonReady,
} from "./daemon-run.js";

afterEach(() => vi.unstubAllGlobals());

describe("exitCodeForState (D8: the lifecycle IS the exit code)", () => {
  it("maps a succeeded lifecycle to 0 and every other lifecycle to 1", () => {
    // A succeeded lifecycle is 0 — a "Done · needs review" run is still
    // succeeded and exits 0; applyability speaks through applyEligibility.
    expect(exitCodeForState("succeeded")).toBe(0);
    for (const bad of ["failed", "cancelled", "interrupted"]) {
      expect(exitCodeForState(bad)).toBe(1);
    }
  });
});

describe("daemonOutcomeSummary (P2: a reason on every non-clean daemon terminal, D8)", () => {
  it("returns undefined for a clean succeeded run (no summary key)", () => {
    expect(daemonOutcomeSummary({ runId: "r1", status: "succeeded" })).toBeUndefined();
    expect(
      daemonOutcomeSummary({
        runId: "r1",
        status: "succeeded",
        outcomeFacts: makeOutcomeFacts("succeeded", { noChanges: true }),
      }),
    ).toBeUndefined();
  });

  it("surfaces the actionable decision hint for a needs-decision run (succeeded + review blocked)", () => {
    const s = daemonOutcomeSummary({
      runId: "run-abc",
      status: "succeeded",
      outcomeFacts: makeOutcomeFacts("succeeded", { review: "blocked", reason: "review_blocked" }),
    });
    expect(s).toContain("decision");
    expect(s).toContain("claudexor decision run-abc");
  });

  it("prefers a real error message when present", () => {
    expect(daemonOutcomeSummary({ runId: "r1", status: "failed", error: "boom" })).toBe("boom");
  });

  it("falls back to a lifecycle+reason label for other non-succeeded terminals", () => {
    expect(
      daemonOutcomeSummary({
        runId: "r1",
        status: "failed",
        outcomeFacts: makeOutcomeFacts("failed", { reason: "not_converged" }),
      }),
    ).toBe("run failed (not_converged)");
    expect(
      daemonOutcomeSummary({
        runId: "r1",
        status: "failed",
        outcomeFacts: makeOutcomeFacts("failed", { reason: "stuck_no_progress" }),
      }),
    ).toBe("run failed (stuck_no_progress)");
  });

  it.each([
    ["needs_input", "input_required"],
    ["incomplete", "work_incomplete"],
  ] as const)("surfaces a succeeded %s work-state veto", (state, reason) => {
    const summary = daemonOutcomeSummary({
      runId: "r-work-state",
      status: "succeeded",
      outcomeFacts: makeOutcomeFacts("succeeded", {
        reason,
        work_state: {
          state,
          source: "constrained",
          ...(state === "needs_input"
            ? {
                required_inputs: [
                  {
                    kind: "decision" as const,
                    locator: null,
                    description: "Choose a target",
                  },
                ],
              }
            : {}),
        },
      }),
    });
    expect(summary).toContain(`run succeeded (${reason})`);
  });
});

describe("enqueueAndAwait typed ControlProblem transport", () => {
  it("never forwards a client-supplied frozen-plan reference to a thread turn", async () => {
    let posted: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        posted = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ jobId: "job-turn", runId: "run-turn", runDir: "/tmp/run-turn" }),
          { status: 202 },
        );
      }),
    );
    const client = { status: vi.fn().mockResolvedValue({ state: "running" }) };
    await enqueueAndAwait(
      client as never,
      { baseUrl: "http://127.0.0.1:1", token: "t" },
      {
        threadId: "thread-1",
        prompt: "implement",
        planRef: { runId: "forged", sha256: "a".repeat(64), path: "/tmp/forged" },
      },
      { waitForTerminal: false },
    );
    expect(posted).toEqual({ prompt: "implement" });
  });

  it("preserves Git remediation instead of flattening the failed start to prose", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: "git_developer_tools_stub",
              message: "Git is unavailable because Apple Command Line Tools are not installed.",
              retryable: false,
              fieldErrors: {},
              requiredActions: ["Install Apple Command Line Tools with `xcode-select --install`."],
              evidenceRefs: [],
              context: { capability: "git", capabilityStatus: "developer_tools_stub" },
            }),
            { status: 503, headers: { "content-type": "application/problem+json" } },
          ),
      ),
    );
    await expect(
      enqueueAndAwait(
        {} as never,
        { baseUrl: "http://127.0.0.1:1", token: "t" },
        { prompt: "go", mode: "agent" },
        { waitForTerminal: false },
      ),
    ).rejects.toMatchObject({
      code: "git_developer_tools_stub",
      retryable: false,
      requiredActions: [expect.stringContaining("xcode-select --install")],
      context: { capability: "git", capabilityStatus: "developer_tools_stub" },
    });
  });

  it("preserves the durable daemon status problem when a run is refused before materialization", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ jobId: "job-git-refused" }), {
            status: 202,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const client = {
      status: vi.fn().mockResolvedValue({
        id: "job-git-refused",
        state: "failed",
        error: "Git is unavailable because Apple Command Line Tools are not installed.",
        errorCode: "git_developer_tools_stub",
        errorStatus: 503,
        errorRetryable: false,
        errorRequiredActions: ["Install Apple Command Line Tools with `xcode-select --install`."],
        errorContext: { capability: "git", capabilityStatus: "developer_tools_stub" },
      }),
    };

    await expect(
      enqueueAndAwait(
        client as never,
        { baseUrl: "http://127.0.0.1:1", token: "t" },
        { prompt: "go", mode: "agent" },
        { waitForTerminal: true },
      ),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "git_developer_tools_stub",
      errorRetryable: false,
      errorRequiredActions: [expect.stringContaining("xcode-select --install")],
      errorContext: { capability: "git", capabilityStatus: "developer_tools_stub" },
    });
  });

  it("preserves the typed terminal problem when an NDJSON/human run merges final status", () => {
    expect(
      mergeDaemonRunOutcome(
        {
          runId: "run-git-refused",
          runDir: "/runs/run-git-refused",
          status: "running",
          jobId: "job-git-refused",
        },
        {
          state: "failed",
          error: "Git is unavailable",
          errorCode: "git_developer_tools_stub",
          errorStatus: 503,
          errorRetryable: false,
          errorRequiredActions: ["Install Apple Command Line Tools with xcode-select --install."],
          errorContext: { capability: "git", capabilityStatus: "developer_tools_stub" },
        },
      ),
    ).toMatchObject({
      status: "failed",
      errorCode: "git_developer_tools_stub",
      errorRetryable: false,
      errorRequiredActions: [expect.stringContaining("xcode-select --install")],
      errorContext: { capability: "git", capabilityStatus: "developer_tools_stub" },
    });
  });
});

// The daemon's own typed 422 against a NEWER config schema — the #93 report's
// exact failure: a stale 3.2.x app daemon strict-parses a 3.3.x config.yaml
// and blames the user's file.
const CONFIG_INVALID_422 = () =>
  new Response(
    JSON.stringify({
      code: "config_invalid",
      message: "unknown key(s) at runtime.model_quota",
      retryable: false,
      fieldErrors: {},
      requiredActions: ["inspect and fix ~/.claudexor/config.yaml against the current schema"],
      evidenceRefs: [],
      context: { path: "~/.claudexor/config.yaml" },
    }),
    { status: 422, headers: { "content-type": "application/problem+json" } },
  );

describe("engine-skew stamping on typed control failures (#93)", () => {
  afterEach(() => recordEngineSkew(null));

  it("stamps the observed skew and stop remedy onto a stale daemon's 422 config_invalid", async () => {
    recordEngineSkew({
      daemonVersion: "3.2.1",
      daemonSha: "a".repeat(40),
      cliVersion: CLAUDEXOR_VERSION,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => CONFIG_INVALID_422()),
    );
    const err: unknown = await enqueueAndAwait(
      {} as never,
      { baseUrl: "http://127.0.0.1:1", token: "t" },
      { prompt: "go", mode: "agent" },
      { waitForTerminal: false },
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(err).toBeInstanceOf(CliError);
    const problem = err as CliError;
    expect(problem.code).toBe("config_invalid");
    expect(problem.requiredActions).toEqual([
      "inspect and fix ~/.claudexor/config.yaml against the current schema",
      ENGINE_STOP_REMEDY,
    ]);
    expect(problem.context).toEqual({
      path: "~/.claudexor/config.yaml",
      engineSkew: {
        daemonVersion: "3.2.1",
        daemonSha: "a".repeat(40),
        cliVersion: CLAUDEXOR_VERSION,
      },
    });
  });

  it("leaves an unskewed connection's envelope exactly as the wire sent it", async () => {
    recordEngineSkew(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => CONFIG_INVALID_422()),
    );
    const err: unknown = await enqueueAndAwait(
      {} as never,
      { baseUrl: "http://127.0.0.1:1", token: "t" },
      { prompt: "go", mode: "agent" },
      { waitForTerminal: false },
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(err).toBeInstanceOf(CliError);
    const problem = err as CliError;
    // Byte-stable: EXACT wire fields, no engineSkew context, no appended remedy.
    expect(problem.requiredActions).toEqual([
      "inspect and fix ~/.claudexor/config.yaml against the current schema",
    ]);
    expect(problem.context).toEqual({ path: "~/.claudexor/config.yaml" });
  });
});

/** A fake claudexord socket: replies ok to every newline-delimited RPC line. */
function fakeDaemonSocket(path: string): Promise<NetServer> {
  return new Promise((resolve) => {
    const server = createNetServer((sock) => {
      let buf = "";
      sock.on("data", (chunk) => {
        buf += String(chunk);
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            const msg = JSON.parse(line) as { id?: number };
            sock.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\n");
          } catch {
            /* ignore malformed lines */
          }
        }
      });
    });
    server.listen(path, () => resolve(server));
  });
}

/** A control-API stub whose handshake behavior is per-test. */
function fakeControlApi(
  handshake: () => { status: number; body: string },
): Promise<{ server: HttpServer; port: number }> {
  return new Promise((resolve) => {
    const server = createHttpServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
        return;
      }
      const out = handshake();
      res.writeHead(out.status, { "content-type": "application/problem+json" });
      res.end(out.body);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

const TYPED_426 = () => ({
  status: 426,
  body: JSON.stringify({
    code: "incompatible_protocol_major",
    message: "control protocol major 3 is incompatible; server requires 4",
    retryable: false,
    fieldErrors: {},
    requiredActions: ["use control protocol major 4"],
    evidenceRefs: [],
  }),
});

/** The daemon-server's own stopping refusal (daemon-server.ts, `this.stopping`). */
const TYPED_STOPPING_503 = () => ({
  status: 503,
  body: JSON.stringify({
    code: "daemon_stopping",
    message: "daemon is stopping; no new product request was admitted",
    retryable: true,
    fieldErrors: {},
    requiredActions: ["reconnect"],
    evidenceRefs: [],
  }),
});

/** A recovery-only daemon's SUCCESSFUL handshake (issue #165 D5 / C7). */
const RECOVERY_ONLY_200 = () => ({
  status: 200,
  body: JSON.stringify({
    protocolMajor: 3,
    compatible: true,
    operationsPath: "/v2/operations",
    engine: { version: CLAUDEXOR_VERSION, sha: "unknown", entry: "/opt/claudexor/daemon.js" },
    servingMode: "recovery_only",
  }),
});

/** A normally-serving daemon's handshake (stage 4 completed). */
const NORMAL_200 = () => ({
  status: 200,
  body: JSON.stringify({
    protocolMajor: 3,
    compatible: true,
    operationsPath: "/v2/operations",
    engine: { version: CLAUDEXOR_VERSION, sha: "unknown", entry: "/opt/claudexor/daemon.js" },
    servingMode: "normal",
  }),
});

/** Stage-3→4 startup: the first N handshakes report recovery_only, then normal. */
const STARTUP_WINDOW_200 = (recoveryHandshakes: number) => {
  let seen = 0;
  return () => (seen++ < recoveryHandshakes ? RECOVERY_ONLY_200() : NORMAL_200());
};

describe("absence vs refusal discrimination (#93)", () => {
  let dir: string;
  let prevConfigDir: string | undefined;
  let prevSock: string | undefined;
  let prevEntry: string | undefined;
  let socketServer: NetServer | null = null;
  let httpServer: HttpServer | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(realpathSync(tmpdir()), "cx-dr-"));
    prevConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    prevSock = process.env.CLAUDEXOR_DAEMON_SOCK;
    prevEntry = process.env.CLAUDEXOR_DAEMON_ENTRY;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    process.env.CLAUDEXOR_DAEMON_SOCK = join(dir, "d.sock");
    recordEngineSkew(null);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (socketServer) await new Promise<void>((r) => socketServer!.close(() => r()));
    if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
    socketServer = null;
    httpServer = null;
    if (prevConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prevConfigDir;
    if (prevSock === undefined) delete process.env.CLAUDEXOR_DAEMON_SOCK;
    else process.env.CLAUDEXOR_DAEMON_SOCK = prevSock;
    if (prevEntry === undefined) delete process.env.CLAUDEXOR_DAEMON_ENTRY;
    else process.env.CLAUDEXOR_DAEMON_ENTRY = prevEntry;
    recordEngineSkew(null);
    rmSync(dir, { recursive: true, force: true });
  });

  function writeDaemonFixture(controlApiPort: number): void {
    const daemonDir = join(dir, "daemon");
    mkdirSync(daemonDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(daemonDir, "token"), "tkn-93\n", { mode: 0o600 });
    writeFileSync(
      join(daemonDir, "control-api.json"),
      JSON.stringify({ host: "127.0.0.1", port: controlApiPort }),
      { mode: 0o600 },
    );
  }

  it("connectDaemonIfRunning: absence (no daemon at all) is null, never a spawn", async () => {
    expect(await connectDaemonIfRunning()).toBeNull();
  });

  it("external ownership refuses absent ordinary actions before root/token/spawn and lifecycle changes", async () => {
    vi.stubEnv("CLAUDEXOR_DAEMON_OWNER", "external");
    const missingRoot = join(dir, "missing");
    process.env.CLAUDEXOR_CONFIG_DIR = missingRoot;
    vi.stubEnv("CLAUDEXOR_DAEMON_ENTRY", join(dir, "absent-fixture-entry.mjs"));
    const token = vi.spyOn(daemonApi, "ensureToken");
    const launch = vi.spyOn(daemonLaunch, "launchDetachedDaemon");
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const action of [
      () => ensureDaemon(),
      ...["start", "stop", "rotate-token"].map(
        (verb) => () => daemonCommand(parseArgs(["daemon", verb]), true),
      ),
    ])
      await expect(action()).rejects.toMatchObject({
        code: expect.stringMatching(/daemon_(unavailable|lifecycle_external)/),
      });
    expect(token).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(missingRoot)).toBe(false);
  });

  it.each([NORMAL_200, RECOVERY_ONLY_200])(
    "external attachment preserves the serving mode and ignores stale socket overrides",
    async (handshake) => {
      vi.stubEnv("CLAUDEXOR_DAEMON_OWNER", "external");
      const api = await fakeControlApi(handshake);
      httpServer = api.server;
      writeDaemonFixture(api.port);
      socketServer = await fakeDaemonSocket(daemonApi.canonicalDefaultSocketPath());
      const token = vi.spyOn(daemonApi, "ensureToken");
      const launch = vi.spyOn(daemonLaunch, "launchDetachedDaemon");
      const connection = await ensureDaemon(1);
      expect(connection.engine.servingMode).toBe(JSON.parse(handshake().body).servingMode);
      expect(token).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
      rmSync(join(dir, "daemon", "control-api.json"));
      await expect(ensureDaemon(1)).rejects.toMatchObject({ code: "daemon_unavailable" });
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "standalone"])(
    "standalone custom-root auto-start (%s) still creates its token and reaches normal admission",
    async (owner) => {
      vi.stubEnv("CLAUDEXOR_DAEMON_OWNER", owner);
      vi.stubEnv("CLAUDEXOR_MANAGED", "claudexor:managed host-plugin-lifecycle");
      const api = await fakeControlApi(NORMAL_200);
      httpServer = api.server;
      const launch = vi.spyOn(daemonLaunch, "launchDetachedDaemon").mockImplementation(() => {
        writeFileSync(
          join(dir, "daemon", "control-api.json"),
          JSON.stringify({ host: "127.0.0.1", port: api.port }),
        );
        void fakeDaemonSocket(process.env.CLAUDEXOR_DAEMON_SOCK as string).then((server) => {
          socketServer = server;
        });
        return {
          pid: null,
          failure: () => null,
          waitForFailure: () => new Promise(() => {}),
          markReady: () => {},
          callerError: () => new CliError("operational", "fixture failed"),
        };
      });
      expect((await ensureDaemon(5_000)).engine.servingMode).toBe("normal");
      expect(launch).toHaveBeenCalledOnce();
      expect(existsSync(join(dir, "daemon", "token"))).toBe(true);
    },
  );

  it("pins the control-API fresh-start tail as a NAMED slice of the start budget (C10)", () => {
    // ensureDaemon waits this bounded tail for the control-api pointer AFTER
    // the socket answers; it must never grow past the whole start budget.
    expect(DAEMON_CONTROL_API_FRESH_START_TAIL_MS).toBe(10_000);
    expect(DAEMON_CONTROL_API_FRESH_START_TAIL_MS).toBeLessThan(DAEMON_START_READY_TIMEOUT_MS);
  });

  it("waitForDaemonReady: the default budget covers a journal-heavy cold start", async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = waitForDaemonReady().finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(DAEMON_START_READY_TIMEOUT_MS - 15_000);
    expect(await pending).toBeNull();
  });

  it("connectDaemonIfRunning: healthz connect-refused is null and clears the skew record", async () => {
    // Live socket, but the control-api pointer names a port nobody listens on.
    const probe = await fakeControlApi(TYPED_426);
    const deadPort = probe.port;
    await new Promise<void>((r) => probe.server.close(() => r()));
    socketServer = await fakeDaemonSocket(process.env.CLAUDEXOR_DAEMON_SOCK as string);
    writeDaemonFixture(deadPort);
    recordEngineSkew({ daemonVersion: "9.9.9", cliVersion: CLAUDEXOR_VERSION });
    expect(await connectDaemonIfRunning()).toBeNull();
    expect(observedEngineSkew()).toBeNull();
  });

  it("connectDaemonIfRunning: a CORRUPT control-api pointer is LOUD, never 'not running' (R1 C-C3a)", async () => {
    socketServer = await fakeDaemonSocket(process.env.CLAUDEXOR_DAEMON_SOCK as string);
    const daemonDir = join(dir, "daemon");
    mkdirSync(daemonDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(daemonDir, "token"), "tkn-93\n", { mode: 0o600 });
    writeFileSync(join(daemonDir, "control-api.json"), "{corrupt-not-json", { mode: 0o600 });
    const err: unknown = await connectDaemonIfRunning().then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(err).toBeInstanceOf(CliError);
    const problem = err as CliError;
    expect(problem.code).toBe("control_pointer_invalid");
    // Bounded: the pointer path rides along; the raw bytes never do.
    expect(problem.message).toContain("control-api.json");
    expect(problem.message).not.toContain("{corrupt-not-json");
  });

  it("connectDaemonIfRunning: an EMPTY pointer (mid-write race window) stays absence", async () => {
    // The daemon's pointer write has an open-truncate→write window; a reader
    // racing it sees zero bytes and must keep polling, not fail loud.
    socketServer = await fakeDaemonSocket(process.env.CLAUDEXOR_DAEMON_SOCK as string);
    const daemonDir = join(dir, "daemon");
    mkdirSync(daemonDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(daemonDir, "token"), "tkn-93\n", { mode: 0o600 });
    writeFileSync(join(daemonDir, "control-api.json"), "", { mode: 0o600 });
    expect(await connectDaemonIfRunning()).toBeNull();
  });

  it("connectDaemonIfRunning: a typed handshake refusal PROPAGATES instead of reading as 'not running'", async () => {
    socketServer = await fakeDaemonSocket(process.env.CLAUDEXOR_DAEMON_SOCK as string);
    const api = await fakeControlApi(TYPED_426);
    httpServer = api.server;
    writeDaemonFixture(api.port);
    const err: unknown = await connectDaemonIfRunning().then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe("incompatible_protocol_major");
    expect((err as CliError).requiredActions).toContain(ENGINE_STOP_REMEDY);
  });

  it("connectDaemonIfRunning: a typed daemon_stopping handshake refusal reads as ABSENCE (R2)", async () => {
    // Healthz answered ok, then the daemon began stopping before the handshake
    // landed: a MATCHING daemon's typed daemon_stopping is absence-in-progress
    // (the same stopping-as-absence semantics as the 503 health case, R1
    // C-C3b) — null, no throw, no mismatch advisory, skew record cleared.
    socketServer = await fakeDaemonSocket(process.env.CLAUDEXOR_DAEMON_SOCK as string);
    const api = await fakeControlApi(TYPED_STOPPING_503);
    httpServer = api.server;
    writeDaemonFixture(api.port);
    recordEngineSkew({ daemonVersion: "9.9.9", cliVersion: CLAUDEXOR_VERSION });
    const stderrChunks: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown): boolean => {
        stderrChunks.push(String(chunk));
        return true;
      });
    try {
      expect(await connectDaemonIfRunning()).toBeNull();
    } finally {
      stderrSpy.mockRestore();
    }
    expect(observedEngineSkew()).toBeNull();
    expect(stderrChunks.join("")).toBe("");
  });

  it("connectDaemonIfRunning: surfaces the handshake servingMode to read-only consumers (C7a)", async () => {
    socketServer = await fakeDaemonSocket(process.env.CLAUDEXOR_DAEMON_SOCK as string);
    const api = await fakeControlApi(RECOVERY_ONLY_200);
    httpServer = api.server;
    writeDaemonFixture(api.port);
    const conn = await connectDaemonIfRunning();
    expect(conn).not.toBeNull();
    expect(conn!.engine.servingMode).toBe("recovery_only");
  });

  it("ensureDaemon: a daemon that STAYS recovery-only past the budget fails typed + retryable, never proceeding into route refusals (C7d)", async () => {
    socketServer = await fakeDaemonSocket(process.env.CLAUDEXOR_DAEMON_SOCK as string);
    const api = await fakeControlApi(RECOVERY_ONLY_200);
    httpServer = api.server;
    writeDaemonFixture(api.port);
    // Short budget: a genuinely blocked root never opens normal admission, so
    // the bounded wait must end in the SAME typed error as before, only later.
    const err: unknown = await ensureDaemon(600).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(err).toBeInstanceOf(CliError);
    const problem = err as CliError;
    expect(problem.code).toBe("daemon_recovery_only");
    expect(problem.retryable).toBe(true);
    expect(problem.message).toContain("serving recovery only");
  });

  it("ensureDaemon: a HEALTHY daemon still in startup stage 4 (transient recovery_only handshake) is waited for, not failed (CR3)", async () => {
    // D5 stage 3 writes the pointer with admission closed; stage 4 opens
    // normal admission after journal recovery. ensureDaemon must ride that
    // window out within its budget instead of throwing daemon_recovery_only
    // at a healthy auto-start.
    socketServer = await fakeDaemonSocket(process.env.CLAUDEXOR_DAEMON_SOCK as string);
    const api = await fakeControlApi(STARTUP_WINDOW_200(2));
    httpServer = api.server;
    writeDaemonFixture(api.port);
    const conn = await ensureDaemon(5_000);
    expect(conn.engine.servingMode).toBe("normal");
  });

  it("waitForDaemonReady: reports the TERMINAL servingMode, not the transient stage-3 recovery_only (CR3)", async () => {
    socketServer = await fakeDaemonSocket(process.env.CLAUDEXOR_DAEMON_SOCK as string);
    const api = await fakeControlApi(STARTUP_WINDOW_200(2));
    httpServer = api.server;
    writeDaemonFixture(api.port);
    const conn = await waitForDaemonReady(5_000);
    expect(conn).not.toBeNull();
    expect(conn!.engine.servingMode).toBe("normal");
  });

  it("waitForDaemonReady: a genuinely blocked root is reported honestly as recovery_only at the deadline (CR3)", async () => {
    socketServer = await fakeDaemonSocket(process.env.CLAUDEXOR_DAEMON_SOCK as string);
    const api = await fakeControlApi(RECOVERY_ONLY_200);
    httpServer = api.server;
    writeDaemonFixture(api.port);
    const conn = await waitForDaemonReady(600);
    expect(conn).not.toBeNull();
    expect(conn!.engine.servingMode).toBe("recovery_only");
  });

  it("ensureDaemon: a typed refusal short-circuits (no 10s control-API wait, no NO_CONTROL_API flatten)", async () => {
    socketServer = await fakeDaemonSocket(process.env.CLAUDEXOR_DAEMON_SOCK as string);
    const api = await fakeControlApi(TYPED_426);
    httpServer = api.server;
    writeDaemonFixture(api.port);
    const startedAt = Date.now();
    const err: unknown = await ensureDaemon().then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe("incompatible_protocol_major");
    expect((err as CliError).message).not.toContain("CLAUDEXOR_NO_CONTROL_API");
    expect(Date.now() - startedAt).toBeLessThan(8_000);
  }, 20_000);

  it("ensureDaemon: the post-auto-start handshake fires the same typed problem (singleton-race daemon)", async () => {
    // No socket initially -> ensureDaemon auto-starts CLAUDEXOR_DAEMON_ENTRY.
    // The fake entry simulates LOSING the singleton race to a foreign daemon:
    // a socket comes up, but the control API refuses this CLI's major.
    const api = await fakeControlApi(TYPED_426);
    httpServer = api.server;
    writeDaemonFixture(api.port);
    const pidFile = join(dir, "fake-daemon.pid");
    const sourceFile = join(dir, "fake-daemon.launch-source");
    const entry = join(dir, "fake-daemon-entry.cjs");
    writeFileSync(
      entry,
      [
        'const net = require("node:net");',
        'const fs = require("node:fs");',
        "const server = net.createServer((sock) => {",
        '  let buf = "";',
        '  sock.on("data", (chunk) => {',
        "    buf += String(chunk);",
        "    let nl;",
        '    while ((nl = buf.indexOf("\\n")) >= 0) {',
        "      const line = buf.slice(0, nl);",
        "      buf = buf.slice(nl + 1);",
        "      try {",
        "        const msg = JSON.parse(line);",
        '        sock.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");',
        "      } catch {}",
        "    }",
        "  });",
        "});",
        "server.listen(process.env.CLAUDEXOR_DAEMON_SOCK, () => {",
        "  fs.writeFileSync(process.env.CLAUDEXOR_FAKE_DAEMON_PID_FILE, String(process.pid));",
        '  fs.writeFileSync(process.env.CLAUDEXOR_FAKE_DAEMON_SOURCE_FILE, process.env.CLAUDEXOR_DAEMON_LAUNCH_SOURCE || "missing");',
        "});",
        "setTimeout(() => process.exit(0), 15000);",
      ].join("\n"),
    );
    process.env.CLAUDEXOR_DAEMON_ENTRY = entry;
    process.env.CLAUDEXOR_FAKE_DAEMON_PID_FILE = pidFile;
    process.env.CLAUDEXOR_FAKE_DAEMON_SOURCE_FILE = sourceFile;
    try {
      const err: unknown = await ensureDaemon().then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe("incompatible_protocol_major");
      expect((err as CliError).requiredActions).toContain(ENGINE_STOP_REMEDY);
      expect(readFileSync(sourceFile, "utf8")).toBe("cli_ensure_daemon");
    } finally {
      delete process.env.CLAUDEXOR_FAKE_DAEMON_PID_FILE;
      delete process.env.CLAUDEXOR_FAKE_DAEMON_SOURCE_FILE;
      // Exact-PID cleanup of OUR fake daemon (it also self-exits after 15s).
      try {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (Number.isInteger(pid) && pid > 1) process.kill(pid);
      } catch {
        /* already gone */
      }
    }
  }, 30_000);
});
