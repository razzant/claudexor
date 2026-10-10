import { z } from "zod/v3";

export const WorkspaceKind = z.enum(["git", "directory"]);
export type WorkspaceKind = z.infer<typeof WorkspaceKind>;

export const WorkspaceScopePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value === "." ||
      (!value.startsWith("/") &&
        !value.includes("\\") &&
        !value.includes("\0") &&
        !/^[A-Za-z]:/.test(value) &&
        value.split("/").every((part) => part !== "" && part !== "." && part !== "..")),
    "Expected a relative file/directory path or '.' for the selected whole tree",
  );
const FilePath = WorkspaceScopePath.refine((value) => value !== ".", "Expected a file entry path");
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const WorkspaceFileState = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("file"),
      sha256: Digest,
      sizeBytes: z.number().int().nonnegative(),
      mode: z.number().int().nonnegative(),
      artifactPath: FilePath.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("directory"), mode: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("symlink"), target: z.string() }).strict(),
]);
export type WorkspaceFileState = z.infer<typeof WorkspaceFileState>;

export const WorkspaceFilePreimage = z
  .union([WorkspaceFileState, z.null(), z.literal("unknown")])
  .describe("Null proves absence; unknown means this path has no captured application preimage.");
export type WorkspaceFilePreimage = z.infer<typeof WorkspaceFilePreimage>;

export const WorkspaceFileChange = z
  .object({
    path: FilePath,
    before: WorkspaceFilePreimage,
    after: WorkspaceFileState.nullable(),
  })
  .strict();
export type WorkspaceFileChange = z.infer<typeof WorkspaceFileChange>;

export const WorkspaceFilesManifest = z
  .object({
    version: z.literal(1),
    sourceRoot: z.string().min(1),
    executionRoot: z.string().min(1),
    isolation: z.enum(["live", "envelope"]),
    scopePaths: z.array(WorkspaceScopePath),
    complete: z
      .boolean()
      .describe("Complete bytes for the declared footprint, not a whole-source-tree claim."),
    entries: z.array(WorkspaceFileChange),
  })
  .strict()
  .superRefine((manifest, context) => {
    const seen = new Set<string>();
    for (const [index, entry] of manifest.entries.entries()) {
      if (seen.has(entry.path))
        context.addIssue({
          code: "custom",
          path: ["entries", index, "path"],
          message: "Duplicate path",
        });
      seen.add(entry.path);
      if (entry.after?.kind === "file" && !entry.after.artifactPath)
        context.addIssue({
          code: "custom",
          path: ["entries", index, "after"],
          message: "A file output requires its complete artifact",
        });
      if (
        manifest.isolation === "envelope" &&
        entry.before !== "unknown" &&
        entry.before?.kind === "file" &&
        !entry.before.artifactPath
      )
        context.addIssue({
          code: "custom",
          path: ["entries", index, "before"],
          message: "A copied result requires a reproducible baseline",
        });
    }
  });
export type WorkspaceFilesManifest = z.infer<typeof WorkspaceFilesManifest>;
