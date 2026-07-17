import { isAbsolute } from "node:path";
import { invalidateDoctorCache } from "@claudexor/core";
import {
  ControlAuthReadinessRefreshRequest,
  ControlAuthReadinessRefreshResponse,
  Id,
  type ControlAuthReadinessRefreshResponse as AuthReadinessRefreshResponse,
} from "@claudexor/schema";
import type { HarnessGateway } from "./gateway.js";

export type AuthReadinessServiceErrorCode =
  "unknown_harness" | "auth_source_evidence_missing" | "auth_readiness_probe_failed";

/**
 * Typed service failure designed to project directly to the control plane's
 * application/problem+json boundary. No transport-specific response logic
 * belongs in this domain service.
 */
export class AuthReadinessServiceError extends Error {
  readonly fieldErrors: Record<string, string[]> = {};

  constructor(
    readonly code: AuthReadinessServiceErrorCode,
    readonly status: 404 | 502 | 503,
    message: string,
    readonly retryable: boolean,
    readonly requiredActions: string[] = [],
    readonly evidenceRefs: string[] = [],
  ) {
    super(message);
    this.name = "AuthReadinessServiceError";
  }
}

export interface AuthReadinessServiceOptions {
  /** Stable daemon-owned no-project root used by every no-project doctor probe. */
  cwd: string;
  now?: () => Date;
}

/**
 * Exact auth-readiness application service.
 *
 * It deliberately does not call discovery or aggregate status: one request
 * probes exactly one adapter/source. The surrounding invalidations remove all
 * cached variants for that adapter, including stale project-scoped aggregate
 * reports, because a native login changes global harness state rather than one
 * repository's state. Unrelated harness evidence remains cached. Fresh probes
 * themselves never seed the shared cache.
 */
export class AuthReadinessService {
  private readonly cwd: string;
  private readonly now: () => Date;

  constructor(
    private readonly gateway: HarnessGateway,
    options: AuthReadinessServiceOptions,
  ) {
    if (!isAbsolute(options.cwd)) {
      throw new TypeError("auth readiness service cwd must be absolute");
    }
    this.cwd = options.cwd;
    this.now = options.now ?? (() => new Date());
  }

  /** Invalidate every cwd/source projection for one adapter only. */
  invalidate(harnessIdInput: string): void {
    const harnessId = Id.parse(harnessIdInput);
    invalidateDoctorCache({ adapterId: harnessId });
  }

  async refresh(
    harnessIdInput: string,
    input: unknown,
    runtime: { abortSignal?: AbortSignal } = {},
  ): Promise<AuthReadinessRefreshResponse> {
    const harnessId = Id.parse(harnessIdInput);
    const request = ControlAuthReadinessRefreshRequest.parse(input);
    if (!this.gateway.get(harnessId)) {
      throw new AuthReadinessServiceError(
        "unknown_harness",
        404,
        `unknown harness '${harnessId}'`,
        false,
        ["refresh_harness_catalog"],
      );
    }

    // Invalidate both sides of the fresh probe. The second invalidation closes
    // the race where an aggregate status request began before this refresh and
    // populated a stale target entry while the exact probe was in flight.
    this.invalidate(harnessId);
    let readiness;
    try {
      readiness = await this.gateway.probeAuthSource(harnessId, request.source, {
        cwd: this.cwd,
        fresh: true,
        authPreference: request.authRequest,
        ...(runtime.abortSignal ? { abortSignal: runtime.abortSignal } : {}),
      });
    } catch (error) {
      throw new AuthReadinessServiceError(
        "auth_readiness_probe_failed",
        503,
        `auth readiness probe failed for harness '${harnessId}': ${error instanceof Error ? error.message : String(error)}`,
        true,
        ["retry_auth_readiness_refresh"],
      );
    } finally {
      this.invalidate(harnessId);
    }

    if (!readiness) {
      throw new AuthReadinessServiceError(
        "auth_source_evidence_missing",
        502,
        `harness '${harnessId}' returned no evidence for requested auth source '${request.source}'`,
        false,
        ["inspect_harness_doctor"],
      );
    }

    return ControlAuthReadinessRefreshResponse.parse({
      harnessId,
      authRequest: request.authRequest,
      requestedSource: request.source,
      observedAt: this.now().toISOString(),
      readiness,
    });
  }
}
