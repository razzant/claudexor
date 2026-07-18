/**
 * Closure-free support owners for the setup-job manager (complexity split:
 * setup-jobs.ts is at its ratchet cap). Everything here is a pure function or
 * a parameterized factory — no store, supervisor, or journal access.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseProcessGroupHandle,
  type HarnessAdapter,
  type ProcessGroupHandle,
} from "@claudexor/core";
import { loadConfig } from "@claudexor/config";
import { canonicalProfileConfigDir } from "@claudexor/harness-claude";
import { canonicalCodexProfileHome } from "@claudexor/harness-codex";
import type {
  ControlHarnessSetupHarness,
  ControlSetupJob,
  CredentialProfileStatus,
} from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import type { SetupLoginRunnerState } from "./setup-login-protocol.js";

const NO_PROJECT_ROOT = noProjectRepoRoot();

export type SetupProfile = {
  guideUrl: string;
  note: string;
};

export const SETUP_PROFILES: Record<ControlHarnessSetupHarness, SetupProfile> = {
  codex: {
    guideUrl: "https://developers.openai.com/codex/auth/",
    note: "Codex native login updates the official vendor-owned CLI session. Exact subscription setup never falls back to a managed API key.",
  },
  claude: {
    guideUrl: "https://code.claude.com/docs/en/authentication",
    note: "Claude Code native login updates the official vendor-owned CLI session. Exact subscription setup never falls back to a managed API key.",
  },
  cursor: {
    guideUrl: "https://docs.cursor.com/en/cli/reference/authentication",
    note: "Cursor native CLI login is reused when available.",
  },
};

/**
 * Resolve an INV-135 profile-targeted login request to its canonical scoped
 * config dir. Typed 400s: an unknown/disabled/secret-ref profile must refuse
 * at create time, never open a Terminal login into the wrong store.
 */
export function resolveProfileBinding(
  harness: ControlHarnessSetupHarness,
  profileId: string | undefined,
): { profileId: string; configDir: string } | null {
  if (!profileId) return null;
  if (harness !== "claude" && harness !== "codex") {
    throw Object.assign(
      new Error(
        `harness "${harness}" has no isolated config-dir login; only claude and codex support profile logins`,
      ),
      { status: 400 },
    );
  }
  const profile = loadConfig(NO_PROJECT_ROOT).global.credential_profiles.find(
    (entry) => entry.harness_id === harness && entry.profile_id === profileId,
  );
  if (!profile) {
    throw Object.assign(
      new Error(
        `no credential profile "${profileId}" for harness "${harness}" — register it first (POST /v2/credential-profiles or \`claudexor profiles add\`)`,
      ),
      { status: 400 },
    );
  }
  if (!profile.enabled) {
    throw Object.assign(new Error(`credential profile "${profileId}" is disabled`), {
      status: 400,
    });
  }
  if (profile.credential_kind !== "config_dir_login") {
    throw Object.assign(
      new Error(
        `credential profile "${profileId}" is ${profile.credential_kind}; only config_dir_login profiles use the native login flow (store its secret instead)`,
      ),
      { status: 400 },
    );
  }
  const configDir =
    harness === "claude"
      ? canonicalProfileConfigDir(profile.isolation_locator ?? "")
      : canonicalCodexProfileHome(profile.isolation_locator ?? "");
  return { profileId, configDir };
}

/** INV-135 profile verification: the registry adapter's doctor probe against
 * the durable registry entry — the SAME truth `claudexor profiles login` uses. */
export function profileDoctorProbe(
  getAdapter: (harness: string) => HarnessAdapter | undefined,
): (
  harness: string,
  profileId: string,
  abortSignal: AbortSignal,
) => Promise<CredentialProfileStatus | null> {
  return async (harness, profileId, abortSignal) => {
    const profile = loadConfig(NO_PROJECT_ROOT).global.credential_profiles.find(
      (entry) => entry.harness_id === harness && entry.profile_id === profileId,
    );
    if (!profile) return null;
    const adapter = getAdapter(harness);
    if (!adapter?.probeCredentialProfile) return null;
    return adapter.probeCredentialProfile(profile, abortSignal);
  };
}

export function resolveSetupLoginRunnerPath(
  moduleUrl: string = import.meta.url,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const directory = dirname(fileURLToPath(moduleUrl));
  const bundled = resolve(directory, "setup-login-runner.cjs");
  return pathExists(bundled) ? bundled : resolve(directory, "setup-login-runner.js");
}

export function waitWithAbort(
  ms: number,
  controller: AbortController,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
  return new Promise((resolveWait, rejectWait) => {
    let settled = false;
    const settle = (task: () => void) => {
      if (settled) return;
      settled = true;
      controller.signal.removeEventListener("abort", onAbort);
      task();
    };
    const onAbort = () =>
      settle(() =>
        rejectWait(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error("setup operation aborted"),
        ),
      );
    controller.signal.addEventListener("abort", onAbort, { once: true });
    sleep(ms).then(
      () => settle(resolveWait),
      (error) => settle(() => rejectWait(error)),
    );
  });
}

export function withAbortAndTimeout<T>(
  operation: () => Promise<T>,
  controller: AbortController,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
  return new Promise((resolveOperation, rejectOperation) => {
    let settled = false;
    const settle = (task: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      task();
    };
    const onAbort = () =>
      settle(() =>
        rejectOperation(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error(`${label} aborted`),
        ),
      );
    const timer = setTimeout(() => {
      const error = Object.assign(new Error(`${label} timed out after ${timeoutMs / 1000}s`), {
        code: "setup_timeout",
      });
      controller.abort(error);
    }, timeoutMs);
    timer.unref();
    controller.signal.addEventListener("abort", onAbort, { once: true });
    operation().then(
      (value) => settle(() => resolveOperation(value)),
      (error) => settle(() => rejectOperation(error)),
    );
  });
}

export function processGroupFromJob(job: ControlSetupJob): ProcessGroupHandle | null {
  if (!job.execution) return null;
  try {
    return parseProcessGroupHandle(job.execution.processGroup);
  } catch {
    return null;
  }
}

export function stateMatchesDurableExecution(
  job: ControlSetupJob,
  state: SetupLoginRunnerState,
): boolean {
  return (
    job.execution?.executionId === state.executionId &&
    job.execution.commandDigest === state.commandDigest &&
    job.execution.manifestDigest === state.manifestDigest &&
    job.execution.observedAt === state.observedAt &&
    JSON.stringify(job.execution.processGroup) === JSON.stringify(state.processGroup)
  );
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
