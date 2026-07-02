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

export function printUsageError(json: boolean, error: string): number {
  if (json) printJson({ ok: false, exitCode: 2, error });
  else process.stderr.write(`${error}\n`);
  return 2;
}

export function statusGlyph(status: string): string {
  return status === "ok" ? "[ok]" : status === "degraded" ? "[degraded]" : "[unavailable]";
}

export function authSourceAvailability(status: {
  manifest?: {
    auth_modes?: string[];
    capability_profile?: {
      auth?: { supported_sources?: string[]; preferred_source?: string | null };
    };
  } | null;
}): string {
  const auth = status.manifest?.capability_profile?.auth;
  const present = status.manifest?.auth_modes?.length
    ? status.manifest.auth_modes.join(",")
    : "unknown";
  const supported = auth?.supported_sources?.length ? auth.supported_sources.join(",") : "unknown";
  const preferred = auth?.preferred_source ? ` preferred=${auth.preferred_source}` : "";
  return `present=${present} supported=${supported}${preferred}`;
}

export function checksSummary(status: {
  checks?: { id: string; status: string; detail?: string }[];
}): string {
  const checks = status.checks ?? [];
  if (checks.length === 0) return "none";
  return checks.map((c) => `${c.id}:${c.status}`).join(", ");
}
