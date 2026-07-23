import { afterEach, describe, expect, it, vi } from "vitest";
import { printJson, printJsonLine, printUnhandledCliFailure, printUsageError } from "./cli-io.js";

describe("cli-io NDJSON contract (W13/G2)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("printJsonLine emits exactly one line of COMPACT JSON (valid NDJSON)", () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
      chunks.push(String(s));
      return true;
    });
    printJsonLine({ frame: "run.started", runId: "run-1", nested: { a: 1, b: [2, 3] } });
    expect(chunks).toHaveLength(1);
    const line = chunks[0] as string;
    // Exactly one trailing newline, no interior newlines (a single NDJSON line).
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual({
      frame: "run.started",
      runId: "run-1",
      nested: { a: 1, b: [2, 3] },
    });
  });

  it("printJson stays PRETTY (multi-line) — the exactly-one-object --json surface", () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
      chunks.push(String(s));
      return true;
    });
    printJson({ a: 1, b: 2 });
    // Pretty output has interior newlines; the two surfaces are distinct.
    expect((chunks[0] as string).slice(0, -1).includes("\n")).toBe(true);
  });

  it("usage failures emit exactly one complete typed JSON object", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
      stdout.push(String(s));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      stderr.push(String(s));
      return true;
    });
    expect(
      printUsageError(
        true,
        Object.assign(new Error("--n must be at least 1"), {
          code: "invalid_argument",
          status: 400,
          fieldErrors: { n: ["must be at least 1"] },
        }),
      ),
    ).toBe(2);
    expect(stdout).toHaveLength(1);
    expect(stderr).toHaveLength(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: false,
      exitCode: 2,
      code: "invalid_argument",
      message: "--n must be at least 1",
      error: "--n must be at least 1",
      fieldErrors: { n: ["must be at least 1"] },
    });
  });

  it("the top-level fallback remains JSON-aware without parsed args or daemon state", () => {
    const stdout: string[] = [];
    const originalArgv = process.argv;
    process.argv = ["node", "claudexor", "doctor", "--json"];
    vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
      stdout.push(String(s));
      return true;
    });
    try {
      expect(printUnhandledCliFailure(new Error("unexpected boom"))).toBe(1);
    } finally {
      process.argv = originalArgv;
    }
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: false,
      exitCode: 1,
      code: "unexpected_error",
      message: "claudexor: unexpected boom",
    });
  });
});
