import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureFailureEvidence } from "./capture-failure.js";
import { FileSpaceError } from "./file-copy.js";
import { WorkspaceManager } from "./manager.js";

// #783: a directory workspace that cannot be prepared for want of room, at any
// step its preparation takes, is the typed space refusal with the system's own
// code and the facts of its cleanup. Git preparations keep their own errors.
const faults = vi.hoisted(() => ({
  mkdir: null as Error | null,
  owner: null as Error | null,
  home: null as Error | null,
  cleanup: null as Error | null,
}));

vi.mock("@claudexor/util", async (original) => {
  const util = await original<typeof import("@claudexor/util")>();
  return {
    ...util,
    ensureDirAsync: async (...args: Parameters<typeof util.ensureDirAsync>) => {
      if (faults.mkdir && String(args[0]).includes(`${join("workspaces", "t")}`))
        throw faults.mkdir;
      return util.ensureDirAsync(...args);
    },
    removeTree: async (...args: Parameters<typeof util.removeTree>) => {
      if (faults.cleanup) throw faults.cleanup;
      return util.removeTree(...args);
    },
  };
});
vi.mock("./preparation-hold.js", async (original) => {
  const hold = await original<typeof import("./preparation-hold.js")>();
  return {
    ...hold,
    writeAtomicAsync: async (path: string, value: unknown) => {
      if (faults.owner && path.endsWith("owner.json")) throw faults.owner;
      return hold.writeAtomicAsync(path, value);
    },
  };
});
vi.mock("./harness-home.js", async (original) => {
  const home = await original<typeof import("./harness-home.js")>();
  return {
    ...home,
    ensureHarnessHomeAsync: async (dir: string) => {
      if (faults.home) throw faults.home;
      return home.ensureHarnessHomeAsync(dir);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  Object.assign(faults, { mkdir: null, owner: null, home: null, cleanup: null });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);

const errno = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });

async function refusal(kind: "directory" | "git") {
  const root = mkdtempSync(join(tmpdir(), "claudexor-prepare-space-"));
  roots.push(root);
  const source = join(root, "source");
  const runtime = join(root, "runtime");
  mkdirSync(source);
  writeFileSync(join(source, "input.txt"), "selected\n");
  const manager = new WorkspaceManager(source, { runtimeRoot: runtime });
  const error = await manager
    .create({
      taskId: "t",
      attemptId: "a",
      ...(kind === "directory" ? { workspaceKind: "directory" as const, scopePaths: ["."] } : {}),
    })
    .then(
      () => null,
      (caught: unknown) => caught,
    );
  const base = join(runtime, "workspaces", "t");
  return { error, leftovers: existsSync(base) ? readdirSync(base) : [] };
}

describe("a directory workspace that cannot be prepared for want of room", () => {
  it.each([
    ["its base directory", "mkdir", "ENOSPC"],
    ["owner.json", "owner", "EDQUOT"],
    ["the scoped harness home", "home", "ENOSPC"],
  ] as const)("names %s's lack of room with the system's code", async (_step, step, code) => {
    faults[step] = errno(code);
    const { error, leftovers } = await refusal("directory");
    expect(error).toBeInstanceOf(FileSpaceError);
    expect(captureFailureEvidence(error as Error)).toMatchObject({
      code: "capture_space_insufficient",
      causeCode: code,
    });
    expect((error as Error).message).toContain("directory preparation ran out of space");
    // The never-started envelope was removed; no cleanup fault is reported.
    expect(leftovers).toEqual([]);
    expect(captureFailureEvidence(error as Error).cleanup).toBeUndefined();
  });

  it("keeps a failed cleanup's facts beside the typed refusal", async () => {
    faults.home = errno("ENOSPC");
    faults.cleanup = errno("EACCES");
    const { error } = await refusal("directory");
    expect(error).toBeInstanceOf(FileSpaceError);
    expect(captureFailureEvidence(error as Error)).toMatchObject({
      causeCode: "ENOSPC",
      cleanup: { code: "EACCES" },
    });
    expect((error as Error).message).toContain("could not be removed");
  });

  it("leaves a Git preparation's own error as it was", async () => {
    faults.home = errno("ENOSPC");
    const { error } = await refusal("git");
    expect(error).not.toBeInstanceOf(FileSpaceError);
    expect(error).toMatchObject({ code: "ENOSPC" });
  });
});
