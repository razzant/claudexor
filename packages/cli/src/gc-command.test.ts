import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDEXOR_VERSION } from "@claudexor/util";

const mocks = vi.hoisted(() => ({
  ensureDaemon: vi.fn(),
  connectDaemonIfRunning: vi.fn(),
  controlApiFetch: vi.fn(),
}));

// Partial mocks (spread the real module) so the wide ops-commands import graph
// keeps every other export intact — only the daemon seam is stubbed.
vi.mock("./daemon-run.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureDaemon: mocks.ensureDaemon,
  connectDaemonIfRunning: mocks.connectDaemonIfRunning,
}));
vi.mock("./live.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  controlApiFetch: mocks.controlApiFetch,
}));

import { parseArgs } from "./args.js";
import { gcCommand } from "./ops-commands.js";

/** Minimal receipt the pre-feature shape allows: no data_root_unrecognized. */
const RECEIPT = {
  schema_version: 1,
  dry_run: false,
  started_at: "2026-08-08T00:00:00.000Z",
  finished_at: "2026-08-08T00:00:01.000Z",
  policy: { runs_max_age_days: 30, reviews_max_age_days: 14, keep_last_runs_per_project: 1 },
  examined_runs: 0,
  deleted_runs: [],
  kept: {},
  deleted_reviews: [],
  freed_bytes: 0,
  errors: [],
};

function engine(version: string | null): { engineVersion: string | null; engineBuildSha: null } {
  return { engineVersion: version, engineBuildSha: null };
}

function sentBody(): Record<string, unknown> {
  const init = mocks.controlApiFetch.mock.calls[0]?.[2] as { body?: string } | undefined;
  expect(init?.body).toBeTypeOf("string");
  return JSON.parse(init!.body!) as Record<string, unknown>;
}

describe("gcCommand data_root_report capability negotiation", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mocks.controlApiFetch.mockResolvedValue(
      new Response(JSON.stringify(RECEIPT), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it("sends the opt-in report flags ONLY to a lockstep same-version daemon", async () => {
    mocks.ensureDaemon.mockResolvedValue({
      addr: { baseUrl: "http://127.0.0.1:1234", token: "t" },
      engine: engine(CLAUDEXOR_VERSION),
    });
    expect(await gcCommand(parseArgs(["gc", "--dry-run"]), true)).toBe(0);
    expect(sentBody()).toEqual({
      dry_run: true,
      data_root_report: true,
      trash_purge_report: true,
      native_home_report: true,
      retention_report: true,
    });
  });

  it("prints the thread purges a lockstep receipt discloses", async () => {
    mocks.ensureDaemon.mockResolvedValue({
      addr: { baseUrl: "http://127.0.0.1:1234", token: "t" },
      engine: engine(CLAUDEXOR_VERSION),
    });
    mocks.controlApiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          ...RECEIPT,
          dry_run: true,
          purged_threads: ["th-1", "th-2"],
          purge_leftovers: ["th-0"],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    expect(await gcCommand(parseArgs(["gc", "--dry-run"]), false)).toBe(0);
    const out = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(out).toContain("would purge 2 expired trash thread(s): th-1, th-2");
    expect(out).toContain("would finish 1 purge(s) whose cleanup failed earlier: th-0");
  });

  it("prints no trash line when the receipt omits the opt-in field", async () => {
    mocks.ensureDaemon.mockResolvedValue({
      addr: { baseUrl: "http://127.0.0.1:1234", token: "t" },
      engine: engine("0.0.1"),
    });
    expect(await gcCommand(parseArgs(["gc"]), false)).toBe(0);
    const out = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(out).not.toContain("expired trash");
    expect(out).not.toContain("cleanup failed earlier");
  });

  it("omits the flag on engine-version skew (exact 3.3.11 request shape)", async () => {
    mocks.ensureDaemon.mockResolvedValue({
      addr: { baseUrl: "http://127.0.0.1:1234", token: "t" },
      engine: engine("0.0.1"),
    });
    expect(await gcCommand(parseArgs(["gc"]), true)).toBe(0);
    expect(sentBody()).toEqual({ dry_run: false });
  });

  it("omits the flag when the handshake reported no well-formed engine version", async () => {
    mocks.ensureDaemon.mockResolvedValue({
      addr: { baseUrl: "http://127.0.0.1:1234", token: "t" },
      engine: engine(null),
    });
    expect(await gcCommand(parseArgs(["gc"]), true)).toBe(0);
    expect(sentBody()).toEqual({ dry_run: false });
  });
  it("reads --last with GET and prints every durable summary field", async () => {
    mocks.connectDaemonIfRunning.mockResolvedValue({
      addr: { baseUrl: "http://127.0.0.1:1234", token: "t" },
      engine: engine(CLAUDEXOR_VERSION),
    });
    const last = {
      outcome: "held",
      started_at: RECEIPT.started_at,
      finished_at: RECEIPT.finished_at,
      last_completed_at: "2026-08-07T00:00:00.000Z",
      failed_or_held_streak: 3,
      freed_bytes: 42,
      kept: { referenced: 3 },
      held: { roots: 2, native_homes: 1 },
      holds: [
        {
          class: "missing_partition",
          count: 2,
          example: "/fixture/root",
          since: "2026-08-01T00:00:00Z",
        },
      ],
      errors: { count: 1, first: "missing owner" },
    };
    mocks.controlApiFetch.mockResolvedValue(new Response(JSON.stringify({ last })));
    expect(await gcCommand(parseArgs(["gc", "--last"]), false)).toBe(0);
    expect(mocks.controlApiFetch).toHaveBeenCalledWith(
      expect.anything(),
      "/maintenance/gc?retention_report=true",
    );
    expect(mocks.ensureDaemon).not.toHaveBeenCalled();
    const out = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    for (const text of [
      "held:",
      `last completed: ${last.last_completed_at}; failed/held streak: 3`,
      last.started_at,
      last.finished_at,
      "42 bytes",
      "referenced=3",
      "roots=2",
      "native_homes=1",
      "missing_partition: 2",
      last.holds[0]!.since,
      "/fixture/root",
      "errors=1",
      "missing owner",
    ])
      expect(out).toContain(text);
  });
  it("keeps completion history unknown across engine-version skew in text and JSON", async () => {
    const last = {
      outcome: "failed",
      started_at: RECEIPT.started_at,
      finished_at: RECEIPT.finished_at,
      freed_bytes: 42,
      kept: { referenced: 3 },
      held: { roots: 2, native_homes: 1 },
      holds: [],
      errors: { count: 1, first: "newer daemon" },
    };
    mocks.connectDaemonIfRunning.mockResolvedValue({
      addr: { baseUrl: "http://127.0.0.1:1234", token: "t" },
      engine: engine("999.0.0"),
    });
    const response = () => new Response(JSON.stringify({ last }));
    mocks.controlApiFetch.mockResolvedValue(response());
    expect(await gcCommand(parseArgs(["gc", "--last"]), false)).toBe(0);
    let out = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(out).toContain("failed:");
    expect(out).not.toContain("last completed:");
    expect(out).not.toContain("failed/held streak:");

    stdoutSpy.mockClear();
    mocks.controlApiFetch.mockResolvedValue(response());
    expect(await gcCommand(parseArgs(["gc", "--last", "--json"]), true)).toBe(0);
    out = stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    const printed = JSON.parse(out) as { last: Record<string, unknown> };
    expect(printed.last).not.toHaveProperty("last_completed_at");
    expect(printed.last).not.toHaveProperty("failed_or_held_streak");
    expect(mocks.controlApiFetch).toHaveBeenLastCalledWith(expect.anything(), "/maintenance/gc");
  });
  it.each(["0.0.1", "999.0.0", null])(
    "omits --last history opt-in for version %s",
    async (version) => {
      mocks.connectDaemonIfRunning.mockResolvedValue({
        addr: { baseUrl: "http://127.0.0.1:1234", token: "t" },
        engine: engine(version),
      });
      mocks.controlApiFetch.mockResolvedValue(new Response(JSON.stringify({ last: null })));
      expect(await gcCommand(parseArgs(["gc", "--last"]), true)).toBe(0);
      expect(mocks.controlApiFetch).toHaveBeenCalledWith(expect.anything(), "/maintenance/gc");
      expect(mocks.ensureDaemon).not.toHaveBeenCalled();
    },
  );
  it("does not start a daemon for --last when none is running", async () => {
    mocks.connectDaemonIfRunning.mockResolvedValue(null);
    await expect(gcCommand(parseArgs(["gc", "--last"]), false)).rejects.toThrow(
      "Daemon is not running",
    );
    expect(mocks.ensureDaemon).not.toHaveBeenCalled();
    expect(mocks.controlApiFetch).not.toHaveBeenCalled();
  });
  it("prints an unreadable last-pass diagnostic without starting GC", async () => {
    mocks.connectDaemonIfRunning.mockResolvedValue({
      addr: { baseUrl: "http://127.0.0.1:1234", token: "t" },
      engine: engine(CLAUDEXOR_VERSION),
    });
    const diagnostic = "Stored retention summary is unreadable; a new pass will replace it.";
    mocks.controlApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ last: null, diagnostic })),
    );
    expect(await gcCommand(parseArgs(["gc", "--last"]), false)).toBe(0);
    expect(stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("")).toContain(
      diagnostic,
    );
    expect(mocks.ensureDaemon).not.toHaveBeenCalled();
  });
  it("refuses --last --dry-run before contacting the daemon", async () => {
    await expect(gcCommand(parseArgs(["gc", "--last", "--dry-run"]), false)).rejects.toThrow(
      "cannot be combined",
    );
    expect(mocks.ensureDaemon).not.toHaveBeenCalled();
    expect(mocks.connectDaemonIfRunning).not.toHaveBeenCalled();
  });
});

describe("gc preparations and gc release-preparation (#694 r17)", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  const addr = { baseUrl: "http://127.0.0.1:1234", token: "t" };
  const digest = "b".repeat(64);
  const respond = (body: unknown) =>
    mocks.controlApiFetch.mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  const printed = () => stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
  beforeEach(() => {
    vi.clearAllMocks();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mocks.connectDaemonIfRunning.mockResolvedValue({ addr, engine: engine(CLAUDEXOR_VERSION) });
  });
  afterEach(() => stdoutSpy.mockRestore());

  it("lists through the read route only, and says what confirming means", async () => {
    respond({
      preparations: [
        {
          selector: "prep1.abc",
          digest,
          kind: "thread",
          path: "/p/threads/t1/tree",
          record: "/p/threads/t1/preparation.json",
          root: "/p",
          thread_id: "t1",
          since: "2026-11-15T10:00:00.000Z",
          stop: { reason: "output_held", groups: [] },
          read: { status: "quiet", reasons: [], unproven: "no census" },
          release: "operator_confirmation",
          refusal: null,
          operator_release: null,
          cleanup_error: null,
          on_release: "removes only this record",
        },
      ],
      roots: 2,
      confirmation: "Confirming states that you checked",
      errors: [],
    });
    expect(await gcCommand(parseArgs(["gc", "preparations"]), false)).toBe(0);
    expect(mocks.controlApiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.controlApiFetch.mock.calls[0]?.[1]).toBe("/maintenance/preparations");
    expect(mocks.controlApiFetch.mock.calls[0]?.[2]).toBeUndefined(); // a GET
    const out = printed();
    expect(out).toContain("selector: prep1.abc");
    expect(out).toContain(`digest:   ${digest}`);
    expect(out).toContain("release needs: operator_confirmation");
    expect(out).toContain("Confirming states that you checked");
    expect(mocks.ensureDaemon).not.toHaveBeenCalled(); // never starts a daemon to read
  });

  it("releases only with the digest and the explicit confirmation; any outcome but a release exits non-zero", async () => {
    for (const argv of [
      ["gc", "release-preparation", "prep1.abc", "--confirm-ended"],
      ["gc", "release-preparation", "prep1.abc", "--digest", digest],
      ["gc", "preparations", "--confirm-ended"],
      ["gc", "--digest", digest],
      [
        "gc",
        "release-preparation",
        "prep1.abc",
        "--digest",
        digest,
        "--confirm-ended",
        "--dry-run",
      ],
    ])
      await expect(gcCommand(parseArgs(argv), false)).rejects.toThrow();
    expect(mocks.controlApiFetch).not.toHaveBeenCalled();
    const receipt = (outcome: string, basis: string | null) => ({
      selector: "prep1.abc",
      kind: "thread",
      path: "/p/threads/t1/tree",
      outcome,
      basis,
      continued: false,
      reasons: outcome === "stale" ? ["inspect it again"] : [],
      cleanup_error: null,
      writer: null,
      remains: "nothing of this resource",
      note: "The run's recorded stop is unchanged.",
      operation_id: "delivery-7",
      replayed: outcome === "completed",
      generation: "thread:t1:a:b",
      stop: null,
      confirmed_at: null,
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      respond(receipt("released", "operator_confirmed"));
      const argv = [
        "gc",
        "release-preparation",
        "prep1.abc",
        "--digest",
        digest,
        "--confirm-ended",
      ];
      expect(await gcCommand(parseArgs(argv), false)).toBe(0);
      expect(mocks.controlApiFetch.mock.calls[0]?.[1]).toBe("/maintenance/preparations/release");
      expect(sentBody()).toEqual({ selector: "prep1.abc", digest, confirm_processes_ended: true });
      // A fresh key, announced before the request so a lost answer can be read back.
      const sent = mocks.controlApiFetch.mock.calls[0]?.[2] as { headers: Record<string, string> };
      const key = sent.headers["Idempotency-Key"]!;
      expect(key).toMatch(/^preparation-release-/);
      expect(stderr.mock.calls.map((call: unknown[]) => String(call[0])).join("")).toContain(
        `operation key: ${key}`,
      );
      expect(printed()).toContain("released: thread /p/threads/t1/tree (operator_confirmed)");
      expect(printed()).toContain("operation delivery-7");
      respond(receipt("stale", null));
      expect(await gcCommand(parseArgs(argv), false)).toBe(1);
      expect(printed()).toContain("reason: inspect it again");
      // An explicit key is sent as given; a replayed receipt says it is one.
      respond(receipt("completed", "operator_confirmed"));
      expect(await gcCommand(parseArgs([...argv, "--idempotency-key", "my-key"]), false)).toBe(0);
      const explicit = mocks.controlApiFetch.mock.calls.at(-1)?.[2] as {
        headers: Record<string, string>;
      };
      expect(explicit.headers["Idempotency-Key"]).toBe("my-key");
      expect(printed()).toContain("the recorded receipt of an earlier request with this key");
      respond(receipt("released", "saved_cleanup"));
      expect(await gcCommand(parseArgs(argv), false)).toBe(0);
      expect(printed()).toContain("released: thread /p/threads/t1/tree (saved_cleanup)");
      await expect(
        gcCommand(parseArgs(["gc", "preparations", "--idempotency-key", "x"]), false),
      ).rejects.toThrow();
    } finally {
      stderr.mockRestore();
    }
  });
});
