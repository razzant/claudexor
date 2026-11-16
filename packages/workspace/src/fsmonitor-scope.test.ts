// #694 r12: a Git step that joins a preparation scope never starts the user's
// fsmonitor (an auto-started `git fsmonitor--daemon` would carry the scope's
// marker and be ended with it at settlement). Real Git, with `core.fsmonitor`
// set in the USER's repository to a hook that logs each call: an unscoped step
// calls it (the control), a scoped one does not; the user's config is unchanged.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintRunScopeMarker } from "@claudexor/core";
import { afterEach, describe, expect, it } from "vitest";
import { statusPorcelain } from "./git.js";
import { scopedGitArgs, STAT_TRUST_OFF, withScopeMarker } from "./git-run.js";

import { shellQuote } from "../../core/src/test-support/process-fixtures.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0);

function repoWithFsmonitorHook() {
  // The owned path carries a space, an apostrophe and a percent: the hook is
  // handed to Git as a shell command, so it must be shell-quoted (no Git
  // percent expansion applies to core.fsmonitor).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx fs'mon 100%-")));
  dirs.push(root);
  const repo = join(root, "repo");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env }).toString();
  execFileSync("git", ["init", "-q", repo], { env });
  writeFileSync(join(repo, "a"), "a\n");
  git("add", "a");
  git("-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "a");
  const log = join(root, "hook.log");
  const hook = join(root, "fsmonitor-hook.sh");
  // A v2 hook that answers "everything may have changed" after logging the call.
  writeFileSync(hook, `#!/bin/sh\necho called >> ${shellQuote(log)}\nprintf '/\\0'\n`, {
    mode: 0o755,
  });
  git("config", "core.fsmonitor", shellQuote(hook));
  git("config", "core.fsmonitorHookVersion", "2");
  writeFileSync(join(repo, "b"), "b\n");
  return {
    repo,
    git,
    calls: () =>
      existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0,
  };
}

describe.runIf(process.platform !== "win32")(
  "a scoped Git step never starts the user's fsmonitor (#694 r12)",
  () => {
    it("an unscoped status calls the user's fsmonitor; a scoped one does not, and the config is unchanged", async () => {
      const w = repoWithFsmonitorHook();
      expect(await statusPorcelain(w.repo)).toContain("?? b");
      const control = w.calls();
      expect(control).toBeGreaterThan(0);
      const scoped = withScopeMarker(undefined, mintRunScopeMarker());
      expect(await statusPorcelain(w.repo, scoped)).toContain("?? b");
      expect(w.calls()).toBe(control);
      expect(w.git("config", "core.fsmonitor").trim()).toContain("fsmonitor-hook.sh");
    });

    it("only a scoped step's arguments carry the override", () => {
      const scoped = withScopeMarker(undefined, mintRunScopeMarker());
      expect(scopedGitArgs(scoped, ["status"])).toEqual([...STAT_TRUST_OFF, "status"]);
      expect(scopedGitArgs(undefined, ["status"])).toEqual(["status"]);
      expect(scopedGitArgs(new AbortController().signal, ["status"])).toEqual(["status"]);
    });
  },
);
