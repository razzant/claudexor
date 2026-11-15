// TEST-ONLY reducers and evidence used by the native Windows qualifier.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const normalize = (value) =>
  String(value ?? "")
    .replaceAll("\\", "/")
    .toLowerCase();

export function receiptCauseIsConversionEperm(receipt, record, packageRoot) {
  if (receipt?.ok !== false || record?.error?.code !== "EPERM") return false;
  const from = normalize(record.from);
  const to = normalize(record.to);
  if (from !== normalize(packageRoot) || to !== `${from}.claudexor-converted`) return false;
  const cause = normalize(record.error.message);
  if (
    !cause ||
    !/\beperm\b/.test(cause) ||
    !/\brename\b/.test(cause) ||
    !cause.includes(from) ||
    !cause.includes(to)
  )
    return false;
  // harness-maintenance preserves the hide error directly when the installer
  // succeeded, otherwise it retains the installer problem plus this limitation.
  if (receipt.problem?.code === "EPERM") return normalize(receipt.problem.message).includes(cause);
  return (
    receipt.problem?.code === "vendor_command_failed" &&
    Array.isArray(receipt.limitations) &&
    receipt.limitations.some(
      (line) =>
        /^After the installer exited .+, npm copy conversion failed \(EPERM\): /.test(line) &&
        normalize(line).includes(cause),
    )
  );
}

// This typed product refusal occurs before hideProgramPaths. Keep a missed
// experimental precondition distinct from a missing capture; neither qualifies.
export function conversionPreconditionFailure(receipt, captureCount) {
  if (captureCount !== 0 || receipt?.ok !== false) return null;
  const older =
    receipt.problem?.code === "conversion_older_program" ||
    (receipt.problem?.code === "vendor_command_failed" &&
      receipt.limitations?.some((line) =>
        /^After the installer exited .+, npm copy conversion failed \(conversion_older_program\): /.test(
          line,
        ),
      ));
  return older
    ? "precondition not met: conversion_older_program refused before hide; capture not exercised"
    : null;
}

export function heldCaptureFailure(record, caseName) {
  if (record.status !== "complete") return "capture incomplete: observers did not finish";
  if (
    caseName === "broken-observer" &&
    !(
      Array.isArray(record.gaps) &&
      record.gaps.some((gap) => /unavailable|absent|sha256|changed/i.test(String(gap)))
    )
  )
    return "broken observer did not record a visible gap";
  return null;
}

export function controlFailure({
  run,
  packagePresent,
  hiddenPresent,
  remainingLaunchers,
  captureCount,
}) {
  const precondition = conversionPreconditionFailure(run.receipt, captureCount);
  if (precondition) return precondition;
  if (
    run.error ||
    run.signal ||
    run.status !== 0 ||
    run.receipt?.ok !== true ||
    run.receipt?.outcome !== "changed" ||
    run.receipt?.mutation !== "applied"
  )
    return "healthy conversion did not apply";
  if (packagePresent || hiddenPresent)
    return "npm package or hidden sibling still present after conversion";
  // Windows ownership in harness-npm-conversion is the resolved .cmd only.
  if (remainingLaunchers.includes("copilot.cmd")) return "product-owned copilot.cmd not retired";
  if (captureCount !== 0) return `healthy conversion wrote ${captureCount} capture file(s)`;
  return null;
}

export async function waitForExit(child, timeoutMs = 20_000) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolve) => {
    const done = (exited) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once("exit", onExit);
  });
}

// Called after the release request. The file helper closes its pipe BEFORE
// writing the acknowledgment; only the bounded exit wait precedes that read.
export async function settleHolderExit(holder) {
  const cleanup = { kind: holder.kind, acknowledged: false };
  cleanup.exited = await waitForExit(holder.child);
  if (!cleanup.exited) {
    try {
      holder.child.kill();
    } catch {
      /* only our measured child */
    }
    cleanup.exited = await waitForExit(holder.child, 5_000);
    cleanup.forced = true;
  }
  cleanup.exitCode = holder.child.exitCode;
  cleanup.signal = holder.child.signalCode;
  if (holder.kind === "file") {
    try {
      cleanup.acknowledgmentRaw = readFileSync(holder.released, "utf8");
      cleanup.acknowledgment = JSON.parse(cleanup.acknowledgmentRaw);
      const ack = cleanup.acknowledgment;
      cleanup.acknowledged =
        ack.pid === holder.child.pid && ack.released === true && ack.requested === true;
    } catch (error) {
      cleanup.acknowledgmentError = String(error);
    }
  } else {
    cleanup.acknowledged = cleanup.exited && cleanup.exitCode === 0;
  }
  cleanup.status =
    cleanup.exited &&
    cleanup.acknowledged &&
    cleanup.exitCode === 0 &&
    !cleanup.signal &&
    !cleanup.forced
      ? "ok"
      : "unknown";
  return cleanup;
}

export function retainCliResult(evidence, id, argv, raw) {
  const stdout = raw.stdout?.toString("utf8") ?? "";
  const stderr = raw.stderr?.toString("utf8") ?? "";
  let receipt = null;
  try {
    receipt = JSON.parse(stdout);
  } catch {
    /* retain non-JSON stdout too */
  }
  const error = raw.error
    ? Object.fromEntries(Object.getOwnPropertyNames(raw.error).map((key) => [key, raw.error[key]]))
    : null;
  const run = {
    argv,
    status: raw.status,
    signal: raw.signal,
    pid: raw.pid,
    error,
    stdout,
    stderr,
    receipt,
  };
  writeFileSync(join(evidence, `${id}.stdout.log`), raw.stdout ?? "");
  writeFileSync(join(evidence, `${id}.stderr.log`), raw.stderr ?? "");
  writeFileSync(join(evidence, `${id}.json`), JSON.stringify(run, null, 2) + "\n");
  return run;
}

export function retainQualification(evidence, result) {
  if (result.case !== "control" && result.cleanup.status !== "ok") {
    result.qualified = false;
    result.reason = [result.reason, `holder cleanup ${result.cleanup.status ?? "unknown"}`]
      .filter(Boolean)
      .join("; ");
  }
  const exitCode = result.qualified ? 0 : 1;
  writeFileSync(
    join(evidence, "qualification.json"),
    JSON.stringify({ ...result, exitCode }, null, 2) + "\n",
  );
  return exitCode;
}
