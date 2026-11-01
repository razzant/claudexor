import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureWorkingTreeTransient } from "@claudexor/workspace";
import { checkResultOnTarget, verifyAndDeliver } from "./index.js";

// #535 round 9: a result's Git objects can only enter a repository of their own
// object format. Checking or applying it on a repository of the other format is
// the typed `result_objects_missing`, naming both formats, with nothing written.
const dirs: string[] = [];
let configDir: string | undefined;
beforeEach(() => {
  configDir = process.env["CLAUDEXOR_CONFIG_DIR"];
  process.env["CLAUDEXOR_CONFIG_DIR"] = temp("cx-delivery-format-config-");
});
afterEach(() => {
  if (configDir === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
  else process.env["CLAUDEXOR_CONFIG_DIR"] = configDir;
});
afterAll(() => {
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
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
/** Auto-maintenance a command starts here finishes before it returns: since Git 2.55 a
 * detached one keeps `objects/maintenance.lock` after `git commit`, which the object
 * inventory would read as a write. */
const git = (repo: string, args: string[]) =>
  execFileSync("git", ["-C", repo, "-c", "maintenance.autoDetach=false", ...args], { env: ENV })
    .toString("utf8")
    .trim();
function repo(format: "sha1" | "sha256"): string {
  const dir = temp(`cx-delivery-format-${format}-`);
  git(dir, ["init", "-q", "-b", "main", `--object-format=${format}`]);
  writeFileSync(join(dir, "file.txt"), "before\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  return dir;
}
/** Every file under a repository's object directory. */
const objectFiles = (dir: string) => {
  const objects = join(dir, ".git", "objects");
  return readdirSync(objects, { recursive: true })
    .map((entry) => relative(objects, join(objects, String(entry))))
    .sort();
};

describe("a result on a repository of the other object format", () => {
  it.each(["check", "apply"] as const)(
    "%s is refused typed, naming both formats, with nothing written",
    async (how) => {
      // The project keeps sha256 objects: its first result came from a sha256 workspace.
      const project = temp("cx-delivery-format-project-");
      const execution = repo("sha256");
      writeFileSync(join(execution, "file.txt"), "after\n");
      const run = temp("cx-delivery-format-run-");
      const captured = await captureWorkingTreeTransient(execution, "HEAD", [], {
        projectRoot: project,
        owner: run,
      });
      expect(captured.captureIncomplete).toBe(false);
      const result = captured.result!;
      const target = repo("sha1");
      const before = objectFiles(target);

      const outcome =
        how === "check"
          ? await checkResultOnTarget(target, result, project)
          : await verifyAndDeliver(
              target,
              { result, renderedPatch: captured.patch },
              { mode: "apply", projectRoot: project, owner: run },
            );

      expect(outcome).toMatchObject({ refusal: { code: "result_objects_missing" } });
      expect(outcome.refusal?.message).toContain("sha256");
      expect(outcome.refusal?.message).toContain("sha1");
      expect(outcome.refusal?.message).toContain("nothing was written");
      expect(objectFiles(target)).toEqual(before);
      expect(readFileSync(join(target, "file.txt"), "utf8")).toBe("before\n");
      expect(git(target, ["status", "--porcelain"])).toBe("");
    },
  );
});
