import { ControlGcReceipt, ControlGcLastResponse } from "@claudexor/schema";
import { claudexorOwnedRoot, CLAUDEXOR_VERSION } from "@claudexor/util";
import { connectDaemonIfRunning, ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";
import { flagBool, type ParsedArgs } from "./args.js";
import { print, printJson } from "./cli-io.js";
import { GC_LOCKSTEP_REPORTS, gcReceiptNotes } from "./gc-receipt-notes.js";

/** Thin client of the daemon-owned retention service (W3.6). */
export async function gcCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const dryRun = flagBool(args, "dry-run") === true;
  if (dryRun && flagBool(args, "last"))
    throw new Error("gc --last cannot be combined with --dry-run");
  if (flagBool(args, "last")) {
    const connection = await connectDaemonIfRunning();
    if (!connection) throw new Error("Daemon is not running; no last retention pass is available.");
    const { addr, engine } = connection;
    const report = engine.engineVersion === CLAUDEXOR_VERSION ? "?retention_report=true" : "";
    const response = await controlApiFetch(addr, `/maintenance/gc${report}`);
    if (!response.ok)
      throw new Error(
        response.status === 404
          ? "This engine does not expose a last retention pass."
          : `gc --last failed (${response.status}): ${await response.text()}`,
      );
    const result = ControlGcLastResponse.parse(await response.json());
    if (json) printJson(result);
    else if (!result.last) print(result.diagnostic ?? "No retention pass has been recorded.");
    else {
      const last = result.last;
      const freed =
        last.effects === "unknown"
          ? `freed at least ${last.freed_bytes} bytes; effects before it stopped are unknown`
          : `freed ${last.freed_bytes} bytes`;
      print(`${last.outcome}: ${last.started_at} to ${last.finished_at}; ${freed}`);
      print(
        `last completed: ${last.last_completed_at ?? "unknown"}; failed/held streak: ${last.failed_or_held_streak}`,
      );
      print(
        `kept ${Object.entries(last.kept)
          .map(([reason, count]) => `${reason}=${count}`)
          .join(" ")}; held roots=${last.held.roots} native_homes=${last.held.native_homes}`,
      );
      for (const hold of last.holds)
        print(`hold ${hold.class}: ${hold.count}; since ${hold.since}; ${hold.example}`);
      print(
        `errors=${last.errors.count}${last.errors.first === null ? "" : `; first: ${last.errors.first}`}`,
      );
    }
    return 0;
  }
  const { addr, engine } = await ensureDaemon();
  // Capability negotiation over the handshake's validated engine identity:
  // request the opt-in receipt reports (data-root scan, thread purges)
  // ONLY from a lockstep daemon (same engine version as this CLI). Any skew —
  // older daemon, newer daemon, or a malformed identity — omits the flags, so
  // both sides exchange the exact pre-feature request/receipt shapes and a
  // strict old schema never rejects the receipt of a mutating verb the daemon
  // already executed.
  const lockstep = engine.engineVersion === CLAUDEXOR_VERSION;
  const response = await controlApiFetch(addr, "/maintenance/gc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dry_run: dryRun, ...(lockstep ? GC_LOCKSTEP_REPORTS : {}) }),
  });
  if (!response.ok) throw new Error(`gc failed (${response.status}): ${await response.text()}`);
  const receipt = ControlGcReceipt.parse(await response.json());
  if (json) {
    printJson(receipt);
    return 0;
  }
  const verb = receipt.dry_run
    ? "would free"
    : receipt.effects === "unknown"
      ? "freed at least"
      : "freed";
  const mb = (receipt.freed_bytes / (1024 * 1024)).toFixed(1);
  print(
    `${verb} ${mb} MiB: ${receipt.deleted_runs.length} run tree(s), ${receipt.deleted_reviews.length} review tree(s) ` +
      `(examined ${receipt.examined_runs}; kept active=${receipt.kept.active} recent=${receipt.kept.recent} young=${receipt.kept.young} ` +
      `referenced=${receipt.kept.referenced} actionable=${receipt.kept.actionable} unknown=${receipt.kept.unknown_state})`,
  );
  for (const note of gcReceiptNotes(receipt, claudexorOwnedRoot())) print(note);
  for (const error of receipt.errors) print(`warning: ${error}`);
  return 0;
}
