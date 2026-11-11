/**
 * `claudexor inspect <id>` lookup outcomes (claudexor#235), end to end through
 * the BUILT CLI (`dist/cli.js`, so `pnpm build` first).
 *
 * Only the run registry's own 404 from a running daemon may say `no such run`.
 * A local retained run answers without the daemon; everything else that stops
 * the lookup keeps its own typed code: a malformed id, no reachable daemon (a
 * cross-project run cannot be ruled out), a lost connection, a daemon problem
 * response or any other 404, an invalid success body, a known run with no run
 * directory yet, and a known run whose recorded directory is missing,
 * unreadable or outside a run store.
 *
 * Each test owns a private config root with a JSON-line endpoint (the
 * platform's daemon socket or pipe) answering the health probe. Run semantics
 * come from the real `DaemonControlApiServer` over a synthetic run registry; a
 * raw HTTP stub supplies only shapes the real server cannot produce on demand
 * (route-level 401/426, other 404s, malformed bodies, a dropped connection,
 * unusual recorded directories). The child environment follows the minimal
 * cross-platform set of sql-daemon-startup.test.ts (HOME/USERPROFILE, private
 * temp, Node's own PATH entry, SystemRoot on Windows) plus a daemon entry that
 * does not exist, so an accidental auto-start fails instead of booting a real
 * daemon. No provider keys and no daemon endpoint overrides reach the CLI.
 * The unreadable-directory case relies on POSIX permission bits; it is skipped,
 * visibly, on Windows and for root, and Windows ACLs are not exercised here.
 *
 * With CLAUDEXOR_TEST_CAPTURE_INSPECT_DIR set to an absolute path, every CLI
 * invocation's complete stdout/stderr/exit status is kept there unmodified.
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ArtifactStore } from "@claudexor/artifact-store";
import {
  DaemonControlApiServer,
  type DaemonFacadeClient,
  type DaemonRunRecord,
} from "@claudexor/control-api";
import { canonicalDefaultSocketPath } from "@claudexor/daemon";
import { CONTROL_PROTOCOL_MAJOR } from "@claudexor/schema";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { afterEachClosed } from "./test-support/after-each-closed.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const TOKEN = "fixture-token";
const CAPTURE_DIR = process.env["CLAUDEXOR_TEST_CAPTURE_INSPECT_DIR"];
const START_REMEDY = "start the daemon with `claudexor daemon start`, then retry";

type Route = (req: IncomingMessage, res: ServerResponse) => void;

interface CliResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

let dir: string;
let home: string;
let root: string;
let cwd: string;
let requests: string[];
let closers: Array<() => Promise<void> | void>;
let captured = 0;

beforeEach(() => {
  // Leave room for daemon/claudexord.sock under a long private TMPDIR on macOS.
  dir = mkdtempSync(join(realpathSync(tmpdir()), "il-"));
  home = join(dir, "home");
  root = join(dir, "r");
  cwd = join(dir, "work");
  mkdirSync(home);
  mkdirSync(cwd);
  mkdirSync(join(dir, "tmp"));
  requests = [];
  closers = [];
});

afterEachClosed(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  return () => {
    rmSync(dir, { recursive: true, force: true });
  };
});

function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const temporary = join(dir, "tmp");
  return {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    PATH: [
      dirname(process.execPath),
      ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"]),
    ].join(delimiter),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    CLAUDEXOR_CONFIG_DIR: root,
    CLAUDEXOR_DAEMON_ENTRY: join(dir, "never-start.js"),
    ...extra,
  };
}

/** Evaluate an engine path helper against the fixture root. */
function inFixtureRoot<T>(read: () => T): T {
  vi.stubEnv("CLAUDEXOR_CONFIG_DIR", root);
  try {
    return read();
  } finally {
    vi.unstubAllEnvs();
  }
}

function inspect(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "inspect", ...args], {
      cwd,
      env: childEnv(extraEnv),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.once("error", reject);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      const result = { status, signal, stdout, stderr };
      if (CAPTURE_DIR) {
        mkdirSync(CAPTURE_DIR, { recursive: true });
        const name = (expect.getState().currentTestName ?? "test").replace(/[^A-Za-z0-9]+/g, "-");
        writeFileSync(
          join(CAPTURE_DIR, `${String(++captured).padStart(2, "0")}-${name}.json`),
          JSON.stringify({ args: ["inspect", ...args], extraEnv, ...result }, null, 2) + "\n",
          { flag: "wx" },
        );
      }
      resolve(result);
    });
  });
}

/** Materialize a run tree under `project`'s runtime namespace in the fixture root. */
function materializeRun(project: string, runId: string, summary = true): string {
  const paths = inFixtureRoot(() => new ArtifactStore(project).createRun(runId));
  if (summary) writeFileSync(join(paths.finalDir, "summary.md"), `summary of ${runId}\n`);
  return paths.root;
}

function otherProject(): string {
  const other = join(dir, "other-project");
  mkdirSync(other, { recursive: true });
  return other;
}

async function startDaemonSocket(): Promise<void> {
  mkdirSync(join(root, "daemon"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "daemon", "token"), `${TOKEN}\n`, { mode: 0o600 });
  const socket = createNetServer((connection) => {
    const lines = createInterface({ input: connection });
    lines.on("line", (line) => {
      const { id } = JSON.parse(line) as { id: number };
      connection.write(JSON.stringify({ id, result: { ok: true } }) + "\n");
    });
    connection.on("error", () => undefined);
    connection.on("close", () => lines.close());
  });
  await new Promise<void>((done, fail) => {
    socket.once("error", fail);
    socket.listen(
      inFixtureRoot(() => canonicalDefaultSocketPath()),
      done,
    );
  });
  closers.push(() => new Promise<void>((done) => socket.close(() => done())));
}

function writePointer(port: number): void {
  writeFileSync(
    join(root, "daemon", "control-api.json"),
    JSON.stringify({ host: "127.0.0.1", port }),
  );
}

/** The real control API over a synthetic run registry. */
async function startRealDaemon(
  records: DaemonRunRecord[],
  servingMode: "normal" | "recovery_only" = "normal",
  storeId?: () => string | undefined,
): Promise<void> {
  await startDaemonSocket();
  const find = (id: string) => records.filter((r) => r.id === id || r.runId === id);
  const daemon: DaemonFacadeClient = {
    enqueue: async () => {
      throw new Error("fixture daemon accepts no work");
    },
    status: async (id) => {
      const [record] = find(id);
      if (!record) throw Object.assign(new Error("no such run"), { status: 404 });
      return record;
    },
    list: async (query) => {
      const id = (query as { id?: unknown }).id;
      requests.push(`list ${typeof id === "string" ? id : JSON.stringify(query)}`);
      return typeof id === "string" ? find(id) : [];
    },
    cancel: async () => {
      throw new Error("fixture daemon cancels nothing");
    },
  };
  const server = new DaemonControlApiServer({
    token: TOKEN,
    pollMs: 1,
    daemon,
    servingMode: () => servingMode,
    ...(storeId ? { storeId } : {}),
  });
  const { port } = await server.start();
  closers.push(() => server.stop());
  writePointer(port);
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function problem(code: string, message: string, retryable: boolean, extra = {}) {
  return {
    code,
    message,
    retryable,
    fieldErrors: {},
    requiredActions: [],
    evidenceRefs: [],
    context: {},
    ...extra,
  };
}

const acceptHandshake: Route = (_req, res) =>
  send(res, 200, {
    protocolMajor: CONTROL_PROTOCOL_MAJOR,
    compatible: true,
    operationsPath: "/v2/operations",
    engine: { version: CLAUDEXOR_VERSION, sha: "unknown", entry: "/fixture/claudexord.js" },
    servingMode: "normal",
  });

/** A raw HTTP daemon stub: health and handshake, then `route` for product calls. */
async function startStubDaemon(route: Route, handshake: Route = acceptHandshake): Promise<void> {
  await startDaemonSocket();
  const http = createHttpServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === "/healthz") return send(res, 200, { ok: true });
    if (req.url === "/v2/handshake") return handshake(req, res);
    return route(req, res);
  });
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  closers.push(
    () =>
      new Promise<void>((done) => {
        http.closeAllConnections();
        http.close(() => done());
      }),
  );
  writePointer((http.address() as AddressInfo).port);
}

const neverRouted: Route = (_req, res) =>
  send(res, 500, problem("fixture_unexpected", "fixture route must not be reached", false));

/** A minimal schema-valid run detail answer from the stub. */
function detailRoute(summary: Record<string, unknown>): Route {
  return (_req, res) => send(res, 200, { summary });
}

function failure(runId: string, exitCode: number, message: string, rest: object = {}) {
  return { runId, ok: false, exitCode, ...rest, message, error: message };
}

function expectNoDaemonStarted(): void {
  const entries = existsSync(join(root, "daemon")) ? readdirSync(join(root, "daemon")) : [];
  expect(
    entries.filter((name) => !["token", "claudexord.sock", "control-api.json"].includes(name)),
  ).toEqual([]);
}

describe("claudexor inspect lookup outcomes (built CLI, #235)", () => {
  it("rejects a malformed run id as a usage error before any store or daemon read", async () => {
    await startStubDaemon(neverRouted);
    const result = await inspect(["bad/id", "--json"]);
    const message =
      "invalid run id 'bad/id': a run id is a single path segment ([A-Za-z0-9._-], no separators)";
    expect(result).toMatchObject({ status: 2, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual(
      failure("bad/id", 2, message, {
        code: "invalid_argument",
        fieldErrors: { runId: ["must be a single path segment ([A-Za-z0-9._-], no separators)"] },
      }),
    );
    expect(requests).toEqual([]);
  });

  it("reads a local run while no daemon is reachable and never starts one", async () => {
    const runDir = materializeRun(cwd, "run-local");
    const result = await inspect(["run-local", "--json"]);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ runId: "run-local", runDir });
    expect(existsSync(join(root, "daemon"))).toBe(false);
  });

  it("does not describe a found run without output as possibly absent", async () => {
    const runDir = materializeRun(cwd, "run-early", false);
    const result = await inspect(["run-early"]);
    expect(result).toMatchObject({ status: 1, stderr: "" });
    expect(result.stdout.split("\n")).toEqual([
      `run run-early @ ${runDir}`,
      "output: finalizing",
      "(no summary or primary output in the run directory)",
      "",
    ]);
  });

  it("answers a local hit without consulting a reachable daemon", async () => {
    await startStubDaemon(neverRouted);
    const runDir = materializeRun(cwd, "run-local");
    const result = await inspect(["run-local", "--json"]);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ runId: "run-local", runDir });
    expect(requests).toEqual([]);
  });

  it("does not call a run absent when no daemon is reachable to check other projects", async () => {
    const message =
      "run run-elsewhere is not in the local run stores, and no Claudexor daemon is reachable to look up runs from other projects";
    const json = await inspect(["run-elsewhere", "--json"]);
    expect(json).toMatchObject({ status: 1, stderr: "" });
    expect(JSON.parse(json.stdout)).toEqual(
      failure("run-elsewhere", 1, message, {
        code: "daemon_unavailable",
        retryable: true,
        requiredActions: [START_REMEDY],
      }),
    );
    const human = await inspect(["run-elsewhere"]);
    expect(human).toEqual({ status: 1, signal: null, stdout: "", stderr: `${message}\n` });
    expect(existsSync(join(root, "daemon"))).toBe(false);
  });

  it("names the managed-daemon remedy when an externally owned daemon is unavailable", async () => {
    const result = await inspect(["run-elsewhere", "--json"], {
      CLAUDEXOR_DAEMON_OWNER: "external",
    });
    expect(result).toMatchObject({ status: 1, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual(
      failure(
        "run-elsewhere",
        1,
        "run run-elsewhere is not in the local run stores, and the managed Claudexor daemon is unavailable to look up runs from other projects",
        {
          code: "daemon_unavailable",
          retryable: true,
          requiredActions: [
            "the owning application must restore its managed daemon; this integration only attaches",
          ],
        },
      ),
    );
    expect(existsSync(join(root, "daemon"))).toBe(false);
  });

  it("says no such run only when the running daemon answers 404", async () => {
    await startRealDaemon([]);
    const json = await inspect(["run-missing", "--json"]);
    expect(json).toMatchObject({ status: 1, stderr: "" });
    expect(JSON.parse(json.stdout)).toEqual(
      failure("run-missing", 1, "no such run run-missing", {
        code: "run_not_found",
        retryable: false,
      }),
    );
    const human = await inspect(["run-missing"]);
    expect(human).toEqual({
      status: 1,
      signal: null,
      stdout: "",
      stderr: "no such run run-missing\n",
    });
    expect(requests).toEqual(["list run-missing", "list run-missing"]);
    expectNoDaemonStarted();
  });

  it("names the store that answered, so a saved receipt can tell another store from absence", async () => {
    const store = "22222222-2222-4222-8222-222222222222";
    await startRealDaemon([], "normal", () => store);
    const message = `no such run run-missing in engine store ${store}`;
    const json = await inspect(["run-missing", "--json"]);
    expect(json).toMatchObject({ status: 1, stderr: "" });
    expect(JSON.parse(json.stdout)).toEqual(
      failure("run-missing", 1, message, {
        code: "run_not_found",
        retryable: false,
        context: { storeId: store },
      }),
    );
    expect(await inspect(["run-missing"])).toEqual({
      status: 1,
      signal: null,
      stdout: "",
      stderr: `${message}\n`,
    });
  });

  it("claims no store when the daemon names none, or names an invalid one", async () => {
    const bodies: Record<string, object> = {
      "run-unnamed": {},
      "run-empty": { context: { storeId: "" } },
      "run-number": { context: { storeId: 42 } },
    };
    await startStubDaemon((req, res) =>
      send(
        res,
        404,
        problem("http_404", "no such run", false, bodies[String(req.url).split("/").pop()!]),
        "application/problem+json",
      ),
    );
    for (const name of Object.keys(bodies)) {
      const answer = await inspect([name, "--json"]);
      expect(answer, name).toMatchObject({ status: 1, stderr: "" });
      expect(JSON.parse(answer.stdout), name).toEqual(
        failure(name, 1, `no such run ${name}`, { code: "run_not_found", retryable: false }),
      );
    }
  });

  it("inspects another project's run through the daemon by run id and by job id", async () => {
    const runDir = materializeRun(otherProject(), "run-other");
    await startRealDaemon([{ id: "job-other", state: "running", runId: "run-other", runDir }]);
    for (const id of ["run-other", "job-other"]) {
      const result = await inspect([id, "--json"]);
      expect(result, id).toMatchObject({ status: 0, stderr: "" });
      expect(JSON.parse(result.stdout), id).toMatchObject({ runId: "run-other", runDir });
    }
    expectNoDaemonStarted();
  });

  it("explains a run the daemon knows that has no run directory yet", async () => {
    await startRealDaemon([{ id: "job-queued", state: "queued" }]);
    const result = await inspect(["job-queued", "--json"]);
    expect(result).toMatchObject({ status: 1, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual(
      failure(
        "job-queued",
        1,
        "run job-queued is known to the daemon (state queued) but has no run directory yet",
        { code: "run_not_materialized", retryable: true, context: { state: "queued" } },
      ),
    );
  });

  it("names the missing directory of a run the daemon knows", async () => {
    const runDir = join(root, "projects", "f".repeat(64), "runs", "run-gone");
    await startRealDaemon([{ id: "job-gone", state: "running", runId: "run-gone", runDir }]);
    const result = await inspect(["run-gone", "--json"]);
    expect(result).toMatchObject({ status: 1, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual(
      failure(
        "run-gone",
        1,
        `run run-gone is known to the daemon (state running) but its run directory ${runDir} is missing`,
        {
          code: "run_artifacts_unavailable",
          retryable: false,
          context: { state: "running", runDir, reason: "missing" },
        },
      ),
    );
  });

  // chmod cannot remove read access on Windows, and root ignores mode bits.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "names an unreadable directory of a run the daemon knows (POSIX permission bits)",
    async () => {
      const runDir = materializeRun(otherProject(), "run-locked");
      await startStubDaemon(
        detailRoute({ jobId: "job-locked", runId: "run-locked", state: "running", runDir }),
      );
      chmodSync(runDir, 0o000);
      closers.push(() => chmodSync(runDir, 0o700));
      const result = await inspect(["run-locked", "--json"]);
      expect(result).toMatchObject({ status: 1, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual(
        failure(
          "run-locked",
          1,
          `run run-locked is known to the daemon (state running) but its run directory ${runDir} is not accessible (EACCES)`,
          {
            code: "run_artifacts_unavailable",
            retryable: false,
            context: { state: "running", runDir, reason: "not_accessible" },
          },
        ),
      );
    },
  );

  it("keeps a daemon problem response typed (recovery-only daemon)", async () => {
    await startRealDaemon([], "recovery_only");
    const result = await inspect(["run-x", "--json"]);
    expect(result).toMatchObject({ status: 1, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual(
      failure(
        "run-x",
        1,
        "daemon is serving recovery only; product routes are closed until journal recovery completes",
        {
          code: "daemon_recovery_only",
          retryable: true,
          requiredActions: ["retry after recovery completes"],
        },
      ),
    );
    expect(requests).toEqual([]);
  });

  it("keeps route-level 401 and 426 refusals typed", async () => {
    await startStubDaemon((req, res) =>
      req.url === "/v2/runs/run-auth"
        ? send(res, 401, problem("http_401", "unauthorized", false), "application/problem+json")
        : send(
            res,
            426,
            problem(
              "handshake_required",
              "a successful v2 handshake is required before product calls",
              false,
              { requiredActions: ["POST /v2/handshake"] },
            ),
            "application/problem+json",
          ),
    );
    const auth = await inspect(["run-auth", "--json"]);
    expect(auth).toMatchObject({ status: 1, stderr: "" });
    expect(JSON.parse(auth.stdout)).toEqual(
      failure("run-auth", 1, "unauthorized", { code: "http_401", retryable: false }),
    );
    const protocol = await inspect(["run-protocol", "--json"]);
    expect(protocol).toMatchObject({ status: 1, stderr: "" });
    expect(JSON.parse(protocol.stdout)).toEqual(
      failure("run-protocol", 1, "a successful v2 handshake is required before product calls", {
        code: "handshake_required",
        retryable: false,
        requiredActions: ["POST /v2/handshake"],
      }),
    );
  });

  it("keeps handshake 401 and 426 refusals typed without starting a daemon (#93)", async () => {
    await startStubDaemon(neverRouted, (_req, res) =>
      send(res, 401, problem("http_401", "unauthorized", false), "application/problem+json"),
    );
    const auth = await inspect(["run-x", "--json"]);
    expect(auth).toMatchObject({ status: 1, stderr: "" });
    expect(JSON.parse(auth.stdout)).toEqual(
      failure("run-x", 1, "unauthorized", { code: "http_401", retryable: false }),
    );
    for (const close of closers.splice(0).reverse()) await close();
    await startStubDaemon(neverRouted, (_req, res) =>
      send(
        res,
        426,
        problem("incompatible_protocol_major", "control protocol major 3 is incompatible", false),
        "application/problem+json",
      ),
    );
    const protocol = await inspect(["run-x", "--json"]);
    expect(protocol.status).toBe(1);
    expect(protocol.stderr).toMatch(/^claudexor: the daemon refused the control API handshake/);
    expect(JSON.parse(protocol.stdout)).toMatchObject({
      runId: "run-x",
      ok: false,
      exitCode: 1,
      code: "incompatible_protocol_major",
      message: "control protocol major 3 is incompatible",
    });
    expect(requests.some((line) => line.startsWith("GET /v2/runs/"))).toBe(false);
    expectNoDaemonStarted();
  });

  it("keeps a 404 that is not the run registry's verdict typed", async () => {
    await startStubDaemon((req, res) =>
      req.url === "/v2/runs/run-route"
        ? send(
            res,
            404,
            problem("route_not_found", "product routes require the /v2 prefix", false),
            "application/problem+json",
          )
        : send(res, 404, "<html>not found</html>", "text/html"),
    );
    const route = await inspect(["run-route", "--json"]);
    expect(route).toMatchObject({ status: 1, stderr: "" });
    expect(JSON.parse(route.stdout)).toEqual(
      failure("run-route", 1, "product routes require the /v2 prefix", {
        code: "route_not_found",
        retryable: false,
      }),
    );
    const foreign = await inspect(["run-foreign", "--json"]);
    expect(foreign).toMatchObject({ status: 1, stderr: "" });
    expect(JSON.parse(foreign.stdout)).toEqual(
      failure("run-foreign", 1, "run lookup failed (HTTP 404)"),
    );
  });

  it("tolerates additive same-major fields the lookup does not use", async () => {
    const runDir = materializeRun(otherProject(), "run-future");
    await startStubDaemon((_req, res) =>
      send(res, 200, {
        summary: {
          jobId: "job-future",
          runId: "run-future",
          state: "running",
          runDir,
          futureSummaryField: true,
        },
        attemptExecution: [{ attemptId: "attempt-1", harnessId: "fake", futureEntryField: true }],
        futureRootField: { retained: true },
      }),
    );
    const result = await inspect(["run-future", "--json"]);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ runId: "run-future", runDir });
  });

  it("keeps the recovery metadata of a known problem that carries additive fields", async () => {
    await startStubDaemon((req, res) =>
      req.url === "/v2/runs/run-recovering"
        ? send(
            res,
            503,
            problem("daemon_recovery_only", "fixture recovery", true, {
              fieldErrors: { fixture: ["fixture issue"] },
              requiredActions: ["retry after recovery"],
              evidenceRefs: ["fixture-evidence"],
              context: { state: "recovering" },
              futureProblemField: true,
            }),
            "application/problem+json",
          )
        : send(
            res,
            404,
            problem("http_404", "no such run", false, { futureProblemField: true }),
            "application/problem+json",
          ),
    );
    const recovering = await inspect(["run-recovering", "--json"]);
    expect(recovering).toMatchObject({ status: 1, stderr: "" });
    expect(JSON.parse(recovering.stdout)).toEqual(
      failure("run-recovering", 1, "fixture recovery", {
        code: "daemon_recovery_only",
        retryable: true,
        fieldErrors: { fixture: ["fixture issue"] },
        requiredActions: ["retry after recovery"],
        details: { evidenceRefs: ["fixture-evidence"] },
        context: { state: "recovering" },
      }),
    );
    const absent = await inspect(["run-absent", "--json"]);
    expect(absent).toMatchObject({ status: 1, stderr: "" });
    expect(JSON.parse(absent.stdout)).toEqual(
      failure("run-absent", 1, "no such run run-absent", {
        code: "run_not_found",
        retryable: false,
      }),
    );
  });

  it("reads the run directory the daemon recorded, verbatim", async () => {
    const runDir = materializeRun(otherProject(), "run-tree");
    await startStubDaemon(
      detailRoute({ jobId: "job-tree", runId: "run-alias", state: "running", runDir }),
    );
    const result = await inspect(["run-alias", "--json"]);
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ runId: "run-tree", runDir });
  });

  it("refuses a recorded run directory that is relative or outside a run store", async () => {
    const outside = join(dir, "not-a-run-store", "run-odd");
    mkdirSync(outside, { recursive: true });
    const relative = join("runs", "run-rel");
    await startStubDaemon((req, res) =>
      detailRoute(
        req.url === "/v2/runs/run-odd"
          ? { jobId: "job-odd", runId: "run-odd", state: "running", runDir: outside }
          : { jobId: "job-rel", runId: "run-rel", state: "running", runDir: relative },
      )(req, res),
    );
    for (const [id, runDir] of [
      ["run-odd", outside],
      ["run-rel", relative],
    ] as const) {
      const result = await inspect([id, "--json"]);
      expect(result, id).toMatchObject({ status: 1, stderr: "" });
      expect(JSON.parse(result.stdout), id).toEqual(
        failure(
          id,
          1,
          `run ${id} is known to the daemon (state running) but its recorded run directory ${runDir} is not a run store directory`,
          {
            code: "invalid_service_response",
            retryable: false,
            context: { state: "running", runDir },
          },
        ),
      );
    }
  });

  it("reports malformed and schema-invalid run detail as an invalid service response", async () => {
    await startStubDaemon((req, res) =>
      req.url === "/v2/runs/run-garbled"
        ? send(res, 200, "{not json")
        : send(res, 200, { summary: { runDir: "/elsewhere" } }),
    );
    const garbled = await inspect(["run-garbled", "--json"]);
    expect(garbled).toMatchObject({ status: 1, stderr: "" });
    expect(JSON.parse(garbled.stdout)).toEqual(
      failure("run-garbled", 1, "run detail endpoint returned malformed JSON", {
        code: "invalid_service_response",
        retryable: true,
      }),
    );
    const invalid = await inspect(["run-invalid", "--json"]);
    expect(invalid).toMatchObject({ status: 1, stderr: "" });
    expect(JSON.parse(invalid.stdout)).toEqual(
      failure("run-invalid", 1, "run detail endpoint returned an invalid response", {
        code: "invalid_service_response",
        retryable: true,
      }),
    );
  });

  it("reports a dropped daemon connection as an incomplete lookup, before or after the headers", async () => {
    await startStubDaemon((req, res) => {
      if (req.url === "/v2/runs/run-x") return req.socket.destroy();
      // An answer whose body is cut: the headers and a partial body are flushed first.
      const status = req.url === "/v2/runs/run-body-lost" ? 200 : 503;
      res.writeHead(status, { "content-type": "application/json", "content-length": "100000" });
      res.write(status === 200 ? '{"summary":' : '{"code":', () => res.destroy());
    });
    for (const id of ["run-x", "run-body-lost", "run-error-body-lost"]) {
      const result = await inspect([id, "--json"]);
      expect(result, id).toMatchObject({ status: 1, stderr: "" });
      const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(envelope, id).toMatchObject({
        runId: id,
        ok: false,
        exitCode: 1,
        code: "daemon_unavailable",
        retryable: true,
      });
      expect(envelope["message"], id).toMatch(
        new RegExp(
          `^the Claudexor daemon connection failed while looking up run ${id}( \\([^)]+\\))?; retry the lookup$`,
        ),
      );
    }
    expect(requests).toEqual(
      expect.arrayContaining([
        "GET /v2/runs/run-x",
        "GET /v2/runs/run-body-lost",
        "GET /v2/runs/run-error-body-lost",
      ]),
    );
  });
});
