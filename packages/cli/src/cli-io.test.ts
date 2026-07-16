import { afterEach, describe, expect, it, vi } from "vitest";
import { printJson, printJsonLine } from "./cli-io.js";

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
});
