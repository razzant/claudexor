import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDaemon: vi.fn(),
  controlApiFetch: vi.fn(),
}));

// Partial mocks (spread the real module) so the wide ops-commands import graph
// keeps every other export intact — only the daemon seam is stubbed.
vi.mock("./daemon-run.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureDaemon: mocks.ensureDaemon,
}));
vi.mock("./live.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  controlApiFetch: mocks.controlApiFetch,
}));

import { parseArgs } from "./args.js";
import { doctorCommand } from "./ops-commands.js";

function harness(configuredModelCheck: { status: "ok" | "rejected"; message?: string | null }) {
  return {
    harnesses: [
      {
        id: "claude",
        available: true,
        status: "ok",
        manifest: null,
        authSources: [],
        enabledIntents: ["explain"],
        routableIntents: ["explain"],
        disabledIntents: [],
        checks: [],
        reasons: [],
        configuredModel: "claude-opus-5-5",
        configuredModelCheck,
      },
    ],
  };
}

const routeHealth = {
  windowDays: 7,
  from: "2026-10-21T12:00:00.000Z",
  generatedAt: "2026-10-28T12:00:00.000Z",
  scannedRuns: 125,
  complete: true,
  incompleteReason: null,
  routes: [
    {
      harnessId: "agy",
      access: "readonly",
      runs: 123,
      succeeded: 57,
      failed: 64,
      cancelled: 2,
      other: 0,
      topFailures: [
        {
          category: "harness_error",
          code: null,
          message: "agy headless tool permission refused: read_file",
          count: 38,
        },
      ],
    },
    {
      harnessId: "claude",
      access: "readonly",
      runs: 2,
      succeeded: 2,
      failed: 0,
      cancelled: 0,
      other: 0,
      topFailures: [],
    },
  ],
};

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("the human doctor output and the configured-model verdict (INV-104)", () => {
  let out: string[];
  beforeEach(() => {
    vi.clearAllMocks();
    out = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    mocks.ensureDaemon.mockResolvedValue({ addr: { host: "127.0.0.1", port: 1, token: "t" } });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function serve(
    check: { status: "ok" | "rejected"; message?: string | null },
    health: () => Response = () => jsonResponse(routeHealth),
  ) {
    mocks.controlApiFetch.mockImplementation(async (_addr: unknown, path: string) =>
      path.startsWith("/daemon/route-health") ? health() : jsonResponse(harness(check)),
    );
  }

  async function doctorText(check: { status: "ok" | "rejected"; message?: string | null }) {
    serve(check);
    expect(await doctorCommand(parseArgs(["doctor", "--harness", "claude"]), false)).toBe(0);
    return out.join("");
  }

  it("prints the admission note of an advisory harness beside the model", async () => {
    const text = await doctorText({
      status: "ok",
      message: 'model "claude-opus-5-5" is not in this account\'s listed models; forwarded',
    });
    expect(text).toContain(
      'model: claude-opus-5-5 — model "claude-opus-5-5" is not in this account\'s listed models; forwarded',
    );
  });

  it("stays silent for a listed model and still shouts for a refused one", async () => {
    expect(await doctorText({ status: "ok", message: null })).not.toContain("model:");
    out.length = 0;
    expect(await doctorText({ status: "rejected", message: "not in the truth source" })).toContain(
      "model: INVALID — not in the truth source",
    );
  });

  it("prints the daemon's route health after the harness rows: a summary and the failing routes", async () => {
    const text = await doctorText({ status: "ok", message: null });
    const lines = text.split("\n");
    const summary = lines.indexOf(
      "route health, last 7 days: 125 run(s) over 2 route(s), 1 with failures",
    );
    expect(summary).toBeGreaterThan(lines.indexOf("[ok] claude"));
    expect(lines[summary + 1]).toBe(
      "    agy readonly: 64/123 failed (52%), 2 cancelled; most: harness_error — agy headless tool permission refused: read_file ×38",
    );
    expect(text).not.toContain("claude readonly:");
  });

  it("carries the same answer under route_health in --json", async () => {
    serve({ status: "ok", message: null });
    expect(await doctorCommand(parseArgs(["doctor", "--harness", "claude", "--json"]), true)).toBe(
      0,
    );
    const envelope = JSON.parse(out.join("")) as { route_health: unknown; harnesses: unknown[] };
    expect(envelope.route_health).toEqual(routeHealth);
    expect(envelope.harnesses).toHaveLength(1);
  });

  it("names an older engine without the read (404) in both forms instead of failing doctor", async () => {
    const older = () => new Response("no such route", { status: 404 });
    serve({ status: "ok", message: null }, older);
    expect(await doctorCommand(parseArgs(["doctor", "--harness", "claude"]), false)).toBe(0);
    expect(out.join("")).toContain("? route health: unavailable from this engine version");
    out.length = 0;
    serve({ status: "ok", message: null }, older);
    expect(await doctorCommand(parseArgs(["doctor", "--harness", "claude", "--json"]), true)).toBe(
      0,
    );
    expect((JSON.parse(out.join("")) as { route_health: unknown }).route_health).toBeNull();
    expect(
      (JSON.parse(out.join("")) as { route_health_problem: unknown }).route_health_problem,
    ).toBeNull();
  });

  // #569: the read runs after the other sections are collected; its failure must
  // not discard them, pass for a healthy or empty week, or blame an older engine.
  it.each([
    [
      "the engine answers 503",
      () =>
        new Response('{"code":"route_health_failed","message":"bulk worker restarting"}', {
          status: 503,
        }),
      'control API /daemon/route-health failed (503): {"code":"route_health_failed","message":"bulk worker restarting"}',
    ],
    [
      "the engine's 503 echoes a credential, masked in both forms",
      () =>
        // Assembled at runtime so the source holds no credential-shaped literal.
        new Response(
          `{"code":"route_health_failed","message":"upstream refused ${"sk-ant-" + "a".repeat(24)}"}`,
          { status: 503 },
        ),
      'control API /daemon/route-health failed (503): {"code":"route_health_failed","message":"upstream refused [redacted]"}',
    ],
    [
      "the connection drops",
      () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
            code: "ECONNREFUSED",
          }),
        });
      },
      "fetch failed (connect ECONNREFUSED 127.0.0.1:1)",
    ],
    [
      "the answer does not match its schema",
      () => jsonResponse({ ...routeHealth, windowDays: 14 }),
      "the answer did not match its schema (windowDays: Invalid literal value, expected 7)",
    ],
  ])("keeps every other section and names the cause when %s", async (_label, health, cause) => {
    serve({ status: "ok", message: null }, health);
    expect(await doctorCommand(parseArgs(["doctor", "--harness", "claude"]), false)).toBe(0);
    const text = out.join("");
    expect(text).toContain("? git: readiness unavailable from this engine version\n");
    expect(text).toContain("[ok] claude\n    intents: explain\n    auto-routable: explain\n");
    expect(text).toContain(`? route health: unavailable — ${cause}\n`);
    expect(text).not.toContain("route health: unavailable from this engine version");
    expect(text).not.toContain("route health, last");

    out.length = 0;
    serve({ status: "ok", message: null }, health);
    expect(await doctorCommand(parseArgs(["doctor", "--harness", "claude", "--json"]), true)).toBe(
      0,
    );
    const envelope = JSON.parse(out.join("")) as Record<string, unknown>;
    expect(envelope["harnesses"]).toHaveLength(1);
    expect(envelope).toHaveProperty("git", null);
    expect(envelope["route_health"]).toBeNull();
    expect(envelope["route_health_problem"]).toBe(cause);
  });

  it("never rounds a failure away, or a partial failure up to every run (#569)", async () => {
    const route = (harnessId: string, failed: number, runs: number) => ({
      harnessId,
      access: "readonly",
      runs,
      succeeded: runs - failed,
      failed,
      cancelled: 0,
      other: 0,
      topFailures: [],
    });
    serve({ status: "ok", message: null }, () =>
      jsonResponse({
        ...routeHealth,
        scannedRuns: 402,
        routes: [route("agy", 200, 201), route("claude", 1, 201)],
      }),
    );
    expect(await doctorCommand(parseArgs(["doctor", "--harness", "claude"]), false)).toBe(0);
    const text = out.join("");
    expect(text).toContain(
      "route health, last 7 days: 402 run(s) over 2 route(s), 2 with failures\n",
    );
    expect(text).toContain("    agy readonly: 200/201 failed (>99%)\n");
    expect(text).toContain("    claude readonly: 1/201 failed (<1%)\n");
    expect(text).not.toContain("(0%)");
    expect(text).not.toContain("(100%)");
  });
});
