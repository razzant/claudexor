import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunWaitManyInput, RunWaitManyResult } from "@claudexor/schema";
import { parseArgs } from "./args.js";
import { runsWaitCommand } from "./runs-wait-command.js";
import { CLI_COMMANDS, CLI_FLAGS, VALUE_FLAGS } from "./command-registry.js";
import { RUN_FLAGS, RUN_FLAGS_BY_MODE } from "./command-flags.js";
import {
  commandFlagScopeError,
  commandPositionalError,
  runModeFlagScopeError,
} from "./command-scope.js";

const daemon = vi.hoisted(() => ({
  connectDaemonIfRunning: vi.fn(),
  ensureDaemon: vi.fn(),
  enqueueAndAwait: vi.fn(),
}));
vi.mock("./daemon-run.js", () => daemon);

const TOKEN = "A".repeat(43);
const targets = [{ runId: " job-a " }, { runId: "run-a", seen: TOKEN }, { runId: "job-a" }];
const body: RunWaitManyResult = {
  wakeReason: "attention",
  attention: [1],
  summaries: [
    { status: "queued", pending: false, token: TOKEN, problem: null },
    { status: "running", pending: true, token: TOKEN, problem: null },
    { status: "queued", pending: false, token: TOKEN, problem: null },
  ],
};

describe("runs-wait CLI consumer", () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  let stdout = "";
  let stderr = "";

  beforeEach(() => {
    vi.resetAllMocks();
    stdout = "";
    stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    vi.stubGlobal("fetch", fetch);
    daemon.connectDaemonIfRunning.mockResolvedValue({
      addr: {
        baseUrl: "http://wait-many.invalid",
        token: "fixture-token",
      },
    });
    fetch.mockResolvedValue(Response.json(body));
  });

  afterEach(() => {
    expect(daemon.ensureDaemon).not.toHaveBeenCalled();
    expect(daemon.enqueueAndAwait).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("prints only the compact contract in --json mode after one observer request", async () => {
    expect(
      await runsWaitCommand(
        parseArgs(["runs-wait", "--targets-json", JSON.stringify(targets), "--json"]),
        true,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout)).toEqual(body);
    expect(stderr).toBe("");
    expect(RunWaitManyResult.parse(JSON.parse(stdout))).toEqual(body);
    expect(daemon.connectDaemonIfRunning).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://wait-many.invalid/v2/runs/wait-many");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      targets: [{ runId: "job-a" }, { runId: "run-a", seen: TOKEN }, { runId: "job-a" }],
    });
  });

  it.each(["json", "json-stream"])(
    "admits exactly 1MiB without --wait-ms in --%s and rejects the next byte before discovery",
    async (format) => {
      let controls = 155_910;
      const targets = Array.from({ length: 1000 }, () => {
        const count = Math.min(256, controls);
        controls -= count;
        return { runId: "\u0001".repeat(count) + "x".repeat(256 - count) };
      });
      targets[999]!.runId = "€" + "é".repeat(11) + "x".repeat(244);
      const input = { targets };
      expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBe(1_048_576);
      const result: RunWaitManyResult = {
        wakeReason: "attention",
        attention: Array.from({ length: 1000 }, (_, i) => i),
        summaries: Array.from({ length: 1000 }, () => ({
          status: "interrupted",
          pending: false,
          token: TOKEN,
          problem: null,
        })),
      };
      fetch.mockResolvedValue(Response.json(result));
      expect(
        await runsWaitCommand(
          parseArgs(["runs-wait", "--targets-json", JSON.stringify(targets), `--${format}`]),
          format === "json",
        ),
      ).toBe(0);
      expect(JSON.parse(stdout)).toEqual(result);
      if (format === "json-stream") expect(stdout).toBe(`${JSON.stringify(result)}\n`);
      expect(stderr).toBe("");
      expect(daemon.connectDaemonIfRunning).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = fetch.mock.calls[0]!;
      expect(url).toBe("http://wait-many.invalid/v2/runs/wait-many");
      expect(init?.method).toBe("POST");
      const wire = String(init?.body);
      expect(Buffer.byteLength(wire, "utf8")).toBe(1_048_576);
      expect(JSON.parse(wire)).toEqual(input);
      expect(JSON.parse(wire)).not.toHaveProperty("waitMs");
      expect(RunWaitManyInput.parse(JSON.parse(wire)).waitMs).toBe(25_000);

      stdout = "";
      daemon.connectDaemonIfRunning.mockClear();
      fetch.mockClear();
      const overTargets = [
        ...targets.slice(0, 999),
        { runId: "€" + "é".repeat(12) + "x".repeat(243) },
      ];
      expect(Buffer.byteLength(JSON.stringify({ targets: overTargets }), "utf8")).toBe(1_048_577);
      expect(
        await runsWaitCommand(
          parseArgs(["runs-wait", "--targets-json", JSON.stringify(overTargets), `--${format}`]),
          format === "json",
        ),
      ).toBe(2);
      const failure = JSON.parse(stdout);
      expect(failure).toMatchObject({ ok: false, code: "invalid_argument", exitCode: 2 });
      if (format === "json-stream") expect(stdout).toBe(`${JSON.stringify(failure)}\n`);
      expect(stderr).toBe("");
      expect(daemon.connectDaemonIfRunning).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([0, 50_000])("maps --wait-ms %i only into the observation request", async (waitMs) => {
    expect(
      await runsWaitCommand(
        parseArgs([
          "runs-wait",
          "--targets-json",
          JSON.stringify(targets),
          "--wait-ms",
          String(waitMs),
          "--json",
        ]),
        true,
      ),
    ).toBe(0);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({
      targets: [{ runId: "job-a" }, { runId: "run-a", seen: TOKEN }, { runId: "job-a" }],
      waitMs,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(stdout)).toEqual(body);
  });

  it.each([false, true])(
    "emits one compact JSON-stream line (also --json=%s), without another wait",
    async (alsoJson) => {
      expect(
        await runsWaitCommand(
          parseArgs([
            "runs-wait",
            "--targets-json",
            JSON.stringify(targets),
            "--json-stream",
            ...(alsoJson ? ["--json"] : []),
          ]),
          alsoJson,
        ),
      ).toBe(0);
      expect(stdout).toBe(`${JSON.stringify(body)}\n`);
      expect(stderr).toBe("");
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("returns the current timeout snapshot once without starting another wait", async () => {
    const timeout: RunWaitManyResult = {
      wakeReason: "timeout",
      attention: [],
      summaries: [{ status: "running", pending: false, token: TOKEN, problem: null }],
    };
    fetch.mockResolvedValue(Response.json(timeout));
    expect(
      await runsWaitCommand(
        parseArgs([
          "runs-wait",
          "--targets-json",
          '[{"runId":"r"}]',
          "--wait-ms",
          "0",
          "--json-stream",
        ]),
        false,
      ),
    ).toBe(0);
    expect(stdout).toBe(`${JSON.stringify(timeout)}\n`);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(
    [
      [],
      ["--targets-json"],
      ["--targets-json", "not JSON"],
      ["--targets-json", "null"],
      ["--targets-json", "{}"],
      ["--targets-json", '{"targets":[{"runId":"r"}]}'],
      ["--targets-json", "[]"],
      ["--targets-json", "[null]"],
      ["--targets-json", '[{"runId":" "}]'],
      ["--targets-json", '[{"runId":"r","seen":"bad"}]'],
      ["--targets-json", '[{"runId":"r","afterSeq":1}]'],
      ...["-1", "50001", "1.5", "25ms", "NaN", "Infinity", "", " "].map((value) => [
        "--targets-json",
        '[{"runId":"r"}]',
        "--wait-ms",
        value,
      ]),
      ["--targets-json", '[{"runId":"r"}]', "--wait-ms"],
    ].map((flags) => ({ flags })),
  )("rejects invalid CLI input case %# before discovery", async ({ flags }) => {
    expect(await runsWaitCommand(parseArgs(["runs-wait", ...flags, "--json"]), true)).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, exitCode: 2, code: "invalid_argument" });
    expect(stderr).toBe("");
    expect(daemon.connectDaemonIfRunning).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { targets: Array.from({ length: 1001 }, () => ({ runId: "r" })) },
    { targets: Array.from({ length: 1000 }, () => ({ runId: "\u0001".repeat(256) })) },
  ])(
    "rejects count/aggregate-byte overflow case %# before discovery",
    async ({ targets: tooManyTargets }) => {
      expect(
        await runsWaitCommand(
          parseArgs(["runs-wait", "--targets-json", JSON.stringify(tooManyTargets), "--json"]),
          true,
        ),
      ).toBe(2);
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, exitCode: 2 });
      expect(daemon.connectDaemonIfRunning).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("keeps a JSON-stream validation refusal on one line", async () => {
    expect(
      await runsWaitCommand(
        parseArgs(["runs-wait", "--targets-json", "[]", "--json-stream"]),
        false,
      ),
    ).toBe(2);
    const envelope = JSON.parse(stdout);
    expect(envelope).toMatchObject({ ok: false, code: "invalid_argument", exitCode: 2 });
    expect(stdout).toBe(`${JSON.stringify(envelope)}\n`);
    expect(stderr).toBe("");
    expect(daemon.connectDaemonIfRunning).not.toHaveBeenCalled();
  });

  it.each(["json", "json-stream"])(
    "reports daemon absence as pure --%s error output without auto-start",
    async (format) => {
      daemon.connectDaemonIfRunning.mockResolvedValue(null);
      expect(
        await runsWaitCommand(
          parseArgs(["runs-wait", "--targets-json", '[{"runId":"r"}]', `--${format}`]),
          format === "json",
        ),
      ).toBe(1);
      const envelope = JSON.parse(stdout);
      expect(envelope).toMatchObject({
        ok: false,
        exitCode: 1,
        code: "daemon_unavailable",
        retryable: true,
      });
      if (format === "json-stream") expect(stdout).toBe(`${JSON.stringify(envelope)}\n`);
      expect(stderr).toBe("");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("preserves typed old-daemon refusal and remedy in a single JSON-stream line", async () => {
    fetch.mockResolvedValue(
      Response.json(
        {
          code: "not_found",
          message: "unsupported route",
          retryable: false,
          fieldErrors: {},
          requiredActions: ["use a daemon supporting wait-many"],
          evidenceRefs: [],
          context: {},
        },
        { status: 404 },
      ),
    );
    expect(
      await runsWaitCommand(
        parseArgs(["runs-wait", "--targets-json", '[{"runId":"r"}]', "--json-stream"]),
        false,
      ),
    ).toBe(1);
    const envelope = JSON.parse(stdout);
    expect(envelope).toMatchObject({
      ok: false,
      code: "not_found",
      retryable: false,
      requiredActions: ["use a daemon supporting wait-many"],
    });
    expect(stdout).toBe(`${JSON.stringify(envelope)}\n`);
    expect(stderr).toBe("");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["json", "json-stream"])(
    "rejects a wrong-row-count reply in --%s output",
    async (format) => {
      // The shared three-row reply is intentionally invalid for this one target.
      expect(
        await runsWaitCommand(
          parseArgs(["runs-wait", "--targets-json", '[{"runId":"r"}]', `--${format}`]),
          format === "json",
        ),
      ).toBe(1);
      const envelope = JSON.parse(stdout);
      expect(envelope).toMatchObject({ ok: false, code: "invalid_service_response", exitCode: 1 });
      if (format === "json-stream") expect(stdout).toBe(`${JSON.stringify(envelope)}\n`);
      expect(stderr).toBe("");
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("keeps the logical 1000-row response within 128 KiB in one output line", async () => {
    const large: RunWaitManyResult = {
      wakeReason: "attention",
      attention: Array.from({ length: 1000 }, (_, i) => i),
      summaries: Array.from({ length: 1000 }, () => ({
        status: "interrupted",
        pending: false,
        token: TOKEN,
        problem: null,
      })),
    };
    fetch.mockResolvedValue(Response.json(large));
    expect(
      await runsWaitCommand(
        parseArgs([
          "runs-wait",
          "--targets-json",
          JSON.stringify(Array.from({ length: 1000 }, () => ({ runId: "x".repeat(256) }))),
          "--json-stream",
        ]),
        false,
      ),
    ).toBe(0);
    expect(stdout).toBe(`${JSON.stringify(large)}\n`);
    expect(RunWaitManyResult.parse(JSON.parse(stdout))).toEqual(large);
    expect(Buffer.byteLength(stdout.trimEnd(), "utf8")).toBe(113_944);
    expect(Buffer.byteLength(stdout.trimEnd(), "utf8")).toBeLessThanOrEqual(131_072);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("runs-wait registry and flag ownership", () => {
  it("registers a read verb with no positional operands and both JSON output modes", () => {
    const matches = CLI_COMMANDS.filter((command) => command.id === "runs-wait");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.mutability).toBe("read");
    expect(matches[0]?.flags).toEqual(
      expect.arrayContaining(["targets-json", "wait-ms", "json", "json-stream"]),
    );
    expect(commandPositionalError("runs-wait", [])).toBeNull();
    expect(commandPositionalError("runs-wait", ["run-a"])).toContain(
      "invalid positional arguments",
    );
    expect(
      commandFlagScopeError("runs-wait", ["targets-json", "wait-ms", "json-stream"]),
    ).toBeNull();
  });

  it.each(["targets-json", "wait-ms"])(
    "declares --%s as a value flag exclusively for observation",
    (flag) => {
      expect(CLI_FLAGS.find((entry) => entry.name === flag)?.kind).toBe("value");
      expect(VALUE_FLAGS).toContain(flag);
      expect(RUN_FLAGS).not.toContain(flag);
      for (const [mode, flags] of Object.entries(RUN_FLAGS_BY_MODE)) {
        expect(flags, mode).not.toContain(flag);
      }
      for (const command of ["ask", "plan", "agent", "best-of", "create"]) {
        expect(CLI_COMMANDS.find((entry) => entry.id === command)?.flags, command).not.toContain(
          flag,
        );
        expect(commandFlagScopeError(command, [flag]), command).toContain(`--${flag}`);
      }
      for (const mode of ["ask", "plan", "agent"] as const) {
        expect(runModeFlagScopeError(mode, [flag]), mode).toContain(`--${flag}`);
      }
    },
  );

  it.each(["harness", "max-seconds", "time-limit-mode", "resume", "prompt-file", "delegate"])(
    "refuses run control --%s on the observer verb",
    (flag) => {
      expect(commandFlagScopeError("runs-wait", [flag])).toContain(`--${flag}`);
    },
  );
});
