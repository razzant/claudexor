/**
 * Controller-side first install of the SSH runtime (`claudexor remote
 * install`): the confirmed write after the read-only remote-host-preflight.ts.
 *
 * `install` pins every later ssh call to the host keys its first read showed,
 * reads again over that pin and writes only while that host is still empty
 * with the confirmed digest. It then makes ONE writing step: its shell first
 * proves the confirmed hostname, platform, uid, user and home, then runs the
 * shared transaction its command carries, whose only input is the signed
 * archive: the transaction writes it into this install's own token-named file,
 * owns it from its first byte and removes it whenever it ends. The directory
 * and pointer carry the same token,
 * so no other client's install is read, removed or claimed. It starts no
 * daemon or login and ends with a read-only identity check.
 *
 * `activated: false` is reported only where that is proven: a failure before
 * the writing step started, the step's recipient refusal, or the transaction's
 * own refusal line for this install's pointer. Activation is proven by the
 * transaction's receipt or by a confirmed read that shows that pointer.
 * Anything else, a broken stream included, is `install_outcome_unknown` with
 * everything a later read must show (PROVE); it is never retried.
 */
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { canonicalJson } from "@claudexor/util";
import { CliError } from "./cli-error.js";
import {
  type HostFacts,
  UNREAD,
  errorText,
  readHostFacts,
  remoteHostFailure,
  runtimeFiles,
} from "./remote-host-facts.js";
import {
  AGAIN,
  type Observation,
  type RemoteHostDeps,
  type RemoteHostRuntime,
  type RemoteHostServer,
  bound,
  observeRemoteHost,
  serverOf,
  stopIfCancelled,
} from "./remote-host-preflight.js";
import { type SignedRelease, downloadVerifiedArchive } from "./remote-host-release.js";
import {
  type ConfirmedRecipient,
  INSTALL_REFUSALS,
  type InstallRefusal,
  RECIPIENT_MISMATCH,
  activationReceipt,
  installCommand,
  installPointer,
  refusalReceipt,
} from "./remote-host-scripts.js";
import {
  CANCELLED,
  type SshRunResult,
  type SshTransport,
  stderrExcerpt,
} from "./remote-host-transport.js";

export interface RemoteHostInstalled {
  ok: true;
  outcome: "installed";
  destination: string;
  server: RemoteHostServer;
  runtime: RemoteHostRuntime;
}

/** The writing step streams the archive (up to an hour), then runs the
 * transaction (up to a quarter of an hour). */
const INSTALL_STEP_TIMEOUT_MS = 75 * 60_000;
/** After an unseen outcome, a fresh read proves this install only as a whole:
 * never from the pointer or a matching version alone. */
const PROVE =
  "Run `claudexor remote preflight <destination> --json` again: this install completed only if that answer shows exactly context.server (host keys, user, uid, home) and state installed with exactly context.runtime, its pointer included.";

/** What one confirmed install must find again: that server and account, and
 * that exact runtime under this install's own pointer. */
interface Expected {
  server: RemoteHostServer;
  runtime: RemoteHostRuntime;
}

/** Nothing is written unless this read shows the confirmed, still empty host. */
function requireConfirmed(observed: Observation, digest: string): SignedRelease {
  const { view, release } = observed;
  if (view.state === "empty" && view.digest === digest && release) return release;
  // No new digest here: a changed host goes back to the person who confirms,
  // through a fresh preflight, never into a blind retry.
  const context = { state: view.state, ...(view.problem ? { problem: view.problem.code } : {}) };
  if (view.problem?.code === "release_unavailable") {
    // Not reading the release says nothing about it or the server: the same
    // confirmation stays valid and can run again.
    const message = `${view.problem.message}; nothing was changed`;
    throw remoteHostFailure("release_unavailable", message, { retryable: true, context });
  }
  throw remoteHostFailure(
    "preflight_changed",
    "the server, its runtime or the release no longer match the confirmed preflight; nothing was changed",
    { context, requiredActions: [AGAIN] },
  );
}

/** Before the writing step starts, nothing on the server is this install's: a
 * refusal from that phase says so, so no client infers it from a missing
 * field. An unexpected error, which is no typed refusal, makes no claim.
 * remote-command.ts applies it to a transport it could not build. */
export function notActivated(error: unknown): unknown {
  if (!(error instanceof CliError) || error.context?.["activated"] !== undefined) return error;
  return new CliError(error.category, error.message, {
    code: error.code,
    retryable: error.retryable,
    fieldErrors: error.fieldErrors,
    requiredActions: error.requiredActions,
    details: error.details,
    context: { ...error.context, activated: false },
  });
}

function sshContext(result: SshRunResult): Record<string, unknown> {
  return {
    // This client stopped the call; what the server did is still unknown.
    ...(result.localFailure === CANCELLED ? { cancelled: true } : {}),
    ...(result.localFailure ? { localFailure: result.localFailure } : {}),
    ...(result.status !== null ? { exitCode: result.status } : {}),
    stderr: stderrExcerpt(result),
  };
}

/** Whole lines only: a line the stream cut off matches no receipt. */
function stdoutLines(result: SshRunResult): string[] {
  return result.stdout.toString("utf8").split("\n");
}

/** A step whose effect on the host this client did not see. The context
 * carries everything a later read must show to prove this install (PROVE). */
function outcomeUnknown(
  step: "install" | "verify",
  expected: Expected,
  context: Record<string, unknown>,
) {
  const pointer = expected.runtime.pointer;
  const open =
    step === "verify"
      ? `this install activated ${pointer}, and its read-only check did not settle`
      : `whether this install activated ${pointer} is unknown`;
  return remoteHostFailure(
    "install_outcome_unknown",
    `the result of the ${step} step is unknown; ${open}; Claudexor does not repeat the install`,
    { context: { step, pointer, ...context, ...expected }, requiredActions: [PROVE] },
  );
}

/** The writing step's own refusal: it did not run on the confirmed server as
 * the confirmed account, so it read and wrote nothing. */
function recipientRefused(result: SshRunResult): boolean {
  return result.status === 77 && stdoutLines(result).includes(RECIPIENT_MISMATCH);
}

function recipientChanged() {
  return remoteHostFailure(
    "preflight_changed",
    "the install step did not reach the confirmed server and account (hostname, platform, uid, user, home); it wrote nothing",
    {
      context: { step: "install", activated: false, recipient: "changed" },
      requiredActions: [AGAIN],
    },
  );
}

/** A read after the write is taken literally, and only as the confirmed
 * server and account: the pin proves the host, these facts the login. */
async function readConfirmed(
  transport: SshTransport,
  expected: Expected,
  step: "install" | "verify",
  context: Record<string, unknown>,
): Promise<HostFacts> {
  let facts: HostFacts;
  try {
    facts = await readHostFacts(transport);
  } catch (error) {
    throw outcomeUnknown(step, expected, { ...context, reread: errorText(error) });
  }
  if (canonicalJson(serverOf(facts)) !== canonicalJson(expected.server)) {
    throw outcomeUnknown(step, expected, { ...context, reread: "another account answered" });
  }
  return facts;
}

/** The transaction's own refusal for this pointer: it stopped before starting
 * activation, so it activated nothing (exit status aside). */
function refused(reason: InstallRefusal, result: SshRunResult): CliError {
  const context = { step: "install", activated: false, reason, ...sshContext(result) };
  if (reason === "locked") {
    return remoteHostFailure(
      "install_in_progress",
      "another install holds the server's install lock; this install activated nothing",
      { context, requiredActions: [AGAIN] },
    );
  }
  if (reason === "changed") {
    return remoteHostFailure(
      "preflight_changed",
      "another runtime is now on the server; this install activated nothing and claims none",
      { context, requiredActions: [AGAIN] },
    );
  }
  const exit = result.status !== null ? ` (exit ${result.status})` : "";
  return remoteHostFailure(
    "install_failed",
    `the install transaction refused${exit}; it activated nothing`,
    { context, requiredActions: [AGAIN] },
  );
}

/**
 * Returns only when THIS install activated its pointer: its transaction
 * printed the receipt that follows activation (null: nothing read yet), or a
 * confirmed read shows that pointer, which no other client names (that read,
 * reused by the check). A refusal counts only when the transaction printed it
 * for this pointer. Any other answer is unknown, whatever the server shows now:
 * a broken stream, a held lock or another runtime there does not prove that
 * this install did not activate before them.
 */
async function settleInstall(
  deps: RemoteHostDeps,
  transport: SshTransport,
  expected: Expected,
  result: SshRunResult,
): Promise<HostFacts | null> {
  const pointer = expected.runtime.pointer;
  const lines = stdoutLines(result);
  if (lines.includes(activationReceipt(pointer))) return null;
  if (recipientRefused(result)) throw recipientChanged();
  const refusal = INSTALL_REFUSALS.find((why) => lines.includes(refusalReceipt(pointer, why)));
  if (refusal) throw refused(refusal, result);
  // Cancelled: no settling read starts, so the install's effect stays unknown.
  if (deps.signal?.aborted) {
    throw outcomeUnknown("install", expected, { cancelled: true, ...sshContext(result) });
  }
  const after = await readConfirmed(transport, expected, "install", sshContext(result));
  const current = after.current;
  if (current.kind === "link" && current.target === pointer) return after;
  throw outcomeUnknown("install", expected, {
    observed: current.kind,
    lock: after.lock,
    ...sshContext(result),
  });
}

/** The read-only check that ends an install, on a confirmed read that shows
 * this install's own pointer: no other install holds the lock, and the files
 * there declare the signed identity (the transaction already ran this
 * archive's own probe before activating it). Each file read whole is a fact on
 * its own: one that contradicts the signed identity fails the install, whatever
 * the other read showed. A file that could not be read leaves the proven
 * activation's result unknown, never failed, and a read that could not
 * complete never gets here (readConfirmed leaves it unknown). Nothing is
 * started or changed. */
function verifyInstalled(facts: HostFacts, expected: Expected): void {
  const { runtime } = expected;
  const current = facts.current;
  if (facts.lock || current.kind !== "link" || current.target !== runtime.pointer) {
    throw outcomeUnknown("verify", expected, {
      activated: true,
      observed: current.kind === "link" ? current.target : current.kind,
      lock: facts.lock,
    });
  }
  const { meta, marker } = runtimeFiles(current);
  const unread = [
    ...(meta === UNREAD ? ["runtime.json"] : []),
    ...(marker === UNREAD ? [".archive-sha256"] : []),
  ];
  const identity = meta === UNREAD ? null : meta;
  if (
    meta === null ||
    marker === false ||
    (identity !== null &&
      (identity.version !== runtime.version ||
        identity.buildSha !== runtime.buildSha ||
        identity.protocolMajor !== runtime.protocolMajor ||
        identity.target !== runtime.target))
  ) {
    throw remoteHostFailure(
      "install_failed",
      `this install activated ${runtime.pointer}, but it does not report the signed identity; it was left in place and nothing was started`,
      {
        context: {
          step: "verify",
          activated: true,
          pointer: runtime.pointer,
          observed: identity,
          ...(unread.length > 0 ? { unread } : {}),
        },
        requiredActions: [AGAIN],
      },
    );
  }
  if (unread.length > 0) throw outcomeUnknown("verify", expected, { activated: true, unread });
}

/** A read over the pinned keys that does not answer: nothing was written. */
function identityUnconfirmed(error: unknown): CliError {
  return remoteHostFailure(
    "host_identity_unconfirmed",
    `the server did not answer over the SSH host keys the confirmed preflight showed (${errorText(error)}); nothing was written`,
    { requiredActions: [AGAIN] },
  );
}

/** The one confirmed mutation: install the signed runtime the preflight showed. */
export async function installRemoteHost(
  destination: string,
  digest: string,
  deps: RemoteHostDeps,
): Promise<RemoteHostInstalled> {
  const writing = { started: false };
  try {
    return await confirmAndInstall(destination, digest, deps, writing);
  } catch (error) {
    throw writing.started ? error : notActivated(error);
  }
}

async function confirmAndInstall(
  destination: string,
  digest: string,
  deps: RemoteHostDeps,
  writing: { started: boolean },
): Promise<RemoteHostInstalled> {
  const first = await observeRemoteHost(destination, deps, deps.transport);
  requireConfirmed(first, digest);
  const pinned = deps.transport.pinned(
    first.facts.hostKeys.map((key) => `${key.type} ${key.blob}`),
  );
  let archive: { dir: string; file: string } | undefined;
  try {
    const transport = bound(deps, pinned);
    // The decision is read again over the pin, so the server that is checked
    // is the one the writing step reaches.
    let confirmed: Observation;
    try {
      confirmed = await observeRemoteHost(destination, deps, transport, first.release);
    } catch (error) {
      if (error instanceof CliError && error.code === "ssh_unavailable") {
        throw identityUnconfirmed(error);
      }
      throw error;
    }
    const { manifest, asset } = requireConfirmed(confirmed, digest);
    const server = confirmed.view.server;
    const { uid, user, home, hostname } = server;
    const { os, machine } = confirmed.facts;
    const recipient: ConfirmedRecipient = { uid, user, home, hostname, os, machine };
    const flow = randomBytes(16).toString("hex");
    const runtime: RemoteHostRuntime = {
      version: manifest.version,
      buildSha: manifest.buildSha,
      protocolMajor: manifest.protocolMajor,
      target: asset.target,
      pointer: installPointer(manifest.version, asset.sha256, flow),
    };
    const expected: Expected = { server, runtime };
    let downloaded: { dir: string; file: string };
    try {
      downloaded = await downloadVerifiedArchive(asset, deps);
    } catch (error) {
      // An aborted download is this client's stop, never a property of the release.
      stopIfCancelled(deps, "install", "nothing_written");
      throw error;
    }
    archive = downloaded;
    stopIfCancelled(deps, "install", "nothing_written");
    writing.started = true;
    const result = await transport.run(
      installCommand(recipient, manifest.version, asset.sha256, flow),
      { file: downloaded.file, timeoutMs: INSTALL_STEP_TIMEOUT_MS },
    );
    const shown = await settleInstall(deps, transport, expected, result);
    if (!shown && deps.signal?.aborted) {
      // Activated, and no read has shown it yet: only the check is undone.
      throw outcomeUnknown("verify", expected, { activated: true, cancelled: true });
    }
    // A confirmed read that already showed this pointer is complete: a later
    // cancellation changes nothing, and nothing is read twice.
    verifyInstalled(
      shown ?? (await readConfirmed(transport, expected, "verify", { activated: true })),
      expected,
    );
    return { ok: true, outcome: "installed", destination, server, runtime };
  } finally {
    pinned.close();
    if (archive) removeQuietly(archive.dir);
  }
}

/** The local copy of the archive: a removal that fails must not replace the
 * install's own outcome with its error. */
function removeQuietly(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* left for the system's temporary cleanup */
  }
}
