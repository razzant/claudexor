import assert from "node:assert/strict";
import { relative } from "node:path";

const busy = /\b(?:EPERM|EBUSY|EACCES)\b/;
export const SHORT_HOLD_MS = 200;
const WINDOW_MS = 2_000;
const prefix = "Windows npm conversion: first rename error ";
const summary =
  /^Windows npm conversion: first rename error (\w+); ([1-9]\d*) attempts; elapsed (0|[1-9]\d*) ms\.$/;

export function requireFixture(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { code: "fixture_gap" });
}

function checkHolder(mode, attempts, holder, ok) {
  if (holder?.gap) requireFixture(false, holder.gap);
  const first = attempts[0];
  const last = attempts.at(-1);
  const { signal, seenMs, closingMs, closedMs, finishedMs } = holder ?? {};
  const times = [first?.deniedMs, first?.returnedMs, seenMs, closingMs, closedMs, finishedMs];
  requireFixture(
    times.every(Number.isSafeInteger) &&
      first.returnedMs >= first.deniedMs &&
      seenMs >= first.deniedMs &&
      closingMs >= seenMs &&
      closedMs >= closingMs &&
      finishedMs >= (last.nextProcessMs ?? last.returnedMs),
    "Incomplete or unordered holder and rename timestamps",
  );
  if (mode === "persistent") {
    requireFixture(
      signal === "update-finished" && seenMs >= finishedMs,
      "Hold ended before cleanup",
    );
    return;
  }
  // The samples bracket CloseHandle in whole milliseconds. A matching
  // millisecond is not evidence of a rename after the handle was closed.
  if (!ok && signal === "first-denial.json")
    assert.ok(
      attempts.slice(1).every((call) => call.startedMs <= closedMs),
      "candidate still refused a rename started after the holder closed",
    );
  // Bracket the actual CloseHandle. Require the short hold after the CLI got
  // its error, including on the control when the CLI has already exited.
  const overlapMs = closingMs - first.returnedMs;
  requireFixture(
    signal === "first-denial.json" &&
      closingMs - seenMs >= SHORT_HOLD_MS &&
      overlapMs >= SHORT_HOLD_MS - 1 &&
      closedMs - first.deniedMs <= 2 * SHORT_HOLD_MS,
    `Short hold outside the qualification window: signal=${signal}, overlap=${overlapMs} ms`,
  );
  requireFixture(
    last.error || last.startedMs > closedMs,
    "Success could not be placed after close",
  );
}

function retryElapsed(limitations, attempts) {
  const records = limitations.filter((line) => line.startsWith(prefix));
  assert.equal(records.length, 1, "expected one conversion timing record");
  const fields = summary.exec(records[0]);
  assert.ok(fields, records[0]);
  assert.equal(fields[1], attempts[0].error.code);
  assert.equal(Number(fields[2]), attempts.length);
  return Number(fields[3]);
}

function checkRetryReceipt(limitations, attempts, mode, ok) {
  const first = attempts[0];
  const last = attempts.at(-1);
  const upper = last.nextProcessMs - first.returnedMs;
  assert.ok(
    attempts.every(
      (call, index) =>
        Number.isSafeInteger(call.startedMs) &&
        Number.isSafeInteger(call.returnedMs) &&
        call.startedMs <= call.returnedMs &&
        (index === 0 || call.startedMs >= attempts[index - 1].returnedMs) &&
        (!call.error ||
          (Number.isSafeInteger(call.deniedMs) &&
            call.startedMs <= call.deniedMs &&
            call.deniedMs <= call.returnedMs)),
    ) &&
      Number.isSafeInteger(last.nextProcessMs) &&
      last.nextProcessMs >= last.returnedMs,
    "unsubstantiated retry duration",
  );
  assert.ok(
    attempts.slice(0, -1).every((call) => call.nextProcessMs === undefined),
    "started another process between forward renames",
  );

  // The product starts its timer after the observer returns the first error
  // and before it reaches any retry (or the next probe if there was no retry).
  // Its final sample is after the last return and before the next probe.
  const latestStartMs = attempts[1]?.startedMs ?? last.nextProcessMs;
  const spanMs = attempts.length === 1 ? 0 : last.startedMs - first.returnedMs;
  // Independently observe a spaced retry, not an immediate pair then idling.
  if (mode === "persistent" && attempts.length > 1)
    assert.ok(spanMs >= WINDOW_MS / 2, "no real retry in the second half of the observed window");
  if (attempts.length > 1)
    assert.ok(
      last.startedMs - latestStartMs <= WINDOW_MS + 1,
      "started a rename outside the 2s budget",
    );
  const elapsedMs = retryElapsed(limitations, attempts);
  // Subtract at most one integer millisecond for floored observations versus
  // the rounded receipt. An exhausted timer must still cover the full 2s.
  const lower = Math.max(last.returnedMs - latestStartMs - 1, ok ? 1 : WINDOW_MS);
  assert.ok(
    elapsedMs >= lower && elapsedMs <= upper + 1,
    `reported ${elapsedMs} ms outside retry bounds ${lower}–${upper + 1} ms`,
  );
  // These records could fit only with an unmeasured late timer start. Do not
  // contradict the receipt, but do not qualify the candidate on that basis.
  let gap = null;
  if (spanMs > WINDOW_MS + 1) gap = "Retry start could not be placed within the 2s budget";
  else if (elapsedMs < last.returnedMs - first.returnedMs - 1)
    gap = `Reported ${elapsedMs} ms fits only if the product timer started later than the first observed return`;
  return { upper, gap };
}

export function checkConversion(subject, mode, promoted, run, attempts, holder) {
  const { receipt } = run;
  assert.equal(run.error, null);
  assert.equal(run.signal, null);
  const { ok } = receipt;
  assert.equal(typeof ok, "boolean");
  assert.equal(run.status, ok ? 0 : 17);
  assert.equal(receipt.exitCode, 17, "fixture installer exit must survive conversion");
  assert.equal(receipt.commands.length, 1);
  assert.equal(receipt.outcome, ok ? "changed" : "not_changed");
  assert.equal(receipt.mutation, ok ? "applied" : "unknown");
  if (!ok) assert.equal(receipt.problem?.code, "vendor_command_failed");
  assert.ok(attempts.length > 0, "never reached the old package's forward rename");
  for (const call of attempts) assert.equal(call.observerError, undefined);
  if (mode === "healthy") {
    assert.equal(ok, promoted);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].error, undefined);
    assert.ok(!receipt.limitations.some((line) => busy.test(line) && /attempt|retry/i.test(line)));
    return;
  }
  const denied = ok ? attempts.slice(0, -1) : attempts;
  assert.ok(denied.length > 0);
  for (const call of denied) {
    assert.equal(call.error?.syscall, "rename");
    assert.match(call.error.code, /^(?:EPERM|EBUSY|EACCES)$/, call.error.message);
    assert.equal(relative(call.from, call.error.path), "");
    assert.equal(relative(call.to, call.error.dest), "");
  }
  if (ok) assert.equal(attempts.at(-1).error, undefined);
  else {
    // The error must reach the user, not just the observer or timing line.
    const { code, syscall, path, dest, message } = attempts[0].error;
    assert.ok([code, syscall, path, dest].every((part) => message.includes(part)));
    assert.ok(
      receipt.limitations.some((line) => !line.startsWith(prefix) && line.includes(message)),
      "missing original conversion error in receipt",
    );
  }
  if (subject === "control") {
    assert.equal(attempts.length, 1);
    assert.equal(ok, promoted);
    checkHolder(mode, attempts, holder, ok);
    return;
  }
  if (mode === "persistent") assert.equal(ok, promoted);
  const { upper, gap } = checkRetryReceipt(receipt.limitations, attempts, mode, ok);
  checkHolder(mode, attempts, holder, ok);
  requireFixture(!gap, gap);
  requireFixture(
    upper <= WINDOW_MS + SHORT_HOLD_MS,
    "Next probe did not bound the decision in time",
  );
  // A valid receipt covers the full window, but does not prove that the
  // runner let the CLI start a rename after the holder released it.
  requireFixture(
    ok || (mode === "persistent" && attempts.length > 1),
    mode === "release"
      ? "Retry window elapsed without a rename observed after release; scheduling opportunity unknown"
      : "No second rename observed before the retry deadline; scheduling opportunity unknown",
  );
  assert.equal(ok, promoted);
}

export function checkSelection(actual, path, version) {
  assert.equal(actual?.version, version);
  assert.equal(relative(path, actual.path), "");
  assert.equal(relative(path, actual.realPath), "");
  assert.equal(actual.overrideValue, null);
}

// These facts remain checkable even if the Windows holder misses its timing.
export function checkConversionEffects(paths, update, after, disk, transcript, versionArgs) {
  const { ok, before, after: reported, commands } = update.receipt;
  assert.equal(typeof ok, "boolean");
  assert.equal(after.status, 0, after.stderr);
  const selected = ok ? [paths.vendor, "1.0.114"] : [paths.old, "1.0.113"];
  checkSelection(after.receipt.harnesses[0].selection, ...selected);
  checkSelection(before, paths.old, "1.0.113");
  checkSelection(reported, ...selected);
  assert.deepEqual(disk, { pkg: !ok, shim: !ok, sibling: false });
  const installer = relative(paths.home, paths.installer).toLowerCase();
  const installs = transcript.filter(([image]) => image === installer);
  assert.equal(installs.length, 1, "actual synthetic installer invocations");
  assert.deepEqual(installs[0].slice(1), commands[0].args);
  for (const [image, ...args] of transcript) {
    if (image !== installer) assert.deepEqual(args, versionArgs, "unexpected program invocation");
  }
}

export function checkConversionBaseline(mode, transcript, baseline) {
  const controlMode = mode === "persistent" ? "release" : "healthy";
  requireFixture(
    baseline[controlMode] !== undefined,
    `No qualified ${controlMode} control for process comparison`,
  );
  assert.deepEqual(
    transcript,
    baseline[controlMode],
    "version probes and installer must match the old CLI for the same final selection",
  );
}
