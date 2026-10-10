/**
 * One-shot sign-in input delivery for url_disclosure_with_input logins
 * (owner directive 2026-08-04): POST /v2/setup/jobs/:id/input lands the
 * user's pasted completion value in a transient 0600 job-dir sidecar the
 * runner writes to the vendor CLI's stdin. The value is NEVER journaled,
 * logged, or persisted anywhere durable (the userCode rule, INV-062).
 */
import { existsSync } from "node:fs";
import { ControlSetupJobInputRequest, type ControlSetupJob } from "@claudexor/schema";
import { ACTIVE_SETUP_STATES } from "./setup-job-projection.js";
import {
  SETUP_LOGIN_PROTOCOL_VERSION,
  atomicPrivateJson,
  type SetupLoginManifest,
} from "./setup-login-protocol.js";

/** The two daemon-hosted vendor-CLI login modes (owner directive 2026-08-04). */
export function isUrlDisclosureLoginMode(
  mode: string | undefined,
): mode is "url_disclosure" | "url_disclosure_with_input" {
  return mode === "url_disclosure" || mode === "url_disclosure_with_input";
}

export interface SetupLoginInputDeps {
  status: (jobId: string) => ControlSetupJob;
  manifestFor: (jobId: string) => SetupLoginManifest | null;
  update: (jobId: string, patch: Record<string, unknown>) => ControlSetupJob;
  iso: () => string;
}

export function submitSetupLoginInput(deps: SetupLoginInputDeps, input: unknown): ControlSetupJob {
  const p = (input ?? {}) as Record<string, unknown>;
  const jobId = typeof p.jobId === "string" ? p.jobId : "";
  const value = ControlSetupJobInputRequest.parse({ value: p.value }).value;
  const job = deps.status(jobId);
  if (
    job.action !== "login" ||
    !ACTIVE_SETUP_STATES.has(job.state) ||
    !["launching", "awaiting_user"].includes(job.phase ?? "") ||
    !job.authorization
  ) {
    throw Object.assign(new Error("setup job is not awaiting sign-in input"), {
      code: "setup_input_not_applicable",
      status: 409,
    });
  }
  const manifest = deps.manifestFor(jobId);
  if (
    !manifest ||
    manifest.loginMode !== "url_disclosure_with_input" ||
    !manifest.inputPath ||
    manifest.executionId !== job.authorization.executionId
  ) {
    throw Object.assign(new Error("this login flow does not accept sign-in input"), {
      code: "setup_input_not_applicable",
      status: 409,
    });
  }
  // One-shot: a second submission conflicts instead of silently replacing
  // a value the runner may already be delivering. (atomicPrivateJson
  // renames over its target, so the guard is this pre-check; the residual
  // same-instant race only affects the submitter's own double-click.) The
  // value itself is TRANSIENT: sidecar + vendor stdin only, never
  // journaled or logged.
  if (existsSync(manifest.inputPath)) {
    throw Object.assign(new Error("sign-in input was already submitted for this login"), {
      code: "setup_input_already_submitted",
      status: 409,
    });
  }
  atomicPrivateJson(manifest.inputPath, {
    version: SETUP_LOGIN_PROTOCOL_VERSION,
    jobId,
    executionId: manifest.executionId,
    value,
    submittedAt: deps.iso(),
  });
  // The vendor's own window governs how long the USER had to paste, not how
  // long the exchange that follows may take. Without this the deadline monitor
  // SIGKILLs the vendor mid token-exchange — and with a sixty-second window
  // the user is racing that clock, so a successful paste being cancelled is
  // the common case rather than an edge one.
  // A FLOOR, never a replacement: a job whose own window is already longer
  // keeps it (the reducer refuses a deadline that moves backwards anyway), and
  // the extended deadline is no longer the vendor's own, so it stops being
  // unextendable.
  const grace = Date.parse(deps.iso()) + INPUT_EXCHANGE_GRACE_MS;
  const current = job.deadlineAt ? Date.parse(job.deadlineAt) : 0;
  const extended = grace > current;
  return deps.update(jobId, {
    message: `${job.harness} sign-in input received — completing the vendor login.`,
    ...(extended ? { deadlineAt: new Date(grace).toISOString(), deadlineFixed: false } : {}),
  });
}

/** How long the vendor may take to finish its token exchange after the user's
 * code is delivered. Bounded, so a vendor that hangs is still terminated. */
const INPUT_EXCHANGE_GRACE_MS = 3 * 60_000;

/** Post-deadline grace verification: one bounded final probe after the verify
 * window closed. Returns which oracle confirmed, or null (the honest timeout
 * stands). Probe failures read as null — the grace pass is best-effort. */
export async function graceVerifyAfterDeadline(input: {
  profileId: string | null;
  probeProfile: () => Promise<{ availability?: string; verification?: string } | null>;
  probeNative: () => Promise<{
    source?: string;
    availability?: string;
    verification?: string;
  } | null>;
}): Promise<"profile_verified" | "native_verified" | null> {
  try {
    if (input.profileId) {
      const status = await input.probeProfile();
      return status?.availability === "available" && status.verification === "passed"
        ? "profile_verified"
        : null;
    }
    const readiness = await input.probeNative();
    return readiness?.source === "native_session" &&
      readiness.availability === "available" &&
      readiness.verification === "passed"
      ? "native_verified"
      : null;
  } catch {
    return null;
  }
}
