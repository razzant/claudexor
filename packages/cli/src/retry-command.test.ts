import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDaemon: vi.fn(),
  controlApiFetch: vi.fn(),
  print: vi.fn(),
  printJson: vi.fn(),
  printUsageError: vi.fn(() => 2),
}));

vi.mock("./daemon-run.js", () => ({ ensureDaemon: mocks.ensureDaemon }));
vi.mock("./live.js", () => ({ controlApiFetch: mocks.controlApiFetch }));
vi.mock("./cli-io.js", async () => {
  const real = await vi.importActual<typeof import("./cli-io.js")>("./cli-io.js");
  return {
    ...real,
    print: mocks.print,
    printJson: mocks.printJson,
    printUsageError: mocks.printUsageError,
  };
});

import { parseArgs } from "./args.js";
import { retryCommand, runAgainCommand } from "./retry-command.js";

/** The daemon re-projects every `>= 400` reply into a strict ControlProblem. */
function problem(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

describe("retryCommand surfaces a typed refusal's message, not just its status", () => {
  let stderrText = "";

  beforeEach(() => {
    vi.clearAllMocks();
    stderrText = "";
    mocks.ensureDaemon.mockResolvedValue({
      addr: { baseUrl: "http://127.0.0.1:1234", token: "test" },
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrText += String(chunk);
      return true;
    });
  });

  it("prints the pre-start refusal text in text mode instead of a bare HTTP 403", async () => {
    // Exactly what the control API answers when a replayed job dies before it
    // binds a run: the trust gate's typed 403. The actionable sentence rides in
    // `message`; there is no `error` key on the wire.
    mocks.controlApiFetch.mockResolvedValue(
      problem(403, {
        code: "trust_full_access_required",
        message: "full access is required for this project",
        retryable: false,
        fieldErrors: {},
        requiredActions: [],
        evidenceRefs: [],
        context: { jobId: "job-retry-refused", state: "failed", retryOf: "run-d1" },
      }),
    );

    expect(await retryCommand(parseArgs(["retry", "run-d1"]), false)).toBe(1);
    expect(stderrText).toContain("full access is required for this project");
    expect(stderrText).not.toContain("HTTP 403");
  });

  it("keeps the typed problem fields in the JSON envelope", async () => {
    mocks.controlApiFetch.mockResolvedValue(
      problem(403, {
        code: "trust_full_access_required",
        message: "full access is required for this project",
        retryable: false,
        fieldErrors: {},
        requiredActions: ["grant full access to this project"],
        evidenceRefs: [],
        context: { retryOf: "run-d1" },
      }),
    );

    expect(await retryCommand(parseArgs(["retry", "run-d1"]), true)).toBe(1);
    expect(mocks.printJson).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        code: "trust_full_access_required",
        message: "claudexor retry: full access is required for this project",
        // Legacy alias: consumers that read `error` off the CLI envelope keep working.
        error: "claudexor retry: full access is required for this project",
        retryable: false,
        requiredActions: ["grant full access to this project"],
        context: { retryOf: "run-d1" },
      }),
    );
  });

  it("still reads a legacy `error`-only body, so an old sender does not regress", async () => {
    mocks.controlApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "no such run" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );

    expect(await retryCommand(parseArgs(["retry", "run-gone"]), false)).toBe(1);
    expect(stderrText).toContain("no such run");
  });

  it("leaves an accepted retry reporting its handle", async () => {
    mocks.controlApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ state: "queued", jobId: "job-9" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );

    expect(await retryCommand(parseArgs(["retry", "run-d1"]), false)).toBe(0);
    expect(mocks.print).toHaveBeenCalledWith("retry run-d1: queued (job-9)");
  });

  it("run-again reports its refusal the same way", async () => {
    mocks.controlApiFetch.mockResolvedValue(
      problem(409, {
        code: "run_busy",
        message: "run is still running",
        retryable: true,
        fieldErrors: {},
        requiredActions: [],
        evidenceRefs: [],
        context: {},
      }),
    );

    expect(await runAgainCommand(parseArgs(["run-again", "run-d1"]), false)).toBe(1);
    expect(stderrText).toContain("run is still running");
    expect(stderrText).not.toContain("HTTP 409");
  });
});
