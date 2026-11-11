import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writePatchObject, prunePatchObjects } from "@claudexor/util";
import { treeReclaimableBytes } from "./retention-bytes.js";

it("counts shared patch bytes once in both preview and actual retirement", async () => {
  const root = mkdtempSync(join(tmpdir(), "retention-linked-"));
  try {
    const run = join(root, "runs", "r");
    writePatchObject(root, join(run, "attempts/a/patch.diff"), "same bytes");
    writePatchObject(root, join(run, "final/patch.diff"), "same bytes");
    const planned = new Map<string, number>();
    expect(await treeReclaimableBytes(run, planned)).toBe(0);
    expect(await prunePatchObjects(root, true, planned)).toBe(10);
    expect(await treeReclaimableBytes(run, new Map())).toBe(0);
    rmSync(run, { recursive: true });
    expect(await prunePatchObjects(root, false)).toBe(10);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
