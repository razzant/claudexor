import type {
  CredentialRoute,
  CredentialUnusableObservation,
  HarnessEvent,
  HarnessRunSpec,
} from "../schema/index.js";

/** Runtime identity only. No credential material or durable generation store. */
export interface CredentialExecutionSubject {
  harnessId: string;
  profileId: string | null;
  route: CredentialRoute | null;
  requestedModel: string | null;
}

export interface CredentialExecutionBinding {
  subject: CredentialExecutionSubject;
  generation: number;
  /** Dispatch ordering within this daemon, independent of wall-clock changes. */
  order: number;
  startedAt: string;
}

export interface CredentialEvidenceAuthority {
  bind(subject: CredentialExecutionSubject): CredentialExecutionBinding;
  current(binding: CredentialExecutionBinding): boolean;
  recordBound(
    binding: CredentialExecutionBinding,
    observation: CredentialUnusableObservation,
  ): void;
  honorBound(
    binding: CredentialExecutionBinding,
    observedModel: string | null,
    observedAt?: string,
  ): void;
  honored?(): readonly CredentialHonoredObservation[];
}

/** Current managed-generation proof, never a quota response or local presence claim. */
export interface CredentialHonoredObservation {
  harness_id: string;
  profile_id: string | null;
  credential_route: CredentialRoute | null;
  model: string | null;
  observed_at: string;
}

export interface CredentialExecutionObserver {
  observe(event: HarnessEvent): void;
  finish(): void;
}

export type CredentialExecutionObserverFactory = (
  subject: CredentialExecutionSubject,
) => CredentialExecutionObserver;

const FACTORY_KEY = "credentialExecutionObserverFactory";

export function bindCredentialExecutionObserverFactory(
  spec: HarnessRunSpec,
  factory: CredentialExecutionObserverFactory | undefined,
): void {
  if (factory) spec.extra[FACTORY_KEY] = factory;
}

export function credentialExecutionSubject(
  harnessId: string,
  spec: HarnessRunSpec,
): CredentialExecutionSubject {
  const profile = spec.credential_profile;
  return {
    harnessId,
    profileId: profile?.profile_id ?? null,
    route: profile
      ? profile.credential_kind === "api_key"
        ? "managed_api_key"
        : "vendor_native"
      : spec.auth_preference === "api_key"
        ? "managed_api_key"
        : spec.auth_preference === "subscription"
          ? "vendor_native"
          : null,
    requestedModel: spec.model_hint ?? null,
  };
}

/** Observe before yielding: a consumer's break still finalizes received facts. */
export async function* observeCredentialExecution(
  harnessId: string,
  spec: HarnessRunSpec,
  source: AsyncIterable<HarnessEvent>,
  factory?: CredentialExecutionObserverFactory,
): AsyncGenerator<HarnessEvent> {
  const stored = spec.extra[FACTORY_KEY];
  const create =
    factory ??
    (typeof stored === "function" ? (stored as CredentialExecutionObserverFactory) : undefined);
  let observer: CredentialExecutionObserver | undefined;
  try {
    observer = create?.(credentialExecutionSubject(harnessId, spec));
  } catch {
    // Evidence maintenance never replaces a native execution outcome.
  }
  try {
    for await (const event of source) {
      try {
        observer?.observe(event);
      } catch {
        // The injected daemon factory owns diagnostic reporting.
      }
      yield event;
    }
  } catch (error) {
    try {
      observer?.observe({
        type: "error",
        session_id: spec.session_id,
        ts: new Date().toISOString(),
        error: "native execution stream failed",
      });
    } catch {
      // Preserve the source exception, including its original custody.
    }
    throw error;
  } finally {
    try {
      observer?.finish();
    } catch {
      // A received native result and its cleanup remain authoritative.
    }
  }
}
