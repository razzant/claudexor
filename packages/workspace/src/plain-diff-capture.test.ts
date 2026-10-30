import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCaptureRaw } from "@claudexor/core";
import { PlainDiffProjection, capturePlainDiff } from "./plain-diff-capture.js";
import { excludePlainDiffPathPrefix, relativizePlainDiffHeaders } from "./plain-diff.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cx-plain-capture-"));
  roots.push(root);
  const baseline = join(root, "baseline");
  const live = join(root, "live");
  for (const dir of [baseline, live]) mkdirSync(join(dir, "owned"), { recursive: true });
  return { baseline, live };
}

it("matches complete header normalization/exclusion across UTF-8 chunk boundaries", async () => {
  const { baseline, live } = fixture();
  writeFileSync(join(baseline, "text"), "old\r\n");
  writeFileSync(join(live, "text"), "☺ new\r\n");
  writeFileSync(join(live, "owned", "log"), "omit\n");
  writeFileSync(join(live, "binary"), Buffer.from([0, 1, 2]));
  const raw = await runCaptureRaw("diff", ["-ruN", baseline, live]);
  const expected = excludePlainDiffPathPrefix(
    relativizePlainDiffHeaders(raw.stdout, baseline, live),
    "owned",
  );
  const projection = new PlainDiffProjection(baseline, live, "owned");
  for (const byte of Buffer.from(raw.stdout)) projection.write(Buffer.from([byte]));
  expect(projection.end()).toBe(expected);
  const result = await capturePlainDiff(baseline, live, "owned");
  expect(result.captureIncomplete).toBe(false);
  // The capture's exclusion flags appear in the structural command echo.
  expect(
    result.diff.replaceAll(
      "diff -ruN -x .git -x node_modules -x __pycache__ -x .venv -x venv",
      "diff -ruN",
    ),
  ).toBe(expected);
  expect((await capturePlainDiff(join(baseline, "missing"), live, null)).captureIncomplete).toBe(
    true,
  );
});

it("bounds a large single line during capture without concatenating stdout", async () => {
  const { baseline, live } = fixture();
  const projection = new PlainDiffProjection(baseline, live);
  const concat = vi.spyOn(Buffer, "concat");
  const result = await runCaptureRaw(
    process.execPath,
    [
      "-e",
      `
    const fs = require('node:fs');
    const block = Buffer.alloc(1024 * 1024, 120);
    let remaining = ${2 * 1024 * 1024};
    while (remaining) {
      const count = Math.min(remaining, block.length);
      let offset = 0;
      while (offset < count) offset += fs.writeSync(1, block, offset, count - offset);
      remaining -= count;
    }
  `,
    ],
    { stdoutProjection: projection },
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("x".repeat(200_000) + "\n... [diff truncated]\n");
  expect(concat.mock.calls.every(([chunks]) => chunks.length === 0)).toBe(true);
});

it("skips an oversized owned record and keeps binary stubs beyond the preview", async () => {
  const { baseline, live } = fixture();
  writeFileSync(join(live, "owned", "log"), "x".repeat(300_000));
  writeFileSync(join(live, "text"), "y".repeat(300_000));
  writeFileSync(join(live, "z-secret"), Buffer.from("\0" + ["sk", "s".repeat(24)].join("-")));
  writeFileSync(join(live, "z-clean"), Buffer.from([0, 1, 2]));
  const result = await capturePlainDiff(baseline, live, "owned");
  expect(result.captureIncomplete).toBe(true);
  expect(result.captureFailure).toMatchObject({ code: "capture_preview_truncated" });
  expect(result.diff.length).toBe(200_000 + "\n... [diff truncated]\n".length);
  const raw = await runCaptureRaw("diff", [
    "-ruN",
    "-x",
    ".git",
    "-x",
    "node_modules",
    "-x",
    "__pycache__",
    "-x",
    ".venv",
    "-x",
    "venv",
    baseline,
    live,
  ]);
  const expected = excludePlainDiffPathPrefix(
    relativizePlainDiffHeaders(raw.stdout, baseline, live),
    "owned",
  );
  expect(result.diff).toBe(expected.slice(0, 200_000) + "\n... [diff truncated]\n");
});
