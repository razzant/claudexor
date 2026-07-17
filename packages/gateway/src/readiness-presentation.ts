import type {
  AuthSourceReadiness,
  ConformanceCheck,
  HarnessStatusDto,
  ReadinessCheckDto,
} from "@claudexor/schema";

/**
 * THE producer of the display-ready readiness list (W4.7 sol #18): raw doctor
 * probes, per-source auth readiness, and the configured-model verdict
 * normalize HERE, once, into typed rows every surface renders identically.
 * Classification is an explicit TABLE — never an id-substring match (the
 * no-regex governance class): an adapter adding a probe id extends the table
 * (pinned by a test enumerating the real adapter ids), and an unknown id
 * degrades honestly to a generic probe row with the id as its name.
 */
const KNOWN_CHECKS: Record<string, { title: string; kind: ReadinessCheckDto["kind"] }> = {
  installed: { title: "Installed", kind: "binary" },
  api_key: { title: "API key", kind: "auth" },
  provider_auth: { title: "Provider login", kind: "auth" },
  isolated_smoke: { title: "Isolated API-key smoke", kind: "smoke" },
  structured_output: { title: "Structured output", kind: "probe" },
};

const AUTH_SOURCE_TITLES: Record<string, string> = {
  native_session: "Native session",
  oauth_token_env: "Setup token",
  api_key_env: "API key",
};

function humanizeId(id: string): string {
  const words = id.split(/[_-]+/).filter(Boolean);
  if (words.length === 0) return id;
  const joined = words.join(" ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

function checkRow(check: ConformanceCheck): ReadinessCheckDto {
  const known = KNOWN_CHECKS[check.id];
  return {
    id: check.id,
    kind: known?.kind ?? "probe",
    title: known?.title ?? humanizeId(check.id),
    status: check.status,
    detail: check.detail ?? null,
  };
}

/**
 * An auth source is a row about THAT source: verified -> pass, a failed
 * verification -> fail, everything else -> skip with honest detail (an
 * unconfigured fallback source is not a failure of the harness).
 */
function authSourceRow(source: AuthSourceReadiness): ReadinessCheckDto {
  const status =
    source.verification === "passed" ? "pass" : source.verification === "failed" ? "fail" : "skip";
  const detail =
    source.detail ??
    (source.verification === "not_run"
      ? source.availability === "available"
        ? "present, not verified"
        : source.availability === "unavailable"
          ? "not configured"
          : "availability unknown"
      : null);
  return {
    id: `auth_source:${source.source}`,
    kind: "auth",
    title: AUTH_SOURCE_TITLES[source.source] ?? humanizeId(source.source),
    status,
    detail,
  };
}

export function normalizeReadiness(
  input: Pick<HarnessStatusDto, "checks" | "authSources" | "configuredModel"> & {
    configuredModelCheck: { status: "ok" | "rejected"; message?: string | null } | null;
  },
): ReadinessCheckDto[] {
  const rows: ReadinessCheckDto[] = [];
  for (const check of input.checks) rows.push(checkRow(check));
  for (const source of input.authSources) rows.push(authSourceRow(source));
  if (input.configuredModel && input.configuredModelCheck) {
    rows.push({
      id: "configured_model",
      kind: "model",
      title: "Configured model",
      status: input.configuredModelCheck.status === "ok" ? "pass" : "fail",
      detail:
        input.configuredModelCheck.status === "ok"
          ? input.configuredModel
          : (input.configuredModelCheck.message ?? null),
    });
  }
  return rows;
}
