/**
 * What a retirement's cleanup may delete: only lane entries whose bytes the
 * accepted export holds, checked on every attempt and once more, synchronously,
 * immediately before the deletion.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { threadExportItemId, threadExportLinkIdentity } from "@claudexor/schema";
import { verifyLaneRemoval } from "./thread-export-digests.js";

const THREAD = "th-lane";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
const stores = (lane: string) => (lane.startsWith("codex-") ? [".codex/auth.json"] : null);

function lane() {
  const root = mkdtempSync(join(tmpdir(), "cx-lane-removal-"));
  roots.push(root);
  const files: Record<string, string> = {
    "codex-default/home/a.txt": "accepted a\n",
    "summaries/s.md": "summary\n",
  };
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  for (const [rel, text] of Object.entries(files)) put(rel, text);
  // Engine credential material: never exported, removed with the lane.
  put("codex-default/home/.codex/auth.json", "AUTH");
  symlinkSync("/nowhere", join(root, "codex-default", "home", "link"));
  const accepted = [
    ...Object.entries(files).map(([rel, text]) => ({
      itemId: threadExportItemId("lane", `lanes/${THREAD}/${rel}`),
      sha256: `sha256:${createHash("sha256").update(text).digest("hex")}`,
      sizeBytes: Buffer.byteLength(text),
    })),
    {
      itemId: threadExportItemId("lane", `lanes/${THREAD}/codex-default/home/link`),
      ...threadExportLinkIdentity("/nowhere"),
    },
  ];
  return { root, put, accepted };
}

describe("verifying a lane before its cleanup deletes it", () => {
  it("passes accepted bytes, a partial deletion and credential stores", async () => {
    const f = lane();
    const unchanged = await verifyLaneRemoval(THREAD, f.root, stores, f.accepted);
    expect(unchanged()).toBeNull();
    rmSync(join(f.root, "summaries"), { recursive: true });
    f.put("codex-default/home/.codex/auth.json", "ROTATED");
    expect(unchanged()).toBeNull();
    // What vanished was accepted: a later attempt over what remains passes too.
    expect((await verifyLaneRemoval(THREAD, f.root, stores, f.accepted))()).toBeNull();
    expect(
      (await verifyLaneRemoval(THREAD, join(f.root, "absent"), stores, f.accepted))(),
    ).toBeNull();
  });

  it.each([
    [
      "an accepted byte changed",
      (f: ReturnType<typeof lane>) => f.put("codex-default/home/a.txt", "changed!!!\n"),
    ],
    [
      "a file arrived",
      (f: ReturnType<typeof lane>) => f.put("codex-default/home/new.txt", "new\n"),
    ],
    [
      "a link was retargeted",
      (f: ReturnType<typeof lane>) => {
        rmSync(join(f.root, "codex-default", "home", "link"));
        symlinkSync("/elsewhere", join(f.root, "codex-default", "home", "link"));
      },
    ],
    [
      "a lane of an undeclared harness appeared",
      (f: ReturnType<typeof lane>) => f.put("cursor-default/home/x", "x\n"),
    ],
  ])("refuses before deleting anything when %s", async (_name, change) => {
    const f = lane();
    change(f);
    await expect(verifyLaneRemoval(THREAD, f.root, stores, f.accepted)).rejects.toThrow();
  });

  it.each([
    [
      "an accepted byte changed",
      (f: ReturnType<typeof lane>) => f.put("codex-default/home/a.txt", "changed!!!\n"),
      "codex-default/home/a.txt",
    ],
    [
      "a file arrived",
      (f: ReturnType<typeof lane>) => f.put("codex-default/home/new.txt", "new\n"),
      "codex-default/home/new.txt",
    ],
  ])(
    "its synchronous recheck names what changed since it was verified: %s",
    async (_name, change, rel) => {
      const f = lane();
      const unchanged = await verifyLaneRemoval(THREAD, f.root, stores, f.accepted);
      change(f);
      expect(unchanged()).toBe(rel);
    },
  );
});
