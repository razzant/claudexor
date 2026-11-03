import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { acquireRootAuthority, readRootAuthority } from "@claudexor/daemon";
import { afterEach, describe, expect, it } from "vitest";

const fixtureRoot = resolve(import.meta.dirname, "fixtures", "legacy-v3.3.7");
const claimantPath = join(fixtureRoot, "writer-claimant.cjs");
const provenancePath = join(fixtureRoot, "provenance.json");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("exact-v3.3.7 legacy writer claimant fixture", () => {
  it("binds the executable fixture to the exact tag/commit/blob/source bytes and parity markers", () => {
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as {
      tag: string;
      commit: string;
      sourcePath: string;
      sourceBlob: string;
      sourceSha256: string;
      fixtureSha256: string;
      parityMarkers: string[];
    };
    expect(provenance).toMatchObject({
      tag: "v3.3.7",
      commit: "a4b004d79d54bfe03735a247c40b297552c2a624",
      sourcePath: "packages/daemon/src/writer-lease.ts",
      sourceBlob: "f2cde81164ee0843b22fb8266e43193d2f05f1eb",
      sourceSha256: "f8bf76956c24bdadec40ff2917f59bc6c2dfff02e15b9f4a4cc14ec9151b8344",
    });
    const source = execFileSync("git", ["show", `${provenance.tag}:${provenance.sourcePath}`], {
      cwd: resolve(import.meta.dirname, "../../.."),
      encoding: "utf8",
    });
    const fixture = readFileSync(claimantPath, "utf8");
    expect(
      execFileSync("git", ["rev-parse", `${provenance.tag}^{commit}`], { encoding: "utf8" }).trim(),
    ).toBe(provenance.commit);
    expect(
      execFileSync("git", ["rev-parse", `${provenance.tag}:${provenance.sourcePath}`], {
        encoding: "utf8",
      }).trim(),
    ).toBe(provenance.sourceBlob);
    expect(sha256(source)).toBe(provenance.sourceSha256);
    expect(sha256(fixture)).toBe(provenance.fixtureSha256);
    for (const marker of provenance.parityMarkers) {
      expect(source, `tag source missing parity marker: ${marker}`).toContain(marker);
      expect(fixture, `fixture missing parity marker: ${marker}`).toContain(marker);
    }
  });

  it("fails closed at every step of the stale-flat first migration; the address is never absent (C4)", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "claudexor-legacy-claimant-"));
    roots.push(dataRoot);
    const daemonRoot = join(dataRoot, "daemon");
    mkdirSync(daemonRoot, { recursive: true, mode: 0o700 });
    const socketPath = join(daemonRoot, "claudexord.sock");
    const anchor = `${socketPath}.writer`;
    // A DEAD pre-fix owner holds the flat legacy address: the exact state the
    // first migration converts. Before our first mutation a legacy claimant
    // may still win (D3's bounded limitation); after it, never.
    mkdirSync(anchor, { mode: 0o700 });
    writeFileSync(join(anchor, "owner.json"), '{"pid":2147483646,"token":"legacy"}\n', {
      mode: 0o600,
    });

    const probeLegacyClaimant = (step: string): void => {
      expect(lstatSync(anchor).isDirectory(), `address absent at ${step}`).toBe(true);
      const result = spawnSync(process.execPath, [claimantPath], {
        cwd: dataRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDEXOR_CONFIG_DIR: dataRoot,
          CLAUDEXOR_DAEMON_SOCK: socketPath,
        },
      });
      expect(result.status, `legacy claimant won at ${step}: ${result.stdout}`).toBe(1);
      expect(lstatSync(anchor).isDirectory(), `claimant destroyed the address at ${step}`).toBe(
        true,
      );
    };

    // Every rename/remove of the migration flows through the lease seam. The
    // canonical address itself must never be renamed away or removed — that
    // is the absence window a newly arriving legacy claimant wins.
    let mutations = 0;
    const grant = acquireRootAuthority({
      socketPath,
      version: "3.4.0",
      canonicalSocketPath: socketPath,
      deps: {
        filesystem: {
          rename: (from, to) => {
            expect(from, "the migration renamed the canonical address away").not.toBe(anchor);
            renameSync(from, to);
            mutations += 1;
            probeLegacyClaimant(
              `after rename #${mutations} (${basename(from)} -> ${basename(to)})`,
            );
          },
          remove: (path) => {
            expect(path, "the migration removed the canonical address").not.toBe(anchor);
            rmSync(path, { recursive: true, force: true });
          },
        },
      },
    });
    expect(mutations).toBeGreaterThanOrEqual(2);
    // Final state: permanent barrier + nested claim; the stale owner record is
    // preserved as evidence inside the same directory; no parseable owner.
    expect(readRootAuthority(anchor)).toMatchObject({ status: "valid" });
    probeLegacyClaimant("after barrier installation");
    expect(() => readFileSync(join(anchor, "owner.json"))).toThrow();
    expect(
      readdirSync(anchor).some((name) => name.startsWith("owner.stale-") && name.endsWith(".json")),
    ).toBe(true);
    expect(grant.lease.path).toBe(join(anchor, "active.writer"));
    grant.release();
  });

  it("fails before journal/GC when a later opaque barrier occupies the canonical legacy path", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "claudexor-legacy-claimant-"));
    roots.push(dataRoot);
    const daemonRoot = join(dataRoot, "daemon");
    const socketPath = join(daemonRoot, "claudexord.sock");
    const barrier = `${socketPath}.writer`;
    mkdirSync(barrier, { recursive: true, mode: 0o700 });
    const marker = join(barrier, "root-authority-v2.json");
    writeFileSync(marker, '{"schemaVersion":2,"state":"vacant"}\n', { mode: 0o600 });
    const before = readFileSync(marker);

    const result = spawnSync(process.execPath, [claimantPath], {
      cwd: dataRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDEXOR_CONFIG_DIR: dataRoot,
        CLAUDEXOR_DAEMON_SOCK: socketPath,
      },
    });

    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: "daemon_writer_busy",
      stage: "writer_claim",
    });
    expect(readFileSync(marker)).toEqual(before);
    expect(() => readFileSync(join(daemonRoot, "journal", "events.log"))).toThrow();
  });
});
