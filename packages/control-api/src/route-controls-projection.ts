import type { ControlRouteControl, RunTelemetry } from "@claudexor/schema";

/**
 * #118/#413: each distinct route of the run, the native web and access controls
 * prepared for its spawns and whether a native session was reported started,
 * projected verbatim from telemetry. Attempts without a receipt (older records,
 * no dispatched spawn) contribute nothing, and the HOME fact is the attempt's
 * applied fact or null: nothing is inferred. So is the selected Browser's
 * startup (#215): what the route reported, or null for a Browser only prepared.
 */
export function projectRouteControls(telemetry: RunTelemetry | null): ControlRouteControl[] {
  const routes = new Map<string, ControlRouteControl>();
  for (const attempt of telemetry?.attempts ?? []) {
    const controls = attempt.route_controls;
    if (!controls) continue;
    const startup = attempt.browser?.startup;
    const route: ControlRouteControl = {
      harnessId: attempt.harness_id,
      webMode: attempt.web.effective_mode,
      webMechanism: controls.web_mechanism,
      browser: attempt.browser?.requested === true,
      browserStartup: startup
        ? { status: startup.status, waitedMs: startup.waited_ms, error: startup.error }
        : null,
      access: controls.access,
      nativeAccess: controls.native_access,
      accessMechanism: controls.access_mechanism,
      nativeSessionStarted: attempt.native_session_started === true,
      homeScoped: attempt.harness_home_isolated ?? null,
    };
    const key = JSON.stringify(route);
    if (!routes.has(key)) routes.set(key, route);
  }
  return [...routes.values()];
}
