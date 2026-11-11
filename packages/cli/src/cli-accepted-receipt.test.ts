/**
 * CLI machine output after the daemon accepted a run (#163): when a later read
 * fails, the failure envelope still names the run, its accepted job and the
 * store (or task group) its receipt named. The real CLI run path, enqueue,
 * run-detail reader and failure projector run in process; only the daemon
 * connection and the HTTP transport are faked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL_STORE_IDENTITY_HEADER } from "@claudexor/schema";

const mocks = vi.hoisted(() => ({
  ensureDaemon: vi.fn(),
  controlApiFetch: vi.fn(),
  followRun: vi.fn(),
}));

vi.mock("./daemon-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./daemon-run.js")>()),
  ensureDaemon: mocks.ensureDaemon,
}));

vi.mock("./live.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./live.js")>()),
  controlApiFetch: mocks.controlApiFetch,
  followRun: mocks.followRun,
}));

// Each case imports and runs the CLI module graph.
vi.setConfig({ testTimeout: 120_000 });

const STORE = "22222222-2222-4222-8222-222222222222";
const GROUP = "11111111-1111-4111-8111-111111111111";
const addr = { baseUrl: "http://127.0.0.1:1", token: "fixture-only" };
const bound = { jobId: "job-r", runId: "run-r", runDir: "/fixture/run-r" };

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const mock of Object.values(mocks)) mock.mockReset();
});

/** The run detail answers 200, then its body stops partway, as when the connection drops. */
function cutOffDetail(): Response {
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(new TypeError("terminated"));
          return;
        }
        sent = true;
        controller.enqueue(new TextEncoder().encode('{"summary":{"runId":"run-r","state":'));
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function cli(argv: string[]) {
  const priorArgv = process.argv;
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  let stdout = "";
  let stderr = "";
  const capture =
    (append: (chunk: string) => void) =>
    (...args: unknown[]) => {
      append(String(args[0] ?? ""));
      (args.find((arg) => typeof arg === "function") as (() => void) | undefined)?.();
      return true;
    };
  const out = vi.spyOn(process.stdout, "write").mockImplementation(
    capture((chunk) => {
      stdout += chunk;
    }) as never,
  );
  const err = vi.spyOn(process.stderr, "write").mockImplementation(
    capture((chunk) => {
      stderr += chunk;
    }) as never,
  );
  process.argv = [process.execPath, "claudexor", ...argv];
  try {
    await import("./cli.js");
    await vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 60_000 });
  } finally {
    process.argv = priorArgv;
    out.mockRestore();
    err.mockRestore();
  }
  return { code: exit.mock.calls[0]?.[0], stdout, stderr };
}

const CASES: Array<{
  name: string;
  output: "--json" | "--json-stream";
  flags: string[];
  receipt: Record<string, string>;
}> = [
  { name: "its store", output: "--json", flags: [], receipt: { storeId: STORE } },
  { name: "its store", output: "--json-stream", flags: [], receipt: { storeId: STORE } },
  {
    name: "its group and store",
    output: "--json",
    flags: ["--task-group-id", GROUP],
    receipt: { taskGroupId: GROUP, storeId: STORE },
  },
  // A daemon that names no store: nothing is claimed for it.
  { name: "no store", output: "--json", flags: [], receipt: {} },
];

describe("CLI machine output after the daemon accepted a run", () => {
  it.each(CASES)(
    "$output keeps the accepted job and $name when the run detail body is cut off",
    async ({ output, flags, receipt }) => {
      const requests: string[] = [];
      let storeHeader: string | null = null;
      mocks.ensureDaemon.mockResolvedValue({
        client: { status: vi.fn(async () => ({ id: "job-r", ...bound, state: "succeeded" })) },
        addr,
      });
      mocks.followRun.mockResolvedValue(0);
      mocks.controlApiFetch.mockImplementation(
        async (_addr: unknown, path: string, init: RequestInit = {}) => {
          const method = init.method ?? "GET";
          requests.push(`${method} ${path}`);
          if (method === "POST" && path === "/projects") return Response.json({});
          if (method === "POST" && path === "/runs") {
            storeHeader = new Headers(init.headers).get(CONTROL_STORE_IDENTITY_HEADER);
            return Response.json({ ...bound, ...receipt });
          }
          if (method === "GET" && path === "/runs/run-r") return cutOffDetail();
          throw new Error(`unexpected control request: ${method} ${path}`);
        },
      );

      const result = await cli(["ask", "Say hello.", output, ...flags]);

      const message = "claudexor: run detail endpoint returned malformed JSON";
      const lines = result.stdout.trim().split("\n");
      const envelope: unknown = JSON.parse(
        output === "--json" ? result.stdout : lines[lines.length - 1]!,
      );
      expect(envelope).toEqual({
        runId: "run-r",
        jobId: "job-r",
        ...receipt,
        ok: false,
        exitCode: 1,
        code: "invalid_service_response",
        message,
        error: message,
        retryable: true,
      });
      if (output === "--json-stream") {
        expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
          {
            frame: "run.started",
            ...receipt,
            runId: "run-r",
            runDir: "/fixture/run-r",
            jobId: "job-r",
            mode: "ask",
          },
          envelope,
        ]);
      }
      expect(result).toMatchObject({ code: 1, stderr: "" });
      expect(storeHeader).toBe("1");
      // One admission and one detail read: the envelope reuses facts already in hand.
      expect(requests).toEqual(["POST /projects", "POST /runs", "GET /runs/run-r"]);
    },
  );
});
