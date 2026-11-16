// #694 r12: a thread preparation's scope owns its first Git step — the project's
// initialization, the base snapshot with the user's clean filters and the branch
// lookup — and a successful checkout is handed over only after its scope
// settled: a member the settlement saw alive, or a known member it could not
// read, keeps the complete tree held; a settlement that only could not prove the
// scope empty (failed census, deadline, a throw, a host without a census) names
// no such member and lets a healthy turn go on. Real Git; the settlement outcome
// is the one injected seam (`settleScope`), as the daemon's reap would return it.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintRunScopeMarker, type ScopeReapOutcome } from "@claudexor/core";
import { projectRuntimeDir } from "@claudexor/util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  PreparationHeld,
  readThreadPreparation,
  threadPreparationRecordPath,
  threadTreeState,
} from "./preparation-hold.js";
import { ensureThreadWorktree } from "./thread-tree.js";

import { gitFilterCommand, shellQuote } from "../../core/src/test-support/process-fixtures.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.GIT_CONFIG_COUNT;
}, 0);
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const saved = new Map<string, string | undefined>();
beforeAll(() => {
  for (const [key, value] of Object.entries(GIT_ENV)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
});
afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: { ...process.env } })
    .toString()
    .trim();

/** A project (a plain folder when `plain`) whose `*.f` clean and smudge filters
 * log, per run, which scope marker their environment carried. */
function world(plain = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-thread-success-")));
  dirs.push(root);
  const repo = join(root, "project");
  mkdirSync(repo);
  writeFileSync(join(repo, ".gitattributes"), "*.f filter=f\n");
  writeFileSync(join(repo, "a.f"), "a\n");
  if (!plain) {
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    writeFileSync(join(repo, "b.f"), "dirty, untracked\n"); // the snapshot cleans it
  }
  const log = join(root, "filter.log");
  const filter = (side: string) => {
    const program = join(root, `${side}.sh`);
    writeFileSync(
      program,
      `#!/bin/sh\necho "${side} $(env | grep -o '^CLAUDEXOR_RUN_SCOPE_[0-9a-f]*' | tr '\\n' ' ')" >> ${shellQuote(log)}\nexec cat\n`,
      { mode: 0o755 },
    );
    return gitFilterCommand(program);
  };
  process.env.GIT_CONFIG_COUNT = "2";
  process.env.GIT_CONFIG_KEY_0 = "filter.f.clean";
  process.env.GIT_CONFIG_VALUE_0 = filter("clean");
  process.env.GIT_CONFIG_KEY_1 = "filter.f.smudge";
  process.env.GIT_CONFIG_VALUE_1 = filter("smudge");
  const runs = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const [side, ...markers] = line.trim().split(/\s+/);
            return { side, markers };
          })
      : [];
  return { repo, runs, tree: (id: string) => join(projectRuntimeDir(repo), "threads", id, "tree") };
}

function outcome(over: Partial<ScopeReapOutcome> = {}): ScopeReapOutcome {
  return {
    coverage: "marker+capture",
    census: "ok",
    censusFailure: null,
    ended: [],
    survivors: [],
    unreadable: [],
    reusedGroups: [],
    settled: true,
    incomplete: false,
    completeness: "not_provable",
    completenessReason: null,
    restricted: false,
    durationMs: 1,
    ...over,
  } as ScopeReapOutcome;
}

/** The runner's scope, with the settlement outcome the test chooses. */
function scope(settled: () => Promise<ScopeReapOutcome | null>) {
  const opened: string[] = [];
  const marker = mintRunScopeMarker();
  return {
    opened,
    marker,
    options: {
      openScope: async () => {
        opened.push(marker);
        return { marker };
      },
      settleScope: settled,
      quiet: async () => ({ status: "quiet" as const }),
    },
  };
}

describe.runIf(process.platform !== "win32")(
  "thread preparation scope and success (#694 r12)",
  () => {
    it("opens the scope before the first Git step: the project's initialization and the base snapshot run its filters inside it", async () => {
      const w = world(true); // a plain folder: initialization's `add` cleans a.f
      const s = scope(async () => outcome());
      const made = await ensureThreadWorktree(w.repo, "th", s.options);
      expect(made.created).toBe(true);
      expect(made.projectGitInitialization).toMatchObject({ initialized: true });
      const runs = w.runs();
      expect(runs.some((run) => run.side === "clean")).toBe(true);
      expect(runs.some((run) => run.side === "smudge")).toBe(true);
      // Every filter run of this preparation carried exactly its scope's marker.
      for (const run of runs) expect(run.markers, run.side).toEqual([s.marker.replace(/=1$/, "")]);
    });

    it("a ready tree gets no new scope", async () => {
      const w = world();
      await ensureThreadWorktree(w.repo, "th", scope(async () => outcome()).options);
      const again = scope(async () => outcome());
      const ready = await ensureThreadWorktree(w.repo, "th", again.options);
      expect(ready.created).toBe(false);
      expect(again.opened).toEqual([]);
    });

    it.each([
      [
        "a survivor",
        outcome({ settled: false, survivors: [{ pid: 4242, startToken: "t" }] as never }),
      ],
      [
        "an unreadable known member",
        outcome({ settled: false, unreadable: [{ pid: 4243, reason: "identity unknown" }] }),
      ],
    ])(
      "%s after the settlement keeps the complete tree held and refuses the turn; a read proving the end hands the same tree over",
      async (_name, unsettled) => {
        const w = world();
        const held = await ensureThreadWorktree(
          w.repo,
          "th",
          scope(async () => unsettled).options,
        ).catch((error: unknown) => error);
        expect(held).toBeInstanceOf(PreparationHeld);
        expect(held).toMatchObject({
          code: "termination_unconfirmed",
          context: { held: [w.tree("th")], termination_unconfirmed: { reason: "scope_unsettled" } },
        });
        expect(readThreadPreparation(w.tree("th"))).toMatchObject({
          complete: true,
          held: { reason: "scope_unsettled" },
        });
        expect(threadTreeState(w.tree("th"))).toBe("held");
        writeFileSync(join(w.tree("th"), "kept"), "x");
        // Still unproven: refused again, nothing changes.
        const bytes = readFileSync(threadPreparationRecordPath(w.tree("th")), "utf8");
        await expect(
          ensureThreadWorktree(w.repo, "th", {
            quiet: async () => ({ status: "held" as const, reasons: ["member 4242 is alive"] }),
          }),
        ).rejects.toBeInstanceOf(PreparationHeld);
        expect(readFileSync(threadPreparationRecordPath(w.tree("th")), "utf8")).toBe(bytes);
        // Proven: only the record goes; the same checkout, registration and branch stay.
        const next = await ensureThreadWorktree(w.repo, "th", {
          quiet: async () => ({ status: "quiet" as const }),
        });
        expect(next).toMatchObject({ path: w.tree("th"), created: true });
        expect(existsSync(join(w.tree("th"), "kept"))).toBe(true);
        expect(git(w.repo, "branch", "--list", "claudexor/thread-th")).toContain(
          "claudexor/thread-th",
        );
        expect(git(w.repo, "worktree", "list", "--porcelain")).toContain(w.tree("th"));
      },
    );

    it.each([
      [
        "a failed census",
        async () => outcome({ settled: false, census: "failed", censusFailure: "ps failed" }),
      ],
      ["a deadline-bound settlement", async () => outcome({ settled: false, incomplete: true })],
      [
        "a settlement that threw",
        async (): Promise<ScopeReapOutcome> => {
          throw new Error("index unreadable");
        },
      ],
      [
        "a host without a census (Windows)",
        async () => outcome({ settled: false, census: "unsupported", coverage: "tree_only" }),
      ],
    ])("%s names no living member: the healthy turn gets its tree", async (_name, settle) => {
      const w = world();
      const made = await ensureThreadWorktree(w.repo, "th", scope(settle).options);
      expect(made).toMatchObject({ path: w.tree("th"), created: true });
      expect(threadTreeState(w.tree("th"))).toBe("ready");
    });
  },
);
