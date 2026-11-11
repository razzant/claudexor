import { runCapture, type CaptureResult, type EnvMap } from "@claudexor/core";
import type { HarnessModel } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { resolveGrokBin } from "./bin.js";

export const GROK_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
/** Budget of one `grok models` login probe, enforced by a timer the probe owns. */
const GROK_LOGIN_PROBE_TIMEOUT_MS = 20_000;

/** The grok.com login line this probe requires. The CLI binaries (1.0.46 to
 * 1.0.70) contain only the prefix `You are logged in with ` and fill in the
 * login at runtime, and no `grok models` transcript is recorded, so the line is
 * an expectation, not an observation. Only the whole line verifies: another
 * login, such as an enterprise identity provider or a value that merely starts
 * with `grok.com`, or another format leaves the login unknown. */
const GROK_COM_LOGIN = /^[ \t]*You are logged in with grok\.com\.[ \t]*\r?$/im;

/** `failed` means the probe could not decide: login state unknown, never a
 * refusal. `failed: false` without `authenticated` is a definite vendor
 * refusal, which this probe never reports: no logged-out transcript of
 * `grok models` is recorded, and generic auth words may come from a proxy or
 * backend, not from this account. */
export interface GrokLoginProbe {
  authenticated: boolean;
  models: HarnessModel[];
  detail: string;
  failed?: boolean;
  /** The probe's own budget ended it before the CLI answered. */
  timedOut?: boolean;
}

export function parseGrokModels(text: string): HarnessModel[] {
  const models = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[-*]\s+(grok-[A-Za-z0-9._-]+)(?:\s|$)/.exec(line);
    if (match) models.add(match[1]!);
  }
  return [...models].map((id) => ({
    id,
    label: null,
    context_window: null,
    routes: ["local_session"],
  }));
}

const unknownLogin = (detail: string, timedOut = false, hint = ""): GrokLoginProbe => ({
  authenticated: false,
  models: [],
  detail: `${detail}; login state is unknown${hint}`,
  failed: true,
  ...(timedOut ? { timedOut: true } : {}),
});

/**
 * `grok models` in the exact profile env is the login proof; the profile's
 * private file store is never an oracle. A normal exit that prints the
 * grok.com login line verifies the login. Every other end (spawn error, signal,
 * own timeout, cancellation, forced drain, nonzero exit, any other text) leaves
 * the login unknown. Raw output never leaves here.
 */
export async function probeGrokLogin(
  env: EnvMap,
  abortSignal?: AbortSignal,
  budgetMs: number = GROK_LOGIN_PROBE_TIMEOUT_MS,
): Promise<GrokLoginProbe> {
  const budget = new AbortController();
  // First observed end cause: a child that exited before the timer is not a timeout.
  const first: { cause: "timeout" | "cancel" | "exit" | null } = {
    cause: abortSignal?.aborted ? "cancel" : null,
  };
  const onCancel = () => {
    first.cause ??= "cancel";
  };
  abortSignal?.addEventListener("abort", onCancel, { once: true });
  const timer = setTimeout(() => {
    first.cause ??= "timeout";
    budget.abort();
  }, budgetMs);
  let result: CaptureResult;
  try {
    result = await runCapture(resolveGrokBin(), ["models"], {
      env,
      abortSignal: abortSignal ? AbortSignal.any([abortSignal, budget.signal]) : budget.signal,
      cancelSignal: "SIGTERM",
      onExit: () => {
        first.cause ??= "exit";
      },
    });
  } catch (error) {
    const reason = redactSecrets(error instanceof Error ? error.message : String(error));
    return unknownLogin(`Grok login probe could not run (${reason.slice(0, 200)})`);
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", onCancel);
  }
  if (first.cause === "timeout")
    return unknownLogin(`grok models did not answer within ${budgetMs / 1000}s`, true);
  if (first.cause === "cancel") return unknownLogin("Grok login probe was cancelled");
  if (result.signal !== null || result.code === null)
    return unknownLogin(`grok models ended by ${result.signal ?? "an unknown cause"}`);
  if (result.drain === "truncated")
    return unknownLogin("grok models output was truncated by a process that kept it open");
  const text = `${result.stdout}\n${result.stderr}`;
  if (result.code === 0 && GROK_COM_LOGIN.test(text))
    return {
      authenticated: true,
      models: parseGrokModels(text),
      detail: "Grok CLI reported a grok.com login",
    };
  return unknownLogin(
    result.code === 0
      ? "grok models did not confirm a grok.com login"
      : `grok models failed (exit ${result.code})`,
    false,
    " (a profile that was never signed in needs claudexor profiles login grok <id>)",
  );
}
