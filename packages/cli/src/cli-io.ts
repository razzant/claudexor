/**
 * CLI output helpers: one owner for stdout/JSON purity. `--json` mode emits
 * exactly one JSON object on stdout; usage errors go to stderr (text mode)
 * or a typed {ok:false,exitCode,error} object (json mode).
 */
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

/**
 * A usage/validation failure (exit 2). The JSON envelope aligns with the D-7
 * projector shape ({ok, exitCode, code, message}) while keeping the legacy
 * `error` alias for existing consumers. Typed failures (field errors, domain
 * codes) go through `renderCliFailure` in cli-error.ts instead.
 */
export function printUsageError(json: boolean, error: string): number {
  if (json) printJson({ ok: false, exitCode: 2, code: "usage_error", message: error, error });
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
