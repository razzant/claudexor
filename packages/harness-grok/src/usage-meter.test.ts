import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const opened: string[] = [];
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    readFile: (async (path: unknown, ...rest: unknown[]) => {
      opened.push(String(path));
      return (real.readFile as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof real.readFile,
  };
});

const { GROK_TICKS_PER_USD, readGrokUsageSpend } = await import("./usage-meter.js");
const { grokFailure } = await import("./parse.js");

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => opened.splice(0));

const START = Date.parse("2026-03-01T00:00:00Z");
const END = Date.parse("2026-03-31T00:00:00Z");
const PERIOD = { start: START, end: END };
const usd = (amount: number) => Math.round(amount * GROK_TICKS_PER_USD);

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-grok-usage-"));
  dirs.push(dir);
  return dir;
}

/** Write one session's usage record the way the Grok CLI lays it out. */
function session(
  grokHome: string,
  name: string,
  content: unknown,
  modifiedAt = START + 86_400_000,
): string {
  const dir = join(grokHome, "sessions", "C%3A%5Cwork%5Cproject", name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "usage.json");
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  utimesSync(file, modifiedAt / 1000, modifiedAt / 1000);
  return dir;
}

const turn = (endedAt: string, dollars: number, extra: Record<string, unknown> = {}) => ({
  endedAt,
  totalTokens: 1000,
  costUsdTicks: usd(dollars),
  ...extra,
});

describe("Grok local usage meter", () => {
  it("counts 10,000,000,000 ticks as one US dollar", async () => {
    expect(GROK_TICKS_PER_USD).toBe(1e10);
    const grokHome = home();
    session(grokHome, "s1", { turns: [{ endedAt: "2026-03-02T00:00:00Z", costUsdTicks: 1e10 }] });
    expect((await readGrokUsageSpend(grokHome, PERIOD)).usd).toBe(1);
  });

  it("sums the turns that ended inside the period, across sessions and models", async () => {
    const grokHome = home();
    session(grokHome, "s1", {
      turns: [
        turn("2026-03-02T10:00:00.771972500+00:00", 1.25, { primaryModelId: "grok-a" }),
        turn("2026-03-05T10:00:00Z", 0.75, {
          modelUsage: {
            "grok-a": { costUsdTicks: usd(0.5) },
            "grok-b": { costUsdTicks: usd(0.25) },
          },
        }),
      ],
    });
    session(grokHome, "s2", { turns: [turn("2026-03-30T23:59:59Z", 2)] });
    const spend = await readGrokUsageSpend(grokHome, PERIOD);
    expect(spend).toMatchObject({ turns: 3, totalTokens: 3000, unreadable: 0 });
    expect(spend.usd).toBeCloseTo(4, 9);
    expect(spend.usdByModel["grok-a"]).toBeCloseTo(1.75, 9);
    expect(spend.usdByModel["grok-b"]).toBeCloseTo(0.25, 9);
  });

  it("includes a turn at the period start and excludes one at its end", async () => {
    const grokHome = home();
    session(
      grokHome,
      "s1",
      {
        turns: [
          turn("2026-02-28T23:59:59.999Z", 100),
          turn("2026-03-01T00:00:00.000Z", 1),
          turn("2026-03-30T23:59:59.999Z", 2),
          turn("2026-03-31T00:00:00.000Z", 100),
        ],
      },
      END,
    );
    const spend = await readGrokUsageSpend(grokHome, PERIOD);
    expect(spend.turns).toBe(2);
    expect(spend.usd).toBeCloseTo(3, 9);
    // The next period starts where this one ends and holds only the last turn.
    const next = await readGrokUsageSpend(grokHome, { start: END, end: END + 30 * 86_400_000 });
    expect(next.turns).toBe(1);
    expect(next.usd).toBeCloseTo(100, 9);
  });

  it("reports a malformed record as unreadable instead of counting it as zero", async () => {
    const grokHome = home();
    session(grokHome, "ok", { turns: [turn("2026-03-02T00:00:00Z", 1)] });
    session(grokHome, "truncated", '{"turns": [{"endedAt": "2026-03-0');
    session(grokHome, "no-turns", { sessionId: "x" });
    session(grokHome, "bad-turn", {
      turns: [turn("2026-03-03T00:00:00Z", 5), { endedAt: "2026-03-04T00:00:00Z" }],
    });
    session(grokHome, "negative", { turns: [turn("2026-03-03T00:00:00Z", -1)] });
    const spend = await readGrokUsageSpend(grokHome, PERIOD);
    // A record counts whole or not at all: the valid turn beside the bad one adds nothing.
    expect(spend).toMatchObject({ turns: 1, unreadable: 4 });
    expect(spend.usd).toBeCloseTo(1, 9);
  });

  it("does not open a record last modified before the period", async () => {
    const grokHome = home();
    session(grokHome, "old", "not json at all", START - 1000);
    session(grokHome, "new", { turns: [turn("2026-03-02T00:00:00Z", 1)] });
    const spend = await readGrokUsageSpend(grokHome, PERIOD);
    expect(spend).toMatchObject({ turns: 1, unreadable: 0 });
    expect(opened.some((path) => path.includes("old"))).toBe(false);
  });

  it("treats an account with no sessions as having spent nothing", async () => {
    expect(await readGrokUsageSpend(home(), PERIOD)).toMatchObject({ usd: 0, unreadable: 0 });
  });

  it("opens only usage.json, never the credential or a conversation", async () => {
    const grokHome = home();
    writeFileSync(join(grokHome, "auth.json"), '{"token":"do-not-read"}');
    const dir = session(grokHome, "s1", { turns: [turn("2026-03-02T00:00:00Z", 1)] });
    writeFileSync(join(dir, "messages.jsonl"), '{"role":"user","content":"private"}\n');
    writeFileSync(join(dir, "auth.json"), "{}");
    await readGrokUsageSpend(grokHome, PERIOD);
    expect(opened.length).toBe(1);
    expect(opened.every((path) => path.endsWith("usage.json"))).toBe(true);
  });
});

describe("Grok spent-credits refusal", () => {
  it("types the vendor's spent-credits refusal as a usage refusal with no reopening time", () => {
    const event = grokFailure(
      "403 Forbidden: your team has either used all available credits or reached its monthly spending limit",
      "ses_1",
    );
    expect(event.type).toBe("error");
    expect(event.rate_limit).toEqual({
      resets_at: null,
      retry_delay_ms: null,
      reopening: "unknown",
    });
    expect(event.status).toEqual({ kind: "api_retry", error_category: "rate_limit" });
  });

  it("keeps an ordinary rate limit dated by the vendor's own retry hint", () => {
    const event = grokFailure({ status: 429, message: "rate limited", retry_after: 30 }, "ses_1");
    expect(event.rate_limit).toMatchObject({ retry_delay_ms: 30_000 });
    expect(event.rate_limit?.reopening).toBeUndefined();
  });

  it("leaves an unrelated 403 untyped", () => {
    expect(grokFailure("403 Forbidden: access denied", "ses_1").rate_limit).toBeUndefined();
  });
});
