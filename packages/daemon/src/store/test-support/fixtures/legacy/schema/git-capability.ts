import { z } from "zod/v3";

/**
 * Live Git executable readiness in one execution location. The Apple launcher
 * is distinct from an absent executable because its remediation is specific.
 */
export const GitCapability = z
  .object({
    status: z.enum(["available", "missing", "developer_tools_stub", "failed"]),
    version: z.string().nullable(),
    detail: z.string().nullable(),
    remediation: z.string().nullable(),
  })
  .strict()
  .describe("Live Git executable readiness for workspace/envelope operations.");
export type GitCapability = z.infer<typeof GitCapability>;
