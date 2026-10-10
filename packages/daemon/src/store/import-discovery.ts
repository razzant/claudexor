import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  PREFIX_BYTES,
  decodeFrameBody,
  journalPartitionDirectory,
  readFramePrefix,
} from "@claudexor/journal";
import { importError } from "./import-context.js";
import type { ImportPartitionSource } from "./import-source.js";

/** Decode legacy names only; no recursive scan, journal writer or new layout.
 * Existing global/project slugs also recover empty or damaged partitions.
 * Other nonempty names come from the first frame through the original codec. */
export function discoverLegacyPartitions(journalRoot: string): ImportPartitionSource[] {
  const result: ImportPartitionSource[] = [];
  for (const entry of readdirSync(journalRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(journalRoot, entry.name),
      file = join(directory, "journal.bin");
    const match = /^project-(.*)-[0-9a-f]{12}$/.exec(entry.name);
    const candidate =
      entry.name === basename(journalPartitionDirectory(journalRoot, "global"))
        ? "global"
        : match
          ? `project:${match[1]}`
          : null;
    if (candidate && journalPartitionDirectory(journalRoot, candidate) === directory) {
      result.push({ name: candidate, directory });
      continue;
    }
    if (!existsSync(file)) continue;
    const name = firstPartitionName(file);
    if (journalPartitionDirectory(journalRoot, name) !== directory)
      throw importError(
        "store_import_partition_identity",
        "legacy partition directory disagrees with its frame identity",
      );
    result.push({ name, directory });
  }
  if (!result.some((row) => row.name === "global"))
    result.push({ name: "global", directory: journalPartitionDirectory(journalRoot, "global") });
  return result;
}

function firstPartitionName(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size,
      prefix = Buffer.alloc(Math.min(PREFIX_BYTES, size));
    readExactly(fd, prefix, 0);
    const decoded = readFramePrefix(prefix, size);
    if (decoded.status !== "frame")
      throw importError(
        "store_import_partition_identity",
        "legacy partition has no readable name; source bytes retained",
      );
    const frame = Buffer.alloc(decoded.frameLength);
    readExactly(fd, frame, 0);
    const body = decodeFrameBody(frame, decoded.headerLength, decoded.payloadLength);
    if (
      body.status !== "frame" ||
      typeof body.header.partition !== "string" ||
      !body.header.partition.trim()
    )
      throw importError(
        "store_import_partition_identity",
        "legacy first frame has no verified partition identity",
      );
    return body.header.partition;
  } finally {
    closeSync(fd);
  }
}
function readExactly(fd: number, bytes: Buffer, position: number): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, position + offset);
    if (!count)
      throw importError(
        "store_import_source_changed",
        "legacy frame changed while reading its identity",
      );
    offset += count;
  }
}
