import { randomUUID } from "node:crypto";
import { ControlHeldPreparations, ControlPreparationReleaseReceipt } from "@claudexor/schema";
import { connectDaemonIfRunning } from "./daemon-run.js";
import { controlApiFetch, type ControlApiAddress } from "./live.js";
import { flagBool, flagStr, type ParsedArgs } from "./args.js";
import { print, printJson } from "./cli-io.js";

/**
 * `gc preparations` and `gc release-preparation` (#694 r17): thin clients of the
 * daemon's held preparation maintenance. Nothing is confirmed without the
 * explicit `--confirm-ended` and the digest the inspection showed. The release is
 * one durable daemon operation keyed by `--idempotency-key` (a new key when none
 * is given, printed to stderr before the request): repeating the same key
 * answers that request's recorded receipt instead of running again. Returns
 * null for any other gc verb.
 */
export async function gcPreparationsCommand(
  args: ParsedArgs,
  json: boolean,
): Promise<number | null> {
  const verb = args._[1];
  if (verb !== "preparations" && verb !== "release-preparation") return null;
  for (const flag of ["dry-run", "last"])
    if (flagBool(args, flag)) throw new Error(`gc ${verb} cannot be combined with --${flag}`);
  if (
    verb === "preparations" &&
    (flagStr(args, "digest") || flagBool(args, "confirm-ended") || flagStr(args, "idempotency-key"))
  )
    throw new Error(
      "gc preparations only reads: --digest, --confirm-ended and --idempotency-key belong to gc release-preparation",
    );
  const connection = await connectDaemonIfRunning();
  if (!connection) throw new Error("Daemon is not running; held preparations are read through it.");
  if (verb === "preparations") return listHeld(connection.addr, json);
  const digest = flagStr(args, "digest");
  if (!digest)
    throw new Error("gc release-preparation needs --digest <sha256> from gc preparations");
  if (!flagBool(args, "confirm-ended"))
    throw new Error(
      "gc release-preparation needs --confirm-ended: confirm that you checked the held preparation's processes and their children have ended",
    );
  const key = flagStr(args, "idempotency-key") ?? `preparation-release-${randomUUID()}`;
  // Before the request: a lost answer is read back by repeating this exact key.
  process.stderr.write(
    `operation key: ${key} (repeat with --idempotency-key ${key} to read this request's recorded outcome)\n`,
  );
  const response = await controlApiFetch(connection.addr, "/maintenance/preparations/release", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ selector: args._[2], digest, confirm_processes_ended: true }),
  });
  if (!response.ok)
    throw new Error(`gc release-preparation failed (${response.status}): ${await response.text()}`);
  const receipt = ControlPreparationReleaseReceipt.parse(await response.json());
  if (json) printJson(receipt);
  else {
    print(
      `${receipt.outcome}: ${receipt.kind} ${receipt.path}${receipt.basis ? ` (${receipt.basis}${receipt.continued ? ", continued" : ""})` : ""}`,
    );
    for (const reason of receipt.reasons) print(`  reason: ${reason}`);
    if (receipt.cleanup_error) print(`  cleanup error: ${receipt.cleanup_error}`);
    if (receipt.writer)
      print(
        `  writer pid ${receipt.writer.pid}: ${receipt.writer.outcome}${receipt.writer.detail ? ` (${receipt.writer.detail})` : ""}`,
      );
    print(`  remains: ${receipt.remains}`);
    print(
      `  operation ${receipt.operation_id}${receipt.replayed ? ": the recorded receipt of an earlier request with this key, not a new release" : ""}`,
    );
    print(`  ${receipt.note}`);
  }
  return receipt.outcome === "released" || receipt.outcome === "completed" ? 0 : 1;
}

async function listHeld(addr: ControlApiAddress, json: boolean): Promise<number> {
  const response = await controlApiFetch(addr, "/maintenance/preparations");
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? "This engine does not expose held preparations."
        : `gc preparations failed (${response.status}): ${await response.text()}`,
    );
  const held = ControlHeldPreparations.parse(await response.json());
  if (json) {
    printJson(held);
    return 0;
  }
  if (held.preparations.length === 0)
    print(`No held preparations under ${held.roots} known roots.`);
  for (const item of held.preparations) {
    print(`${item.kind} ${item.path}`);
    print(`  selector: ${item.selector}`);
    print(`  digest:   ${item.digest}`);
    if (item.stop) print(`  stop: ${item.stop.reason} since ${item.since ?? "unknown"}`);
    else
      print(
        `  no stop recorded (a crash or an unfinished preparation) since ${item.since ?? "unknown"}`,
      );
    print(
      `  read now: ${item.read.status}${item.read.reasons.length ? ` (${item.read.reasons.join("; ")})` : ""}${item.read.unproven ? `; unproven: ${item.read.unproven}` : ""}`,
    );
    print(`  release needs: ${item.release}${item.refusal ? ` (${item.refusal})` : ""}`);
    if (item.operator_release)
      print(`  confirmed earlier at ${item.operator_release.confirmed_at}: its cleanup continues`);
    if (item.cleanup_error) print(`  last cleanup error: ${item.cleanup_error}`);
    print(`  on release: ${item.on_release}`);
  }
  for (const error of held.errors) print(`warning: ${error}`);
  if (held.preparations.length > 0) print(held.confirmation);
  return 0;
}
