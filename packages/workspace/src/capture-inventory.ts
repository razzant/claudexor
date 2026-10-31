import {
  CAPTURE_INVENTORY_LIMIT,
  CaptureChangeInventory,
  type CaptureInventoryEntry,
} from "@claudexor/schema";
import { gitEnv } from "./git-run.js";

const CHANGE: Record<string, CaptureInventoryEntry["change"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  T: "type_changed",
};

/**
 * A bounded, NON-EXACT inventory of the changed files behind a refused capture:
 * its own tree-to-tree `git diff --raw` and blob-size pass over the candidate
 * tree the capture already wrote, through the same raw capture budget. It never
 * reads file contents or the refused patch bytes (those are already released).
 * Null when this pass cannot complete; the capture refusal stands either way.
 */
export async function changedFileInventory(
  repo: string,
  baseSha: string,
  tree: string,
  env: Record<string, string>,
): Promise<CaptureChangeInventory | null> {
  try {
    const raw = await gitEnv(
      repo,
      ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", baseSha, tree],
      env,
    );
    if (raw.code !== 0) return null;
    // `-z --raw`: ":<old mode> <new mode> <old oid> <new oid> <status>\0<path>\0".
    const fields = raw.stdout.split("\0");
    const rows: { path: string; change: CaptureInventoryEntry["change"]; oid: string }[] = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const meta = fields[index]!;
      const [, , oldOid, newOid, status] = meta.slice(1).split(" ");
      const change = CHANGE[status ?? ""];
      // An unexpected record yields no inventory rather than a wrong one.
      if (!meta.startsWith(":") || !change || !oldOid || !newOid) return null;
      rows.push({ path: fields[index + 1]!, change, oid: change === "deleted" ? oldOid : newOid });
    }
    const sizes = new Map<string, number>();
    const oids = [...new Set(rows.map((row) => row.oid))];
    if (oids.length > 0) {
      const check = await gitEnv(
        repo,
        ["cat-file", "--batch-check=%(objectname) %(objectsize)"],
        env,
        `${oids.join("\n")}\n`,
      );
      // A missing object (a submodule link) answers "<oid> missing": size unknown.
      for (const line of check.code === 0 ? check.stdout.split("\n") : []) {
        const [oid, size] = line.split(" ");
        if (oid && size && /^\d+$/.test(size)) sizes.set(oid, Number(size));
      }
    }
    const entries = rows
      .map((row) => ({
        // A changed path is working content: exact, within the entry's length cap.
        path: row.path.slice(0, 1024),
        change: row.change,
        sizeBytes: sizes.get(row.oid) ?? null,
      }))
      .sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) || a.path.localeCompare(b.path));
    return CaptureChangeInventory.parse({
      exact: false,
      changedFiles: rows.length,
      largest: entries.slice(0, CAPTURE_INVENTORY_LIMIT),
    });
  } catch {
    // Its own overflow, timeout or I/O fault leaves no inventory, never a partial claim.
    return null;
  }
}
