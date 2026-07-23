/**
 * D-17: inline CLI presentation of a durable codex device-code login job.
 *
 * Both `claudexor auth login codex` and `claudexor profiles login codex <id>`
 * ride the SAME daemon-owned setup job; this helper polls the job snapshot,
 * shows the one-time code + verification URL as soon as the runner discloses
 * them (transient, from the snapshot overlay — never journaled), and follows
 * the job to its typed terminal outcome. Ctrl-C detaches the CLI; the daemon
 * runner keeps the login alive.
 */
import { createInterface } from "node:readline/promises";
import {
  ControlSetupJob,
  ControlSetupJobSnapshot,
  isTerminalControlSetupJobState,
  type ControlSetupJobState,
} from "@claudexor/schema";
import { print, printJson } from "./cli-io.js";
import { controlApiFetch, type ControlApiAddress } from "./live.js";

const POLL_MS = 1_000;

const NEGATIVE_TERMINAL_STATES = ["failed", "cancelled", "timed_out", "not_supported"];

/** The target a device_auth_unsupported miss can pivot to the legacy Terminal
 * (browser_redirect) sign-in for. Presence of this on the streamer options is
 * what turns the terminal state from a message into a one-action offer. */
export interface TerminalLoginFallbackTarget {
  harness: "codex";
  /** INV-135 profile the fallback login should target; absent = default store. */
  profileId?: string;
}

/**
 * D-17 audit point 8: the typed, machine-actionable next step for a codex
 * device-code login that terminalized as `not_supported` because the installed
 * app-server (or an old codex CLI) lacks the typed auth methods. It is the SAME
 * consistent code — `device_auth_unsupported` — that the runner result, the
 * journaled receipt, the control DTO, and the Swift AuthSheet all key off; here
 * it drives the `--json` `nextAction` so a script pivots to the Terminal flow
 * instead of parsing prose.
 */
export interface TerminalLoginNextAction {
  kind: "terminal_login_fallback";
  reason: "device_auth_unsupported";
  loginFlow: "browser_redirect";
}

/** The typed next action for a terminal job, or null for an ordinary outcome. */
export function terminalLoginFallback(
  job: Pick<ControlSetupJob, "state" | "nativeCommand">,
): TerminalLoginNextAction | null {
  if (job.state === "not_supported" && job.nativeCommand?.errorCode === "device_auth_unsupported") {
    return {
      kind: "terminal_login_fallback",
      reason: "device_auth_unsupported",
      loginFlow: "browser_redirect",
    };
  }
  return null;
}

/**
 * D-17 audit point 8: the terminal report for a durable codex login. The
 * `not_supported` state is actionable, not a dead-end message: when the daemon
 * carries the consistent typed code `device_auth_unsupported` on the
 * native-command receipt (the SAME code the runner result, journal, control
 * DTO, and Swift surface use), the CLI names the code AND the exact next step
 * (the legacy Terminal sign-in), and exits non-zero. Used for the non-TTY /
 * declined path; a TTY OFFERS the transition directly (see below).
 */
export function terminalLoginReport(
  job: Pick<ControlSetupJob, "state" | "message" | "nativeCommand">,
  label: string,
  target: { profileId?: string } = {},
): { lines: string[]; exitCode: number } {
  if (terminalLoginFallback(job)) {
    return {
      lines: [
        `${label} login not_supported (device_auth_unsupported): this codex build has no in-app device-code sign-in.`,
        target.profileId
          ? "Next: retry this profile with the legacy Terminal sign-in (the browser-redirect flow)."
          : "Next: run `claudexor auth login codex --browser-redirect` for the Terminal sign-in.",
      ],
      exitCode: 1,
    };
  }
  return {
    lines: [`${label} login ${job.state}: ${job.message}`],
    exitCode: job.state === "succeeded" ? 0 : 1,
  };
}

/** Minimal structural view of the control-plane transport so tests can drive
 * the stream without a live daemon. Defaults to the real `controlApiFetch`. */
type FetchLike = (
  path: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json" | "text">>;

/** Default TTY yes/no prompt. Declines (false) when stdin is not a TTY so a
 * non-interactive pipe never blocks waiting for an answer. */
async function defaultPromptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Create the legacy Terminal (browser_redirect) login for the same target. This
 * rides the daemon's existing duplicate-create / 409 semantics: the prior
 * device-code job is already terminal (not_supported), so no conflict blocks
 * it, and a real conflict surfaces the daemon's reason rather than silently
 * starting a duplicate.
 */
async function createTerminalFallbackJob(
  fetchImpl: FetchLike,
  target: TerminalLoginFallbackTarget,
  label: string,
): Promise<number> {
  const response = await fetchImpl("/setup/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      harness: target.harness,
      action: "login",
      authRequest: "subscription",
      loginFlow: "browser_redirect",
      ...(target.profileId ? { profileId: target.profileId } : {}),
    }),
  });
  if (!response.ok) {
    print(
      `could not start the Terminal ${label} sign-in (${response.status}): ${await response.text()}`,
    );
    return 1;
  }
  const job = ControlSetupJob.parse(await response.json());
  const accepted = !NEGATIVE_TERMINAL_STATES.includes(job.state);
  print(
    accepted
      ? `Opening the Terminal ${label} sign-in (managed by claudexord as ${job.jobId}). Complete it in the Terminal window that opens.`
      : `Terminal ${label} sign-in was not started: ${job.message}`,
  );
  return accepted ? 0 : 1;
}

export interface StreamDurableCodexLoginOptions {
  label: string;
  /** `--json`: emit exactly one JSON object (the disclosure, the terminal
   * outcome, or a detached/ error envelope) instead of the human stream. */
  json?: boolean;
  /** Enables the one-action Terminal fallback on a device_auth_unsupported
   * miss (a y/N prompt on a TTY; a typed `nextAction` in `--json`). */
  fallback?: TerminalLoginFallbackTarget;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  promptYesNo?: (question: string) => Promise<boolean>;
  fetchImpl?: FetchLike;
}

/**
 * Poll a device-code login job. In TTY mode it prints the one-time code once
 * and follows the job to its terminal outcome; on a device_auth_unsupported
 * miss it OFFERS the legacy Terminal sign-in (a y/N prompt that, on yes, starts
 * the browser_redirect job in one action). In `--json` mode it emits one JSON
 * object: the transient disclosure (so a caller can complete the sign-in), the
 * terminal outcome (with a typed `nextAction` on the fallback), or a
 * detached/error envelope. Returns the process exit code (0 on success).
 */
export async function streamDurableCodexLogin(
  addr: ControlApiAddress,
  jobId: string,
  opts: StreamDurableCodexLoginOptions = { label: "codex" },
): Promise<number> {
  const { label } = opts;
  const json = opts.json ?? false;
  const pollMs = opts.pollMs ?? POLL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const fetchImpl: FetchLike =
    opts.fetchImpl ?? ((path, init) => controlApiFetch(addr, path, init));
  const promptYesNo = opts.promptYesNo ?? defaultPromptYesNo;
  let disclosed = false;
  let detached = false;
  const onSigint = () => {
    detached = true;
  };
  process.once("SIGINT", onSigint);
  try {
    for (;;) {
      if (detached) {
        if (json) {
          printJson({ ok: true, detached: true, jobId });
          return 0;
        }
        print(
          `Detached. ${label} login keeps running as ${jobId}; ` +
            `re-attach with \`claudexor auth status\` or finish it in the browser.`,
        );
        return 0;
      }
      const response = await fetchImpl(`/setup/jobs/${encodeURIComponent(jobId)}/snapshot`);
      if (!response.ok) {
        if (json) {
          printJson({ ok: false, error: "snapshot_unavailable", status: response.status, jobId });
          return 1;
        }
        print(
          `could not read ${label} login status (${response.status}); it keeps running as ${jobId}`,
        );
        return 1;
      }
      const snapshot = ControlSetupJobSnapshot.parse(await response.json());
      const job = snapshot.job;
      const terminal = isTerminalControlSetupJobState(job.state as ControlSetupJobState);

      if (json) {
        // Return promptly once we know the flow's shape: a disclosure means the
        // app-server supports device-code (hand the caller the code/URL); a
        // terminal state (e.g. the fast device_auth_unsupported miss) carries
        // the typed nextAction. This keeps `--json` bounded — it never blocks
        // waiting for a human to finish the browser step.
        if (!terminal && snapshot.deviceCode) {
          printJson({
            ok: true,
            job,
            deviceCode: {
              flow: snapshot.deviceCode.flow,
              verificationUrl: snapshot.deviceCode.verificationUrl,
              userCode: snapshot.deviceCode.userCode,
            },
          });
          return 0;
        }
        if (terminal) {
          const nextAction = terminalLoginFallback(job);
          printJson({ ok: job.state === "succeeded", job, ...(nextAction ? { nextAction } : {}) });
          return job.state === "succeeded" ? 0 : 1;
        }
        await sleep(pollMs);
        continue;
      }

      // TTY mode.
      if (snapshot.deviceCode && !disclosed) {
        disclosed = true;
        print("");
        print(`Open:    ${snapshot.deviceCode.verificationUrl}`);
        if (snapshot.deviceCode.userCode) print(`Code:    ${snapshot.deviceCode.userCode}`);
        print(`Waiting for OpenAI… (Ctrl-C detaches; the login keeps running)`);
        print("");
      }
      if (terminal) {
        // device_auth_unsupported is a real fork, not a dead end: OFFER to start
        // the legacy Terminal sign-in in one action (explicit y/N — never a
        // silent fallback). Declining, or a non-TTY, falls back to the typed
        // report that names the exact next command.
        if (opts.fallback && terminalLoginFallback(job)) {
          print(
            `${label} login not_supported (device_auth_unsupported): this codex build has no in-app device-code sign-in.`,
          );
          const yes = await promptYesNo(
            "Start the legacy Terminal (browser-redirect) sign-in now? [y/N] ",
          );
          if (yes) return await createTerminalFallbackJob(fetchImpl, opts.fallback, label);
          print(
            opts.fallback.profileId
              ? "You can retry this profile with the legacy Terminal (browser-redirect) sign-in later."
              : "You can start it later with `claudexor auth login codex --browser-redirect`.",
          );
          return 1;
        }
        const report = terminalLoginReport(job, label, { profileId: opts.fallback?.profileId });
        for (const line of report.lines) print(line);
        return report.exitCode;
      }
      await sleep(pollMs);
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
