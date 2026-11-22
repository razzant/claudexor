import { z } from "zod/v3";

export const ControlArtifactInfo = z
  .object({
    path: z.string().describe("Artifact path relative to the run directory."),
    kind: z.enum(["file", "directory"]).describe("Whether the artifact is a file or a directory."),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Size in bytes; absent for directories."),
    /** Clean MIME type derived from the extension (e.g. `image/png`, `text/plain`,
     *  `application/pdf`); lets a gallery render text vs image vs pdf. Absent for
     *  directories. */
    mime: z
      .string()
      .optional()
      .describe("MIME type derived from the extension; absent for directories."),
  })
  .describe("One artifact in the run's artifact tree.");
export type ControlArtifactInfo = z.infer<typeof ControlArtifactInfo>;
