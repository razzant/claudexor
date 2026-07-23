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
import {
  ControlSetupJobSnapshot,
  isTerminalControlSetupJobState,
  type ControlSetupJobState,
} from "@claudexor/schema";
import { print } from "./cli-io.js";
import { controlApiFetch, type ControlApiAddress } from "./live.js";

const POLL_MS = 1_000;

/** Poll a device-code login job to its terminal outcome, printing the inline
 * disclosure once. Returns the process exit code (0 on success). */
export async function streamDurableCodexLogin(
  addr: ControlApiAddress,
  jobId: string,
  opts: { label: string; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {
    label: "codex",
  },
): Promise<number> {
  const pollMs = opts.pollMs ?? POLL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let disclosed = false;
  let detached = false;
  const onSigint = () => {
    detached = true;
  };
  process.once("SIGINT", onSigint);
  try {
    for (;;) {
      if (detached) {
        print(
          `Detached. ${opts.label} login keeps running as ${jobId}; ` +
            `re-attach with \`claudexor auth status\` or finish it in the browser.`,
        );
        return 0;
      }
      const response = await controlApiFetch(
        addr,
        `/setup/jobs/${encodeURIComponent(jobId)}/snapshot`,
      );
      if (!response.ok) {
        print(
          `could not read ${opts.label} login status (${response.status}); it keeps running as ${jobId}`,
        );
        return 1;
      }
      const snapshot = ControlSetupJobSnapshot.parse(await response.json());
      const job = snapshot.job;
      if (snapshot.deviceCode && !disclosed) {
        disclosed = true;
        print("");
        print(`Open:    ${snapshot.deviceCode.verificationUrl}`);
        if (snapshot.deviceCode.userCode) print(`Code:    ${snapshot.deviceCode.userCode}`);
        print(`Waiting for OpenAI… (Ctrl-C detaches; the login keeps running)`);
        print("");
      }
      if (isTerminalControlSetupJobState(job.state as ControlSetupJobState)) {
        print(`${opts.label} login ${job.state}: ${job.message}`);
        return job.state === "succeeded" ? 0 : 1;
      }
      await sleep(pollMs);
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
