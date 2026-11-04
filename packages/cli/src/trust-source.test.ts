import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateTrustConfig } from "@claudexor/config";
import { listTrustService } from "./trust-services.js";

const listed = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@claudexor/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@claudexor/config")>();
  return {
    ...actual,
    listTrustConfigs: async (...args: Parameters<typeof actual.listTrustConfigs>) => {
      listed.calls += 1;
      return actual.listTrustConfigs(...args);
    },
  };
});

const dirs: string[] = [];
afterEach(() => {
  listed.calls = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function isolated(): string {
  const dir = mkdtempSync(join(tmpdir(), "cx-trust-source-"));
  dirs.push(dir);
  process.env.CLAUDEXOR_CONFIG_DIR = dir;
  return dir;
}

describe("scoped trust says whether the file exists", () => {
  it("returns default for a missing file and does not list every repo", async () => {
    isolated();
    const repo = "/tmp/cx-trust-missing-repo";
    const listedBefore = listed.calls;
    const body = await listTrustService({ repoRoot: repo });
    expect(body.entries).toEqual([
      expect.objectContaining({
        repoRoot: repo,
        allowFullAccess: false,
        source: "default",
      }),
    ]);
    expect(listed.calls).toBe(listedBefore);
  });

  it("returns file when allowFullAccess was explicitly written false", async () => {
    isolated();
    const repo = join("/tmp", "cx-trust-explicit-false");
    updateTrustConfig(repo, (cfg) => ({ ...cfg, allow_full_access: false }));
    const body = await listTrustService({ repoRoot: repo });
    expect(body.entries[0]).toMatchObject({ allowFullAccess: false, source: "file" });
    expect(listed.calls).toBe(0);
  });

  it("the unscoped list still walks trust files and omits source", async () => {
    isolated();
    const repo = join("/tmp", "cx-trust-listed");
    updateTrustConfig(repo, (cfg) => ({ ...cfg, allow_full_access: true }));
    const body = await listTrustService();
    expect(listed.calls).toBe(1);
    expect(body.entries.map((entry) => entry.source)).toEqual([undefined]);
    expect(body.entries[0]).toMatchObject({ repoRoot: repo, allowFullAccess: true });
  });
});
