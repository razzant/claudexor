import { createHash } from "node:crypto";
import { join } from "node:path";

export function journalPartitionDirectory(rootDir: string, partition: string): string {
  if (!partition.trim()) throw new Error("journal partition must not be empty");
  const slug = partition.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 48) || "partition";
  const digest = createHash("sha256").update(Buffer.from(partition)).digest("hex");
  return join(rootDir, `${slug}-${digest.slice(0, 12)}`);
}
