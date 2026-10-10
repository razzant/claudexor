import { z } from "zod/v3";
import { GitCapability } from "./git-capability.js";
import { HarnessStatusDto } from "./readiness.js";

export const ControlHarnessListResponse = z
  .object({
    harnesses: z
      .array(HarnessStatusDto)
      .default([])
      .describe("Status rows for all known harnesses."),
    git: GitCapability.optional().describe(
      "Execution-location Git readiness; omitted by daemons predating capability projection.",
    ),
  })
  .describe("Response for GET /harnesses.");
export type ControlHarnessListResponse = z.infer<typeof ControlHarnessListResponse>;
