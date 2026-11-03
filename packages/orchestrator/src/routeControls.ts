import type { HarnessAdapter } from "@claudexor/core";
import type {
  AccessControlCapabilities,
  AttemptTelemetryRecord,
  HarnessEvent,
  HarnessRunSpec,
  RouteControls,
  WebPolicySupport,
} from "@claudexor/schema";

/** The manifest declarations of a routed lane the per-spawn receipt reads. */
export interface RouteControlSource {
  adapter: Pick<HarnessAdapter, "nativeAccess">;
  webSupport?: WebPolicySupport;
  accessControl?: AccessControlCapabilities;
}

/**
 * #118/#413: what the engine PREPARED for ONE spawn's web and file access: the
 * manifest's declared web switch and access mechanism for the profile this spawn
 * passes, and the adapter's own native setting. The gate yields it just before it
 * dispatches the adapter, so it never proves a native process ran; the attempt's
 * typed `started` event reports that (`observeRouteControls`). Disclosure only,
 * it changes nothing the harness receives. A route without manifest declarations
 * (a test double) gets no receipt, so nothing is guessed.
 */
export function routeControlsEvent(
  route: RouteControlSource,
  spec: HarnessRunSpec,
): HarnessEvent | null {
  if (!route.webSupport || !route.accessControl) return null;
  const { readonly_mechanism, write_mechanism } = route.accessControl;
  const routeControls: RouteControls = {
    web_mechanism: route.webSupport,
    access: spec.access,
    native_access: route.adapter.nativeAccess?.(spec) ?? null,
    access_mechanism:
      spec.access === "readonly"
        ? readonly_mechanism
        : spec.access === "workspace_write"
          ? write_mechanism
          : spec.access === "inherit_native"
            ? "native_settings"
            : "none",
  };
  return {
    type: "status",
    session_id: spec.session_id,
    ts: new Date().toISOString(),
    route_controls: routeControls,
  };
}

/** The attempt's fold of the receipt and of the launch fact beside it. */
export interface RouteControlsTelemetry {
  /** The last dispatched spawn's prepared controls. */
  routeControls?: RouteControls;
  /** Any try of this attempt reported its native session started (the typed
   * `started` event an adapter's own pre-spawn refusal never emits). */
  nativeSessionStarted?: boolean;
}

export function observeRouteControls(t: RouteControlsTelemetry, ev: HarnessEvent): void {
  if (ev.route_controls) t.routeControls = ev.route_controls;
  if (ev.type === "started") t.nativeSessionStarted = true;
}

/** Record fields: the launch fact only ever appears beside a receipt it qualifies. */
export function routeControlsRecord(
  t: RouteControlsTelemetry,
  applied?: { harness_home_isolated?: boolean },
): Pick<
  AttemptTelemetryRecord,
  "route_controls" | "native_session_started" | "harness_home_isolated"
> {
  return {
    route_controls: t.routeControls,
    native_session_started: t.routeControls ? t.nativeSessionStarted === true : undefined,
    harness_home_isolated: applied?.harness_home_isolated,
  };
}
