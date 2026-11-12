import type { RunTelemetry } from "@claudexor/schema";

type Attempt = RunTelemetry["attempts"][number];
type Controls = NonNullable<Attempt["route_controls"]>;

/** Distinct values in first-seen order: one line per route, not per spawn. */
function distinct(lines: string[]): string[] {
  return [...new Set(lines)];
}

/** Only the vendor's own sandbox is a declared OS file boundary; inherit_native
 * passes no profile, so what the harness's own settings confine is unknown here. */
function osFileBoundary(controls: Controls): string {
  if (controls.access_mechanism === "fs_sandbox") return "vendor_sandbox";
  return controls.access_mechanism === "native_settings" ? "unknown" : "none_declared";
}

/** The receipt is prepared before dispatch: `started` is reported by the adapter,
 * and its absence never proves that no process ran. */
function nativeSession(attempt: Attempt): string {
  return attempt.native_session_started ? "started" : "not_reported";
}

/**
 * #413: what was prepared for each route's file access, projected from the
 * telemetry receipt. The HOME fact is printed only where the attempt recorded
 * it; `not_scoped` means the engine did not replace HOME, nothing more.
 */
export function accessRouteLines(telemetry: RunTelemetry | null): string[] {
  return distinct(
    (telemetry?.attempts ?? []).flatMap((attempt) => {
      const controls = attempt.route_controls;
      if (!controls) return [];
      const native =
        controls.native_access === null ? "none" : JSON.stringify(controls.native_access);
      const home =
        attempt.harness_home_isolated === undefined
          ? ""
          : ` home=${attempt.harness_home_isolated ? "scoped" : "not_scoped"}`;
      return [
        `access route: harness=${attempt.harness_id} access=${controls.access} native=${native} mechanism=${controls.access_mechanism} os_file_boundary=${osFileBoundary(controls)} native_session=${nativeSession(attempt)}${home}`,
      ];
    }),
  );
}

/** #215: an injected Browser's startup as the route reported it; a Browser that
 * was only prepared says `not_reported`, never ready. */
function browserStartup(attempt: Attempt): string {
  const startup = attempt.browser?.startup;
  if (!attempt.browser?.requested) return "browser=not_injected";
  if (!startup) return "browser=injected browser_startup=not_reported";
  const error =
    startup.error === null ? "" : ` browser_startup_error=${JSON.stringify(startup.error)}`;
  return `browser=injected browser_startup=${startup.status} waited_ms=${startup.waited_ms}${error}`;
}

/**
 * #118: how each route's own web tools were switched, the retrieval strength
 * of web activity and what a verified result returned (a page or search
 * results), and what the web evidence covers. Satisfied activity that retrieved
 * nothing (a Browser close or click) says so instead of staying silent.
 */
export function webRouteLines(telemetry: RunTelemetry | null): string[] {
  if (!telemetry) return [];
  const routes = distinct(
    telemetry.attempts.flatMap((attempt) =>
      attempt.route_controls
        ? [
            `web route: harness=${attempt.harness_id} mode=${attempt.web.effective_mode} mechanism=${attempt.route_controls.web_mechanism} ${browserStartup(attempt)} native_session=${nativeSession(attempt)}`,
          ]
        : [],
    ),
  );
  const { verification, verified_content: content, status } = telemetry.web;
  const kind = content === null ? "" : ` (${content.replace("_", " ")})`;
  const strength =
    verification === "none" && status !== "satisfied"
      ? []
      : [`web retrieval: ${verification}${verification === "verified" ? kind : ""}`];
  const { evidence, network } = telemetry.web.observation;
  return [...routes, ...strength, `web scope: evidence=${evidence} network=${network}`];
}
