/**
 * CLI output helpers: one owner for stdout/JSON purity. Non-streaming
 * `--json` command outcomes emit exactly one JSON object on stdout; usage
 * errors go to stderr (text mode) or the shared ControlProblem-based failure
 * envelope (json mode).
 */
import {
  argvRequestsJson,
  projectCliFailure,
  type CliFailureOptions,
  type CliFailureEnvelope,
} from "./cli-problem.js";

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

export function printCliFailure(
  json: boolean,
  error: unknown,
  options: CliFailureOptions = {},
): number {
  const failure: CliFailureEnvelope = projectCliFailure(error, options);
  if (json) printJson(failure);
  else process.stderr.write(`${failure.message}\n`);
  return failure.exitCode;
}

export function printUsageError(
  json: boolean,
  error: unknown,
  options: Omit<CliFailureOptions, "category"> = {},
): number {
  return printCliFailure(json, error, {
    category: "usage",
    fallbackCode: "invalid_argument",
    ...options,
  });
}

export function printUnhandledCliFailure(error: unknown): number {
  return printCliFailure(argvRequestsJson(process.argv.slice(2)), error, {
    category: "unexpected",
    fallbackCode: "unexpected_error",
    prefix: "claudexor: ",
  });
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
