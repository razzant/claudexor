/**
 * `summary.processScope` of `GET /v2/runs/:id` (INV-144): the presence/null
 * contract, end to end.
 *
 * `final/process_scope.yaml` is best-effort evidence. The run-scope barrier
 * settles the scope, ATTEMPTS to record the outcome, and only then publishes the
 * terminal, so a record that could not be written never changes the verdict or
 * the answer. The API therefore has to say what it knows and no more:
 *   - the property is always present (an own property, never omitted);
 *   - it is the compact object only for a terminal run with a readable, valid
 *     record, and JSON `null` otherwise;
 *   - `null` means UNKNOWN (no record, an unreadable one, an invalid one),
 *     never "clean".
 *
 * Producer and projection are the real ones: the Orchestrator's barrier with its
 * `writeRunScopeFacts`, and an actual HTTP GET against `DaemonControlApiServer`.
 * Only the model (a synthetic adapter answering a PASS or FAIL verdict) and the
 * process census (an injected custodian outcome) are synthetic. Failures are
 * provoked through the custodian seam inside the run's own private run
 * directory: a directory squatting on the record path makes the real YAML write
 * fail with EISDIR, and an outcome the schema rejects makes the real `toFacts`
 * parse throw.
 *
 * A consumer that must tell an absent key from `null` can replay the exact
 * bytes: with CLAUDEXOR_TEST_CAPTURE_DETAIL_DIR set to a new or empty absolute
 * path, the engine home, the project and every raw GET body of this file are
 * kept there unmodified (`detail/*.json`; each `summary.runDir` stays
 * resolvable). Captured evidence is never overwritten.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "@claudexor/artifact-store";
import {
  DaemonControlApiServer,
  type DaemonFacadeClient,
  type DaemonRunRecord,
} from "@claudexor/control-api";
import {
  mintRunScopeMarker,
  runCapture,
  type HarnessAdapter,
  type ScopeReapOutcome,
} from "@claudexor/core";
import {
  Orchestrator,
  type OrchestratorResult,
  type RunScopeCustodian,
} from "@claudexor/orchestrator";
import {
  CONTROL_PROTOCOL_MAJOR,
  ConformanceReport,
  HarnessManifest,
  RunProcessScopeOutcome,
} from "@claudexor/schema";
import { projectRuntimeDir } from "@claudexor/util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TOKEN = "run-process-scope-detail-token";
const CAPTURE_DIR = process.env["CLAUDEXOR_TEST_CAPTURE_DETAIL_DIR"];
/**
 * The id a consumer routes review sessions to. The adapter behind it is a
 * fixture: it proves nothing about the vendor CLI.
 */
const HARNESS_ID = "codex";
const PROMPT = "Judge the change against its acceptance criteria and answer with the verdict.";

/** The structured verdict a review consumer parses out of `primaryOutput.text`. */
const VERDICTS = {
  PASS: { verdict: "PASS", findings: [], summary: "Every acceptance criterion holds." },
  FAIL: {
    verdict: "FAIL",
    findings: [
      {
        severity: "critical",
        item: "criterion 2",
        evidence: "The synthetic fixture reports a violated criterion.",
        recommendation: "Repair the change and ask again.",
      },
    ],
    summary: "One acceptance criterion is violated.",
  },
} as const;
type Verdict = keyof typeof VERDICTS;

/** The object contract a review consumer asks for, so the engine itself vouches for the answer's shape. */
const VERDICT_SCHEMA = {
  type: "object",
  required: ["verdict", "findings", "summary"],
  properties: {
    verdict: { type: "string", enum: ["PASS", "FAIL", "DEGRADED"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "item", "evidence", "recommendation"],
        properties: {
          severity: { type: "string" },
          item: { type: "string" },
          evidence: { type: "string" },
          recommendation: { type: "string" },
        },
      },
    },
    summary: { type: "string" },
  },
};

let base = "";
let repo = "";
let engineHome: string | undefined;

beforeAll(async () => {
  if (CAPTURE_DIR && existsSync(CAPTURE_DIR) && readdirSync(CAPTURE_DIR).length > 0) {
    throw new Error("CLAUDEXOR_TEST_CAPTURE_DETAIL_DIR must be new or empty: captures are kept");
  }
  base = CAPTURE_DIR ?? mkdtempSync(join(tmpdir(), "claudexor-scope-detail-"));
  repo = join(base, "project");
  mkdirSync(repo, { recursive: true });
  if (CAPTURE_DIR) engineHome = join(CAPTURE_DIR, "engine-home");
  await runCapture("git", ["-C", repo, "init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# project\n");
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
});

// The suite-wide setup restores the sandbox config dir after every test, so a
// retained engine home has to be re-selected before each one.
beforeEach(() => {
  if (engineHome) process.env.CLAUDEXOR_CONFIG_DIR = engineHome;
});

afterAll(() => {
  if (!CAPTURE_DIR) rmSync(base, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

/** A read-only synthetic adapter whose entire final answer is the verdict JSON. */
function verdictAdapter(verdict: Verdict, trace: string[]): HarnessAdapter {
  return {
    id: HARNESS_ID,
    async discover() {
      return HarnessManifest.parse({
        id: HARNESS_ID,
        display_name:
          "SYNTHETIC verdict fixture registered under the codex id (not the vendor CLI)",
        kind: "local_cli",
        provider_family: "local",
        capabilities: { plan: true, read_files: true, json_schema_output: true },
        access_profiles_supported: ["readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: HARNESS_ID,
        status: "ok",
        enabled_intents: ["explain"],
      });
    },
    async *run(spec) {
      trace.push("launch");
      const base = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield {
        ...base,
        type: "started",
        observed_model: "synthetic-verdict-model",
        credential_route: "vendor_native",
      };
      yield { ...base, type: "message", text: JSON.stringify(VERDICTS[verdict]), final: true };
      yield { ...base, type: "completed" };
    },
  };
}

/** What the census found: a clean, provably empty scope. */
const SETTLED: ScopeReapOutcome = {
  coverage: "marker",
  census: "ok",
  censusFailure: null,
  ended: [],
  survivors: [],
  unreadable: [],
  reusedGroups: [],
  settled: true,
  incomplete: false,
  completeness: "complete",
  completenessReason: null,
  restricted: false,
  durationMs: 0,
};

interface Scenario {
  /** The census outcome the custodian reports. */
  outcome: ScopeReapOutcome;
  /** Runs inside the settlement, with the run's private `final/` directory. */
  intervene?: (finalDir: string) => void;
}

const RECORDED: Scenario = { outcome: SETTLED };
/** A member survived the bounded ladder: known to be unclean, which is not the same as unknown. */
const SURVIVORS: Scenario = {
  outcome: {
    ...SETTLED,
    settled: false,
    survivors: [{ pid: 4242, startToken: "ps:Mon Oct 12 14:00:01 2026" }],
    completeness: "not_provable",
    completenessReason: "a member outlived the bounded ladder",
  },
};
/** A directory squats on the record path: the real YAML write fails with EISDIR. */
const WRITE_FAILS: Scenario = {
  outcome: SETTLED,
  intervene: (finalDir) => mkdirSync(join(finalDir, "process_scope.yaml")),
};
/** An outcome the schema rejects (a pid is positive): the real `toFacts` parse throws. */
const SCHEMA_FAILS: Scenario = {
  outcome: { ...SETTLED, survivors: [{ pid: 0, startToken: "ps:invalid" }] },
};

const TERMINAL_EVENTS = new Set(["run.completed", "run.failed", "run.blocked"]);

const runDirOf = (runId: string): string => join(projectRuntimeDir(repo), "runs", runId);

type ScopeArtifact = "absent" | "directory" | "valid" | "invalid";

function scopeArtifact(runDir: string): ScopeArtifact {
  const path = join(runDir, "final", "process_scope.yaml");
  if (!existsSync(path)) return "absent";
  if (lstatSync(path).isDirectory()) return "directory";
  const facts = new ArtifactStore(repo).readYaml(path);
  return RunProcessScopeOutcome.safeParse(facts).success ? "valid" : "invalid";
}

interface Produced {
  result: OrchestratorResult;
  /** open → launch → settle → terminal: the order the barrier kept. */
  trace: string[];
  /** The record artifact as it stood when the terminal was published. */
  atTerminal: ScopeArtifact | undefined;
}

async function produce(verdict: Verdict, scenario: Scenario): Promise<Produced> {
  const trace: string[] = [];
  let atTerminal: ScopeArtifact | undefined;
  const custodian: RunScopeCustodian = {
    async open() {
      trace.push("open");
      return { marker: mintRunScopeMarker() };
    },
    async settle(runId) {
      trace.push("settle");
      scenario.intervene?.(join(runDirOf(runId), "final"));
      return scenario.outcome;
    },
  };
  const result = await new Orchestrator({
    registry: new Map([[HARNESS_ID, verdictAdapter(verdict, trace)]]),
    runScopes: custodian,
    reviewers: [],
  }).run({
    repoRoot: repo,
    prompt: PROMPT,
    mode: "ask",
    harnesses: [HARNESS_ID],
    outputSchema: VERDICT_SCHEMA,
    onEvent: (event) => {
      if (!TERMINAL_EVENTS.has(event.type)) return;
      trace.push("terminal");
      atTerminal = scopeArtifact(runDirOf(event.run_id));
    },
  });
  return { result, trace, atTerminal };
}

/** The record the daemon would hold for this run; everything else is read from its run directory. */
function daemonRecord(result: OrchestratorResult): DaemonRunRecord {
  return {
    id: `job-${result.runId}`,
    runId: result.runId,
    taskId: result.taskId,
    state: result.lifecycle,
    runDir: result.runDir,
    params: {
      mode: "ask",
      prompt: PROMPT,
      scope: { kind: "project", root: repo },
      harnesses: [HARNESS_ID],
      n: 1,
    },
  };
}

interface Fetched {
  status: number;
  /** The response body exactly as received. */
  text: string;
  body: {
    summary: Record<string, unknown> & { runId: string; state: string };
    primaryOutput: { kind: string; path: string; text: string } | null;
    runs?: Array<Record<string, unknown>>;
  };
}

async function withApi(
  records: DaemonRunRecord[],
  fn: (get: (path: string, capture?: string) => Promise<Fetched>) => Promise<void>,
): Promise<void> {
  const daemon: DaemonFacadeClient = {
    async enqueue() {
      throw new Error("this fixture only reads runs");
    },
    async status(id) {
      const record = records.find((r) => r.id === id || r.runId === id);
      if (!record) throw new Error(`no such run: ${id}`);
      return record;
    },
    async list(query) {
      // An addressed read names its run; every other selection (the run list,
      // delegated children) is re-bounded by the server, so the whole set is a valid answer.
      if (!("id" in query)) return records;
      return records.filter((r) => r.id === query.id || r.runId === query.id);
    },
    async cancel() {
      return { ok: true };
    },
  };
  const server = new DaemonControlApiServer({ token: TOKEN, pollMs: 1, daemon });
  const { host, port } = await server.start();
  try {
    await fn(async (path, capture) => {
      const response = await fetch(`http://${host}:${port}/v2${path}`, {
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "X-Claudexor-Protocol-Major": String(CONTROL_PROTOCOL_MAJOR),
        },
      });
      const raw = Buffer.from(await response.arrayBuffer());
      if (CAPTURE_DIR && capture) {
        mkdirSync(join(CAPTURE_DIR, "detail"), { recursive: true });
        writeFileSync(join(CAPTURE_DIR, "detail", `${capture}.json`), raw);
      }
      const text = raw.toString("utf8");
      return { status: response.status, text, body: JSON.parse(text) };
    });
  } finally {
    await server.stop();
  }
}

/** The run succeeded and its answer is the verdict the adapter gave, whatever became of the record. */
function expectUnchangedVerdict(fetched: Fetched, produced: Produced, verdict: Verdict): void {
  expect(produced.result.lifecycle).toBe("succeeded");
  expect(fetched.status).toBe(200);
  expect(fetched.body.summary).toMatchObject({
    runId: produced.result.runId,
    state: "succeeded",
    outputConformance: "passed",
  });
  expect(fetched.body.primaryOutput).toMatchObject({
    kind: "structured_output",
    path: "final/output.json",
  });
  expect(JSON.parse(fetched.body.primaryOutput?.text ?? "")).toEqual(VERDICTS[verdict]);
}

/** `processScope` is an own property of the summary, written once, as `expected`. */
function expectProcessScope(fetched: Fetched, expected: Record<string, unknown> | null): void {
  expect(Object.hasOwn(fetched.body.summary, "processScope")).toBe(true);
  expect(fetched.body.summary["processScope"]).toEqual(expected);
  expect(fetched.text.match(/"processScope"/g)).toHaveLength(1);
  expect(fetched.text).toContain(expected === null ? '"processScope":null' : '"processScope":{');
}

const COMPACT_SETTLED = {
  settled: true,
  coverage: "marker",
  completeness: "complete",
  census: "ok",
  survivors: 0,
  unreadable: 0,
};
const COMPACT_SURVIVORS = {
  settled: false,
  coverage: "marker",
  completeness: "not_provable",
  census: "ok",
  survivors: 1,
  unreadable: 0,
};

describe("GET /v2/runs/:id summary.processScope (INV-144)", () => {
  describe.each(["PASS", "FAIL"] as const)("a run answering %s", (verdict) => {
    const name = verdict.toLowerCase();

    it("serves the compact record the barrier wrote before the terminal, beside the unchanged answer", async () => {
      const produced = await produce(verdict, RECORDED);
      expect(produced.trace).toEqual(["open", "launch", "settle", "terminal"]);
      expect(produced.atTerminal).toBe("valid");
      await withApi([daemonRecord(produced.result)], async (get) => {
        const fetched = await get(`/runs/${produced.result.runId}`, `${name}.recorded`);
        expectUnchangedVerdict(fetched, produced, verdict);
        expectProcessScope(fetched, COMPACT_SETTLED);
      });
    });

    it("counts survivors in an object, never as null, and still leaves the verdict and the answer alone", async () => {
      const produced = await produce(verdict, SURVIVORS);
      expect(produced.trace).toEqual(["open", "launch", "settle", "terminal"]);
      expect(produced.atTerminal).toBe("valid");
      await withApi([daemonRecord(produced.result)], async (get) => {
        const fetched = await get(`/runs/${produced.result.runId}`, `${name}.survivors`);
        expectUnchangedVerdict(fetched, produced, verdict);
        expectProcessScope(fetched, COMPACT_SURVIVORS);
      });
    });

    it("keeps the verdict and the answer when the record's YAML write fails, and reports null", async () => {
      const produced = await produce(verdict, WRITE_FAILS);
      // The settlement ran, the real write hit the directory and failed, and
      // the terminal was published all the same.
      expect(produced.trace).toEqual(["open", "launch", "settle", "terminal"]);
      expect(produced.atTerminal).toBe("directory");
      await withApi([daemonRecord(produced.result)], async (get) => {
        const fetched = await get(`/runs/${produced.result.runId}`, `${name}.write-failed`);
        expectUnchangedVerdict(fetched, produced, verdict);
        expectProcessScope(fetched, null);
      });
    });

    it("keeps the verdict and the answer when the outcome fails the schema, and reports null", async () => {
      const produced = await produce(verdict, SCHEMA_FAILS);
      expect(produced.trace).toEqual(["open", "launch", "settle", "terminal"]);
      expect(produced.atTerminal).toBe("absent");
      await withApi([daemonRecord(produced.result)], async (get) => {
        const fetched = await get(`/runs/${produced.result.runId}`, `${name}.schema-failed`);
        expectUnchangedVerdict(fetched, produced, verdict);
        expectProcessScope(fetched, null);
      });
    });
  });

  it("reads a truncated or invalid record as null, never as a guess", async () => {
    const produced = await produce("PASS", RECORDED);
    const path = join(produced.result.runDir, "final", "process_scope.yaml");
    const written = readFileSync(path, "utf8");
    expect(written).toContain("coverage: marker");
    await withApi([daemonRecord(produced.result)], async (get) => {
      const detail = `/runs/${produced.result.runId}`;
      expectProcessScope(await get(detail), COMPACT_SETTLED);

      writeFileSync(path, written.slice(0, Math.floor(written.length / 2)));
      const truncated = await get(detail, "pass.truncated");
      expectUnchangedVerdict(truncated, produced, "PASS");
      expectProcessScope(truncated, null);

      writeFileSync(path, written.replace("coverage: marker", "coverage: sideways"));
      const badEnum = await get(detail, "pass.bad-enum");
      expectUnchangedVerdict(badEnum, produced, "PASS");
      expectProcessScope(badEnum, null);

      // The projection is a function of the artifact alone: restoring it restores the object.
      writeFileSync(path, written);
      expectProcessScope(await get(detail), COMPACT_SETTLED);
    });
  });

  it("leaves the record to the detail: a run list row says so with an explicit null", async () => {
    const produced = await produce("PASS", RECORDED);
    await withApi([daemonRecord(produced.result)], async (get) => {
      const list = await get("/runs", "pass.list");
      expect(list.status).toBe(200);
      expect(list.body.runs).toHaveLength(1);
      const [row] = list.body.runs ?? [];
      expect(row).toMatchObject({ runId: produced.result.runId, state: "succeeded" });
      expect(Object.hasOwn(row ?? {}, "processScope")).toBe(true);
      expect(row?.["processScope"]).toBeNull();
      // ... although the same run's detail carries the record it holds.
      expectProcessScope(await get(`/runs/${produced.result.runId}`), COMPACT_SETTLED);
    });
  });
});
