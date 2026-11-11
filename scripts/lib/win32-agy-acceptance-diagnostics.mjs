import { existsSync, readFileSync } from "node:fs";
import { constants } from "node:os";

/** Failure facts the Win32 agy acceptance worker and its test keep, and the
 * worker's in-app outcome check that records them first. Every fact is
 * allowlisted and typed: raw output, the OAuth URL and the one-shot input never
 * enter them, and a process probe that could not decide never counts as gone
 * or alive. */

/** The in-app job's input, state and receipt sidecars, read without throwing. */
export function readInAppSidecars(paths) {
  return {
    input: readJsonSidecar(paths.input),
    state: readJsonSidecar(paths.state),
    receipt: readJsonSidecar(paths.receipt),
  };
}

/** Allowlisted facts of those sidecars. The closed vocabularies come from the
 * schema (`errorCodes` for the receipt, `stages` for the runner state); any
 * other value reads as "unrecognized". */
export function inAppSidecarFacts({ input, state, receipt }, { errorCodes, stages }) {
  const inputValue = jsonObject(input.value);
  const stateValue = jsonObject(state.value);
  const receiptValue = jsonObject(receipt.value);
  return {
    input: {
      exists: input.exists,
      readable: inputValue !== null,
      consumed: inputValue?.consumed === true,
      valueRetained: inputValue !== null && Object.hasOwn(inputValue, "value"),
    },
    state: {
      exists: state.exists,
      readable: stateValue !== null,
      stage: stateValue === null ? null : closed(stateValue.stage, stages),
    },
    receipt: {
      exists: receipt.exists,
      readable: receiptValue !== null,
      commandStarted:
        typeof receiptValue?.commandStarted === "boolean" ? receiptValue.commandStarted : null,
      exitCode: Number.isSafeInteger(receiptValue?.exitCode) ? receiptValue.exitCode : null,
      signal:
        typeof receiptValue?.signal === "string"
          ? closed(receiptValue.signal, Object.keys(constants.signals))
          : null,
      errorCode:
        receiptValue === null || receiptValue.errorCode === undefined
          ? null
          : closed(receiptValue.errorCode, errorCodes),
    },
  };
}

/** The worker's in-app outcome check. It awaits the runner itself, so the
 * worker never holds the exit before its facts are kept: exit facts first, then
 * sidecar facts and whether the strict decoder accepted the receipt, then
 * `persist`, and only then the checks. Returns the exit and decoded receipt. */
export async function settleInAppOutcome({
  finished,
  diagnostics,
  paths,
  decodeReceipt,
  vocabulary,
  persist,
}) {
  const exit = await finished;
  diagnostics.runnerExit = { code: exit.code, signal: exit.signal };
  diagnostics.sidecars = inAppSidecarFacts(readInAppSidecars(paths), vocabulary);
  const receipt = decodeReceipt(paths.receipt);
  diagnostics.sidecars.receipt.decoded = receipt !== null;
  persist();
  check(exit.code === 0, `in-app runner exited ${String(exit.code)}`);
  check(exit.signal === null, "in-app runner exited by signal");
  check(receipt?.commandStarted === true, "in-app receipt did not validate helper start");
  check(receipt?.exitCode === 0, "in-app receipt did not preserve native exit 0");
  check(receipt?.signal === null, "in-app receipt recorded a signal");
  check(receipt?.errorCode === undefined, "in-app receipt recorded a transport error");
  check(receipt?.outputTail === undefined, "successful in-app receipt retained output");
  return { exit, receipt };
}

/** Sidecar facts for a failure message. The worker's capture wins over the
 * test's later read: it was taken when the runner exited, before the worker's
 * own cleanup removed any sidecar. */
export function preferCapturedSidecars(captured, late) {
  return Object.fromEntries(
    Object.entries(late).map(([name, facts]) => [
      name,
      captured?.[name] ? { source: "worker", ...captured[name] } : { source: "test", ...facts },
    ]),
  );
}

/** One existence probe of a recorded process. */
export function probeProcess(pid) {
  try {
    process.kill(pid, 0);
    return { state: "alive" };
  } catch (error) {
    return probeFailure(error);
  }
}

/** ESRCH proves a process gone; any other probe failure (EPERM, ...) is
 * unknown and proves neither. */
export function probeFailure(error) {
  const code = typeof error?.code === "string" ? error.code : "unknown";
  return code === "ESRCH" ? { state: "gone" } : { state: "unknown", code };
}

/** Recorded processes the probe does not prove gone, each PID once with all
 * of its roles. */
export function remainingProcesses(processes, probe) {
  const roles = new Map();
  for (const { pid, role } of processes) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const pidRoles = roles.get(pid) ?? [];
    if (!pidRoles.includes(role)) pidRoles.push(role);
    roles.set(pid, pidRoles);
  }
  return [...roles].flatMap(([pid, pidRoles]) => {
    const outcome = probe(pid);
    return outcome.state === "gone" ? [] : [{ pid, roles: pidRoles, ...outcome }];
  });
}

export function describeRemaining(remaining) {
  return remaining
    .map(
      ({ pid, roles, state, code }) =>
        `${pid} ${state}${code ? ` ${code}` : ""} (${roles.join(", ")})`,
    )
    .join("; ");
}

function readJsonSidecar(path) {
  try {
    return { exists: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { exists: existsSync(path), value: null };
  }
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function jsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function closed(value, vocabulary) {
  return vocabulary.includes(value) ? value : "unrecognized";
}
