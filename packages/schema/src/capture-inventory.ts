import { z } from "zod/v3";

/** Most changed files one inventory lists (largest first). */
export const CAPTURE_INVENTORY_LIMIT = 20;

export const CaptureInventoryEntry = z
  .object({
    path: z.string().max(1024).describe("Top-relative changed path, exact within the length cap."),
    change: z
      .enum(["added", "modified", "deleted", "type_changed"])
      .describe("What happened to the path between the turn's base and the uncaptured tree."),
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        "Size of the new blob (of the old blob for a deletion); null when Git could not size it.",
      ),
  })
  .describe("One changed path of a non-exact capture inventory.");
export type CaptureInventoryEntry = z.infer<typeof CaptureInventoryEntry>;

/**
 * A bounded, explicitly NON-EXACT listing of the largest changed files behind a
 * refused capture. Its own tree-to-tree Git pass produces it under the same
 * output budget; it never reuses the refused patch bytes, is never a patch and
 * can never be applied, reviewed or reverted.
 */
export const CaptureChangeInventory = z
  .object({
    exact: z
      .literal(false)
      .describe("Always false: an inventory names files; it is not the exact change."),
    changedFiles: z.number().int().nonnegative().describe("Changed paths the pass counted."),
    largest: z
      .array(CaptureInventoryEntry)
      .max(CAPTURE_INVENTORY_LIMIT)
      .describe("The largest changed files, largest first."),
  })
  .describe("Bounded non-exact inventory of the changed files behind a refused capture.");
export type CaptureChangeInventory = z.infer<typeof CaptureChangeInventory>;

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "size unknown";
  const units = ["bytes", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(1)} ${units[unit]} (${bytes} bytes)`;
}

/** THE one text projection of an inventory (run summary, CLI inspect). */
export function captureInventoryLines(inventory: CaptureChangeInventory): string[] {
  const omitted = inventory.changedFiles - inventory.largest.length;
  return [
    `Largest changed files (inventory, not exact, not a patch): ${inventory.changedFiles} changed` +
      (omitted > 0 ? `, ${omitted} not listed` : ""),
    ...inventory.largest.map(
      (entry) => `- ${entry.change} ${entry.path} · ${formatBytes(entry.sizeBytes)}`,
    ),
  ];
}
