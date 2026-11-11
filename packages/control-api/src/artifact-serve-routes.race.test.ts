import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

// GH #128: artifact enumeration races live tree mutation — git writes
// `.git/objects/xx/tmp_obj_*` then renames (the reviewer-workspace baseline
// repo lives INSIDE the run tree), and reviewer-workspace cleanup rm -rf's
// thousands of files while detail polls walk the same tree. The mid-walk
// vanish window cannot be hit by real timing in a test (the walk is
// synchronous), so — exactly like claude-bridge-race.test.ts — we mock
// `node:fs.lstatSync` to throw for selected paths over a REAL tmp tree.
// This mock lives in its OWN file: a module-level fs mock inside
// control-api.test.ts would poison every unrelated case there.
const state = vi.hoisted(() => ({
  vanishSuffix: null as string | null,
  epermSuffix: null as string | null,
  eaccesSuffix: null as string | null,
}));

vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    lstatSync: (path: Parameters<typeof actual.lstatSync>[0], ...rest: unknown[]) => {
      const p = String(path);
      if (state.vanishSuffix && p.endsWith(state.vanishSuffix)) {
        throw Object.assign(new Error(`ENOENT: simulated mid-walk vanish ${p}`), {
          code: "ENOENT",
        });
      }
      if (state.epermSuffix && p.endsWith(state.epermSuffix)) {
        throw Object.assign(new Error(`EPERM: simulated permission failure ${p}`), {
          code: "EPERM",
        });
      }
      if (state.eaccesSuffix && p.endsWith(state.eaccesSuffix)) {
        throw Object.assign(new Error(`EACCES: simulated access denial ${p}`), {
          code: "EACCES",
        });
      }
      return (actual.lstatSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
    // Mirror the real existsSync semantics for the simulated EACCES paths:
    // Node's existsSync collapses EVERY stat failure into `false`, which is
    // exactly why the guards must not precheck with it (E-C2). Without this
    // branch, an existsSync precheck reintroduced into artifact-paths.ts
    // would pass the mocked EACCES tests (real dirs exist on disk), making
    // the regression pin revert-invariant — proven by the R2 revert-probe.
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => {
      const p = String(path);
      if (state.eaccesSuffix && p.endsWith(state.eaccesSuffix)) return false;
      return actual.existsSync(path);
    },
  };
});

// Imported AFTER the mock declaration; vi.mock is hoisted so the named
// `lstatSync` bindings in artifact-paths.ts / artifact-serve-routes.ts resolve
// to the mocked module (readdirSync/realpathSync stay real; existsSync is
// mocked ONLY for the simulated-EACCES paths, real everywhere else).
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
const { listArtifacts } = await import("./artifact-serve-routes.js");
const { safeArtifactPath, safeArtifactRoot } = await import("./artifact-paths.js");

describe("artifact enumeration under concurrent-mutation races (GH #128)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-artifact-race-"));
    state.vanishSuffix = null;
    state.epermSuffix = null;
    state.eaccesSuffix = null;
  });
  afterEach(() => {
    state.vanishSuffix = null;
    state.epermSuffix = null;
    state.eaccesSuffix = null;
    rmSync(dir, { recursive: true, force: true });
  }, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

  it("skips an entry that vanishes between readdir and lstat and lists the survivors", () => {
    writeFileSync(join(dir, "keep.txt"), "kept\n");
    writeFileSync(join(dir, "vanishing.txt"), "gone\n");
    state.vanishSuffix = `${sep}vanishing.txt`; // readdir really returned it; lstat finds it gone
    const listed = listArtifacts(dir);
    expect(listed.map((a) => a.path)).toEqual(["keep.txt"]);
  });

  it("never enumerates a real .git subtree while siblings stay listed (unmocked)", () => {
    mkdirSync(join(dir, ".git", "objects", "e5"), { recursive: true });
    writeFileSync(join(dir, ".git", "objects", "e5", "tmp_obj_x"), "x");
    writeFileSync(join(dir, "report.md"), "# r\n");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "notes.txt"), "n\n");
    const paths = listArtifacts(dir).map((a) => a.path);
    expect(paths).toEqual(["report.md", "sub", "sub/notes.txt"]);
    expect(paths.some((p) => p === ".git" || p.startsWith(".git/"))).toBe(false);
  });

  it("resolves a fetch path whose lstat reports a mid-window vanish to null, not a throw", () => {
    writeFileSync(join(dir, "artifact.json"), "{}");
    state.vanishSuffix = `${sep}artifact.json`; // on disk, yet lstat says gone — the vanish window
    expect(safeArtifactPath(dir, "artifact.json")).toBeNull();
  });

  it("keeps non-vanish errnos loud: EPERM on lstat still throws", () => {
    writeFileSync(join(dir, "locked.txt"), "x");
    state.epermSuffix = `${sep}locked.txt`;
    expect(() => listArtifacts(dir)).toThrow(/EPERM/);
  });

  // Guard level (no existsSync precheck — it would collapse EACCES into `false`
  // and answer null, silently converting an access error into "no such
  // artifact"): absence may only come from the lstat errno itself, and an
  // access denial must propagate to the caller, never resolve to null.
  it("propagates EACCES from the fetch-path lstat instead of answering null", () => {
    writeFileSync(join(dir, "locked.txt"), "x");
    state.eaccesSuffix = `${sep}locked.txt`;
    expect(() => safeArtifactPath(dir, "locked.txt")).toThrow(/EACCES/);
  });

  it("propagates EACCES from the root lstat instead of answering null", () => {
    state.eaccesSuffix = dir;
    expect(() => safeArtifactRoot(dir)).toThrow(/EACCES/);
  });

  it("answers null for a genuinely missing root and path via the lstat errno (unmocked)", () => {
    expect(safeArtifactRoot(join(dir, "never-created"))).toBeNull();
    expect(safeArtifactPath(dir, "never-created.txt")).toBeNull();
  });
});
