/**
 * `claudexor doctor`: the route-health section. The daemon's last seven days of
 * terminal runs per harness and effective access profile, projected verbatim
 * from `GET /v2/daemon/route-health`. Facts only: no threshold decides what is
 * printed beyond "this route had failures", and no line carries a verdict.
 */
import { ControlRouteHealth, type ControlRouteHealthRoute } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";

/** Null means this engine has no route-health read (an older daemon answers 404).
 * Any other failure throws: the HTTP or transport error as raised, or one naming
 * the first mismatch of an answer that does not fit the schema. */
export async function readRouteHealth(
  get: (path: string) => Promise<unknown>,
): Promise<ControlRouteHealth | null> {
  let answer: unknown;
  try {
    answer = await get("/daemon/route-health");
  } catch (error) {
    if (error instanceof Error && (error as { status?: unknown }).status === 404) return null;
    throw error;
  }
  const parsed = ControlRouteHealth.safeParse(answer);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new Error(
    `the answer did not match its schema${issue ? ` (${issue.path.join(".") || "answer"}: ${issue.message})` : ""}`,
  );
}

/** The section as doctor composes it (#569): the answer; null with no problem
 * for an engine without the read; or null with the masked cause of any other
 * failure, which never costs doctor its other sections. */
export async function readRouteHealthSection(
  get: (path: string) => Promise<unknown>,
): Promise<{ health: ControlRouteHealth | null; problem: string | null }> {
  try {
    return { health: await readRouteHealth(get), problem: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A bare "fetch failed" carries its transport cause (refused, reset) separately.
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    const text = cause && !message.includes(cause) ? `${message} (${cause})` : message;
    return { health: null, problem: redactSecrets(text) };
  }
}

/** One summary line, then one line per route that had failed runs; a failed
 * read is one line naming its cause, never an empty or healthy week. */
export function routeHealthLines(
  health: ControlRouteHealth | null,
  problem: string | null = null,
): string[] {
  if (problem !== null) return [`? route health: unavailable — ${problem}`];
  if (health === null) return ["? route health: unavailable from this engine version"];
  const failing = health.routes.filter((route) => route.failed > 0);
  const scope = health.complete
    ? `last ${health.windowDays} days`
    : `newest ${health.scannedRuns} runs of the last ${health.windowDays} days (${
        health.incompleteReason === "scan_bound"
          ? "scan bound reached; older runs of the window are not counted"
          : "scan stopped early"
      })`;
  return [
    `route health, ${scope}: ${health.scannedRuns} run(s) over ${health.routes.length} route(s), ${failing.length} with failures`,
    ...failing.map((route) => `    ${routeLine(route)}`),
  ];
}

function routeLine(route: ControlRouteHealthRoute): string {
  const cancelled = route.cancelled ? `, ${route.cancelled} cancelled` : "";
  const top = route.topFailures[0];
  const cause = top
    ? `; most: ${top.category}${top.code ? ` (${top.code})` : ""}${
        top.message ? ` — ${top.message}` : ""
      } ×${top.count}`
    : "";
  return `${route.harnessId} ${route.access}: ${route.failed}/${route.runs} failed (${failedShare(route)})${cancelled}${cause}`;
}

/** The rounded share, except where rounding would contradict the counts beside
 * it: a failure never shows as 0% and a partial failure never as 100%. */
function failedShare({ failed, runs }: ControlRouteHealthRoute): string {
  const share = Math.round((failed / runs) * 100);
  if (share === 0 && failed > 0) return "<1%";
  if (share === 100 && failed < runs) return ">99%";
  return `${share}%`;
}
