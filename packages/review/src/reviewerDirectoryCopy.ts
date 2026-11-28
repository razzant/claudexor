import { cp } from "node:fs/promises";
import { relative, sep } from "node:path";
import {
  shareImmutableFile,
  writeIndependentCopy,
  type RunContentIndex,
} from "@claudexor/workspace";

/**
 * One file of a directory result's persistent evidence record. A captured blob
 * is immutable and named by its digest, and this record is engine-owned, so the
 * blob is shared; every other packet file (some are rewritten in place) gets an
 * independent copy. Both keep a large sparse file's holes. An admitted link keeps
 * its target as written, so a relative one names this record's own file.
 */
export async function copyDirectoryEvidenceFile(
  sourceEvidenceDir: string,
  sourcePath: string,
  targetPath: string,
  info: { size: number; mode: number; isFile(): boolean },
  /** The run's index (or none): a blob it verified, unchanged since, is linked unread. */
  payload?: boolean | RunContentIndex,
): Promise<void> {
  const index = typeof payload === "object" ? payload : undefined;
  if (!info.isFile())
    return cp(sourcePath, targetPath, {
      recursive: false,
      dereference: false,
      verbatimSymlinks: true,
    });
  const rel = relative(sourceEvidenceDir, sourcePath).split(sep).join("/");
  const blob = /^final\/files\/content\/([0-9a-f]{64})$/.exec(rel)?.[1];
  if (blob)
    await shareImmutableFile(
      sourcePath,
      targetPath,
      { sha256: `sha256:${blob}`, sizeBytes: info.size },
      index,
    );
  else await writeIndependentCopy(sourcePath, targetPath, { mode: info.mode & 0o777 });
}
