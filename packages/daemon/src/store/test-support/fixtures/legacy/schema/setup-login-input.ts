import { z } from "zod/v3";
import * as SetupLoginProtocol from "./setup-login-protocol.js";
import { SetupLoginProtocolVersion } from "./setup-login.js";

const SetupTimestamp = z.string().datetime({ offset: true });

/** One-shot sign-in input for a url_disclosure_with_input login job (claude's
 * manual paste-code completion). TRANSIENT: the value rides the runner's
 * private input sidecar to the vendor CLI's stdin and is never journaled,
 * logged, or persisted anywhere durable (the same rule the one-time
 * `userCode` follows). */
export const ControlSetupJobInputRequest = z
  .object({
    value: z
      .string()
      .min(1)
      .max(1024)
      .describe("The user's one-time sign-in input (e.g. the pasted OAuth code); never persisted."),
  })
  .strict()
  .describe("One-shot sign-in input delivered to a waiting login job's vendor CLI.");
export type ControlSetupJobInputRequest = z.infer<typeof ControlSetupJobInputRequest>;

/** TRANSIENT one-shot input sidecar (url_disclosure_with_input): written once
 * by the daemon from POST /v2/setup/jobs/:id/input, read once by the runner,
 * delivered to the vendor CLI's stdin. The value is never journaled. */
export const SetupLoginInput = z
  .object({
    version: SetupLoginProtocolVersion,
    jobId: SetupLoginProtocol.SetupLoginJobId,
    executionId: SetupLoginProtocol.SetupLoginExecutionId,
    value: z.string().min(1).max(1024),
    submittedAt: SetupTimestamp,
  })
  .strict();
export type SetupLoginInput = z.infer<typeof SetupLoginInput>;
