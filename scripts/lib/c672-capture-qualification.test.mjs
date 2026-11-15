import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  controlFailure,
  conversionPreconditionFailure,
  heldCaptureFailure,
  receiptCauseIsConversionEperm,
  retainCliResult,
  retainQualification,
  settleHolderExit,
} from "../c672/capture-qualification.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "c672-qual-test-"));
  roots.push(root);
  return root;
}
const packageRoot = "C:\\Users\\runneradmin\\.claudexor\\node\\node_modules\\@github\\copilot";
const message = `EPERM: operation not permitted, rename '${packageRoot}' -> '${packageRoot}.claudexor-converted'`;
const record = {
  from: packageRoot,
  to: `${packageRoot}.claudexor-converted`,
  error: { code: "EPERM", message },
};
const direct = { ok: false, problem: { code: "EPERM", message }, limitations: [] };
const installer = {
  ok: false,
  problem: { code: "vendor_command_failed", message: "No newer packages available" },
  limitations: [
    `After the installer exited 2316632107, npm copy conversion failed (EPERM): ${message}`,
  ],
};

test.each([
  ["direct EPERM", direct],
  ["installer EPERM", installer],
])("%s preserves the captured hide cause", (_, receipt) => {
  expect(receiptCauseIsConversionEperm(receipt, record, packageRoot)).toBe(true);
});
test.each([
  ["non-EPERM", { ...direct, problem: { code: "EACCES", message } }, record],
  ["generic conversion", { ...installer, limitations: ["npm conversion failed"] }, record],
  [
    "EPERM without captured cause",
    { ...direct, problem: { code: "EPERM", message: "conversion failed EPERM" } },
    record,
  ],
  ["cause in unrelated field", { ...installer, limitations: [], note: message }, record],
  ["other captured error", direct, { ...record, error: { code: "EACCES", message } }],
  ["wrong source", direct, { ...record, from: `${packageRoot}-other` }],
  ["wrong destination", direct, { ...record, to: `${packageRoot}.bak` }],
  ["success", { ...direct, ok: true }, record],
])("rejects %s", (_, receipt, captured) => {
  expect(receiptCauseIsConversionEperm(receipt, captured, packageRoot)).toBe(false);
});

const healthy = {
  run: {
    status: 0,
    signal: null,
    error: null,
    receipt: { ok: true, outcome: "changed", mutation: "applied" },
  },
  packagePresent: false,
  hiddenPresent: false,
  remainingLaunchers: [],
  captureCount: 0,
};
test("healthy retirement accepts residual .ps1 and bare shims outside product ownership", () => {
  const facts = { ...healthy, remainingLaunchers: ["copilot.ps1", "copilot"] };
  expect(controlFailure(facts)).toBeNull();
  const dir = fixture();
  const result = {
    case: "control",
    qualified: controlFailure(facts) === null,
    reason: null,
    details: facts,
    cleanup: { status: "not_needed" },
  };
  expect(retainQualification(dir, result)).toBe(0);
  expect(JSON.parse(readFileSync(join(dir, "qualification.json"), "utf8"))).toMatchObject({
    case: "control",
    qualified: true,
    cleanup: { status: "not_needed" },
    exitCode: 0,
  });
});
test.each([
  ["package remains", { packagePresent: true }],
  ["hidden sibling remains", { hiddenPresent: true }],
  ["owned launcher remains", { remainingLaunchers: ["copilot.cmd"] }],
  [
    "no actual retirement",
    { run: { ...healthy.run, receipt: { ok: true, outcome: "unchanged", mutation: "none" } } },
  ],
  ["capture on healthy path", { captureCount: 1 }],
  ["spawn failure", { run: { ...healthy.run, error: { code: "ETIMEDOUT" } } }],
])("healthy control rejects %s", (_, change) => {
  expect(controlFailure({ ...healthy, ...change })).not.toBeNull();
});

test.each(["unknown", "failed", undefined])("cleanup %s cannot qualify held success", (status) => {
  const dir = fixture();
  const result = { case: "held-file", qualified: true, reason: null, cleanup: { status } };
  expect(retainQualification(dir, result)).toBe(1);
  expect(JSON.parse(readFileSync(join(dir, "qualification.json"), "utf8"))).toMatchObject({
    qualified: false,
    exitCode: 1,
  });
});

test("late acknowledgment is read after real child exit, not before the wait", async () => {
  const released = join(fixture(), "released.json");
  // Portable synthetic child models the helper's pipe-close -> ack -> exit order.
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    process.stdin.once('data', () => {
      require('fs').writeFileSync(process.argv[1], JSON.stringify({pid:process.pid,released:true,requested:true}));
      process.exit(0);
    });
    process.stdin.resume();
  `,
      released,
    ],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  try {
    expect(existsSync(released)).toBe(false);
    const settled = settleHolderExit({ kind: "file", child, released });
    child.stdin.end("release");
    const cleanup = await settled;
    expect(cleanup).toMatchObject({ status: "ok", exited: true, acknowledged: true, exitCode: 0 });
    const result = { case: "held-file", qualified: true, reason: null, cleanup };
    expect(retainQualification(fixture(), result)).toBe(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
  }
});
test.each([
  ["missing", null],
  ["malformed", "not json"],
  ["foreign PID", JSON.stringify({ pid: 999, released: true, requested: true })],
  ["not requested", JSON.stringify({ pid: 123, released: true, requested: false })],
  ["not released", JSON.stringify({ pid: 123, released: false, requested: true })],
])("%s release acknowledgment stays unknown", async (_, ack) => {
  const released = join(fixture(), "released.json");
  if (ack !== null) writeFileSync(released, ack);
  const cleanup = await settleHolderExit({
    kind: "file",
    released,
    child: { pid: 123, exitCode: 0, signalCode: null },
  });
  expect(cleanup.status).toBe("unknown");
  expect(retainQualification(fixture(), { case: "held-file", qualified: true, cleanup })).toBe(1);
});

test("complete CLI receipt, output, error and process status are retained", () => {
  const dir = fixture();
  const raw = {
    status: 1,
    signal: null,
    pid: 123,
    stdout: Buffer.from(JSON.stringify(installer)),
    stderr: Buffer.from([0xff, 0x00, 0x0a]),
    error: Object.assign(new Error("spawn failed"), { code: "EIO" }),
  };
  const run = retainCliResult(dir, "cli-1", ["cli.js", "--json"], raw);
  expect(run.receipt).toEqual(installer);
  expect(readFileSync(join(dir, "cli-1.stdout.log"))).toEqual(raw.stdout);
  expect(readFileSync(join(dir, "cli-1.stderr.log"))).toEqual(raw.stderr);
  expect(JSON.parse(readFileSync(join(dir, "cli-1.json"), "utf8"))).toMatchObject({
    status: 1,
    signal: null,
    pid: 123,
    receipt: installer,
    error: { code: "EIO", message: "spawn failed" },
    argv: ["cli.js", "--json"],
  });
});
test("non-JSON CLI output and missing process status remain evidence", () => {
  const dir = fixture();
  const raw = {
    status: null,
    signal: "SIGTERM",
    pid: 123,
    stdout: Buffer.from("partial"),
    stderr: Buffer.from("timeout"),
  };
  expect(retainCliResult(dir, "cli-1", [], raw)).toMatchObject({
    status: null,
    signal: "SIGTERM",
    receipt: null,
    stdout: "partial",
    stderr: "timeout",
  });
});

test.each(["held-file", "held-cwd", "broken-observer"])(
  "%s rejects incomplete capture",
  (caseName) => {
    expect(
      heldCaptureFailure(
        { status: "event-recorded-observers-pending", gaps: ["helper unavailable"] },
        caseName,
      ),
    ).toContain("incomplete");
    expect(
      heldCaptureFailure({ status: "complete", gaps: ["helper unavailable"] }, caseName),
    ).toBeNull();
  },
);
test("broken observer requires an explicit gap even in a complete record", () => {
  expect(heldCaptureFailure({ status: "complete", gaps: [] }, "broken-observer")).toContain(
    "visible gap",
  );
});
test.each(["direct", "installer"])(
  "older replacement %s is a missed precondition, never success",
  (shape) => {
    const receipt =
      shape === "direct"
        ? { ok: false, problem: { code: "conversion_older_program" } }
        : {
            ok: false,
            problem: { code: "vendor_command_failed" },
            limitations: [
              "After the installer exited 2316632107, npm copy conversion failed (conversion_older_program): native is older",
            ],
          };
    expect(conversionPreconditionFailure(receipt, 0)).toContain("precondition not met");
    expect(controlFailure({ ...healthy, run: { ...healthy.run, receipt } })).toContain(
      "precondition not met",
    );
    expect(conversionPreconditionFailure(receipt, 1)).toBeNull();
  },
);
test("an unexplained missing capture is not relabeled as a precondition refusal", () => {
  expect(conversionPreconditionFailure(installer, 0)).toBeNull();
  expect(
    conversionPreconditionFailure(
      {
        ok: false,
        problem: { code: "vendor_command_failed" },
        limitations: ["conversion was refused"],
      },
      0,
    ),
  ).toBeNull();
});
