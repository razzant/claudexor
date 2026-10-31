import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureWorkingTreeTransient, isolatedCloneAdd } from "@claudexor/workspace";
import { checkResultOnTarget } from "./index.js";

// #535 R14 A3: apply/check made its private scratch before the boundary that turns a
// store or filesystem fault into its typed refusal. A disk too full for that first
// directory threw a raw ENOSPC or EDQUOT (the route's generic 400), while the same
// fault one step later answered `space_insufficient`.
let faults: { scratch?: Error; objects?: Error; cleanup?: Error } = {};
const SCRATCH = "claudexor-result-check-";
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    mkdtempSync: (...args: Parameters<typeof fs.mkdtempSync>) => {
      if (faults.scratch && String(args[0]).includes(SCRATCH)) throw faults.scratch;
      return fs.mkdtempSync(...args);
    },
    mkdirSync: (...args: Parameters<typeof fs.mkdirSync>) => {
      const path = String(args[0]);
      if (faults.objects && path.includes(SCRATCH) && path.endsWith("objects"))
        throw faults.objects;
      return fs.mkdirSync(...args);
    },
    rmSync: (...args: Parameters<typeof fs.rmSync>) => {
      if (faults.cleanup && String(args[0]).includes(SCRATCH)) throw faults.cleanup;
      return fs.rmSync(...args);
    },
  };
});
const errno = (code: string) =>
  Object.assign(new Error(`${code}: injected at the check's scratch`), { code });

const dirs: string[] = [];
let configDir: string | undefined;
beforeEach(() => {
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-check-space-config-"));
  dirs.push(process.env["CLAUDEXOR_CONFIG_DIR"]);
});
afterEach(() => {
  faults = {};
  if (configDir === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
  else process.env["CLAUDEXOR_CONFIG_DIR"] = configDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: ENV })
    .toString("utf8")
    .trim();

async function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "cx-check-space-"));
  const run = mkdtempSync(join(tmpdir(), "cx-check-space-run-"));
  dirs.push(repo, run);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "f.txt"), "before\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const clone = join(mkdtempSync(join(tmpdir(), "cx-check-space-clone-")), "tree");
  dirs.push(join(clone, ".."));
  await isolatedCloneAdd(repo, clone, "claudexor/t/a01", git(repo, "rev-parse", "HEAD"));
  writeFileSync(join(clone, "f.txt"), "after!\n");
  const captured = await captureWorkingTreeTransient(clone, "HEAD", [], {
    projectRoot: repo,
    owner: run,
  });
  return { repo, result: captured.result! };
}

describe("apply/check whose own scratch allocation fails", () => {
  for (const code of ["ENOSPC", "EDQUOT"])
    for (const where of ["scratch", "objects"] as const)
      it(`${code} at its ${where === "scratch" ? "first allocation" : "object directory, inside"} answers space_insufficient`, async () => {
        const { repo, result } = await fixture();
        faults = where === "scratch" ? { scratch: errno(code) } : { objects: errno(code) };

        const checked = await checkResultOnTarget(repo, result, repo);

        expect(checked).toMatchObject({
          ok: false,
          refusal: { code: "space_insufficient" },
        });
        expect(checked.stderr).toContain(code);
      });

  it("a scratch that cannot be removed afterwards does not replace that answer", async () => {
    const { repo, result } = await fixture();
    faults = { objects: errno("ENOSPC"), cleanup: errno("EBUSY") };

    const checked = await checkResultOnTarget(repo, result, repo);

    expect(checked.refusal?.code).toBe("space_insufficient");
  });

  it("an unsearchable or unwritable scratch answers the typed Git-fault class, as one inside does", async () => {
    const { repo, result } = await fixture();
    faults = { scratch: errno("EACCES") };

    const checked = await checkResultOnTarget(repo, result, repo);

    expect(checked.refusal?.code).toBe("git_failed");
  });

  it("a fault that is no filesystem or store fault stays bare text, untyped (control)", async () => {
    const { repo, result } = await fixture();
    faults = { objects: new Error("not a filesystem fault") };

    const checked = await checkResultOnTarget(repo, result, repo);

    expect(checked).toEqual({ ok: false, code: 1, stderr: "not a filesystem fault" });
  });

  it("without a fault the check still answers (control)", async () => {
    const { repo, result } = await fixture();

    expect(await checkResultOnTarget(repo, result, repo)).toMatchObject({ ok: true, code: 0 });
  });
});
