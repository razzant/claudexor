/**
 * CLI output helpers: one owner for stdout/JSON purity. `--json` mode emits
 * exactly one JSON object on stdout; usage errors go to stderr (text mode)
 * or a typed {ok:false,exitCode,error} object (json mode).
 */
import {
  harnessHasDefaultCredentialStore,
  type HarnessManifest,
  type QuotaRefreshSkipped,
} from "@claudexor/schema";

export function quotaRefreshLabel(skip: QuotaRefreshSkipped): string {
  const subject = skip.subject;
  return subject
    ? `${subject.harness}/${subject.subject_id ?? "default"} (${subject.credential_route})`
    : skip.vendor;
}

/** The `claudexor models` line for a harness that answered no model list. A
 * harness with only named accounts that enumerates per account (Grok) had no
 * account to list under; that is not an adapter without enumeration. */
export function noModelListLine(
  harnessId: string,
  statuses: readonly { id: string; manifest?: HarnessManifest | null }[],
  route: string | undefined,
): string {
  const manifest = statuses.find((status) => status.id === harnessId)?.manifest;
  const perAccount =
    route !== "api_key" &&
    !harnessHasDefaultCredentialStore(harnessId) &&
    (manifest?.capabilities.model_inventory_routes?.length ?? 0) > 0;
  return perAccount
    ? `${harnessId}: no account selected (models are listed per named account)`
    : `${harnessId}: no model enumeration (adapter cannot list models)`;
}

export function print(s: string): void {
  process.stdout.write(s + "\n");
}

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/** One COMPACT JSON object per line — the NDJSON contract (--json-stream). A
 *  pretty multi-line object would break `for line in stream: json.loads(line)`. */
export function printJsonLine(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

/** On Windows, how long a finished command may stay alive on a stray handle
 *  before the backstop forces termination. The clean path never waits for it. */
const STRAY_HANDLE_EXIT_GRACE_MS = 1_000;

export function exitAfterOutputFlush(code: number): void {
  // JSON projections such as `doctor --all` can exceed a pipe's 64 KiB high-water
  // mark. A direct process.exit() discards that buffered tail while still reporting
  // success. Empty writes queue behind every prior write; exit only after both pipes
  // have drained.
  //
  // On Windows, an empty event loop lets Node dispose the isolate and finish
  // background work before shutdown. A forced process.exit() raced that work in
  // Node 24.16 and libuv aborted after valid JSON (nodejs/node#56645, fixed in
  // Node 24.20.0). Keep the former immediate exit on other platforms. The
  // Windows-only unref'd backstop fires if a stray handle keeps the loop alive.
  let pending = 2;
  const flushed = () => {
    pending -= 1;
    if (pending !== 0) return;
    if (process.platform !== "win32") {
      process.exit(code);
      return;
    }
    process.exitCode = code;
    setTimeout(() => process.exit(code), STRAY_HANDLE_EXIT_GRACE_MS).unref();
  };
  process.stdout.write("", flushed);
  process.stderr.write("", flushed);
}

/**
 * A usage/validation failure (exit 2). The JSON envelope aligns with the D-7
 * projector shape ({ok, exitCode, code, message}) while keeping the legacy
 * `error` alias for existing consumers. The `code` uses the SAME vocabulary the
 * projector stamps for this class (`invalid_argument`, matching `minIntError`
 * and the Zod path) so a machine consumer never sees two names for one failure.
 * Typed failures (field errors, domain codes) go through `renderCliFailure` in
 * cli-error.ts instead.
 */
export function printUsageError(json: boolean, error: string): number {
  if (json) printJson({ ok: false, exitCode: 2, code: "invalid_argument", message: error, error });
  else process.stderr.write(`${error}\n`);
  return 2;
}

export function statusGlyph(status: string): string {
  return status === "ok" ? "[ok]" : status === "degraded" ? "[degraded]" : "[unavailable]";
}

export function authSourceAvailability(status: {
  authSources?: {
    source: string;
    availability: "available" | "unavailable" | "unknown";
    verification: "passed" | "failed" | "not_run";
  }[];
}): string {
  const sources = status.authSources ?? [];
  if (sources.length === 0) return "readiness-not-reported";
  return sources
    .map(
      (source) =>
        `${source.source}[availability=${source.availability},verification=${source.verification}]`,
    )
    .join(", ");
}

export function checksSummary(status: {
  checks?: { id: string; status: string; detail?: string }[];
}): string {
  const checks = status.checks ?? [];
  if (checks.length === 0) return "none";
  return checks.map((c) => `${c.id}:${c.status}`).join(", ");
}
