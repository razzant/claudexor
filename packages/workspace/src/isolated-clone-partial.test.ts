import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedCloneAdd } from "./git.js";
import { WorkspaceManager } from "./manager.js";

// #501, owner decision: an isolated run whose base commit has content the
// repository never fetched (a partial clone, a sparse checkout of one) is refused
// before it starts, naming what is missing and the two ways forward; nothing is
// fetched, and a complete partial clone or a sparse checkout of a complete clone
// keeps working. Git's own checkout of such a commit reports each file and succeeds.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  process.env["CLAUDEXOR_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "cx-clone-partial-config-"));
  dirs.push(process.env["CLAUDEXOR_CONFIG_DIR"]);
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
const git = (repo: string, args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: ENV })
    .toString("utf8")
    .trim();
const peek = (repo: string, args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: { ...ENV, GIT_OPTIONAL_LOCKS: "0" } })
    .toString("utf8")
    .trim();
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
const refusal = (pending: Promise<unknown>) =>
  pending.then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
/** Objects HEAD, the branches and the tags reach down to the shallow boundary that the
 * repository does not hold, counted without fetching. */
const missingInHistory = (repo: string) =>
  execFileSync(
    "git",
    ["-C", repo, "rev-list", "--objects", "--missing=print", "HEAD", "--branches", "--tags"],
    { env: { ...ENV, GIT_NO_LAZY_FETCH: "1" } },
  )
    .toString("utf8")
    .split("\n")
    .filter((line) => line.startsWith("?")).length;
/** Objects of a commit's tree its repository does not hold, counted without fetching. */
const missingAt = (repo: string, rev: string) =>
  execFileSync("git", ["-C", repo, "rev-list", "--objects", "--no-walk", "--missing=print", rev], {
    env: { ...ENV, GIT_NO_LAZY_FETCH: "1" },
  })
    .toString("utf8")
    .split("\n")
    .filter((line) => line.startsWith("?")).length;

function filesUnder(dir: string, root = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(join(dir, entry.name), root)
      : [relative(root, join(dir, entry.name))],
  );
}

/** The source as Git and the user see it, its object files included. */
function sourceState(repo: string) {
  const objects = join(repo, ".git", "objects");
  return {
    head: peek(repo, ["rev-parse", "HEAD"]),
    refs: peek(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    // Entries and their flags (a sparse checkout's skip-worktree marks); `git status`
    // may refresh the stat cache of a just-written index, which changes no entry.
    index: [peek(repo, ["ls-files", "--stage"]), peek(repo, ["ls-files", "-v"])],
    status: peek(repo, ["status", "--porcelain=v1"]),
    objects: filesUnder(objects).sort(),
    worktree: filesUnder(repo)
      .filter((file) => !file.startsWith(".git/"))
      .sort(),
  };
}

type Shape =
  | "sparse-partial"
  | "partial"
  | "sparse-complete"
  | "shallow-partial"
  | "shallow-sparse-partial"
  | "shallow-history-partial";

/** An upstream of three commits (kept/value.txt changes, outside/b.txt does not) and a
 * target cloned from it; the upstream then moves away, so nothing can be fetched. */
function world(shape: Shape) {
  const base = mkdtempSync(join(tmpdir(), "cx-clone-partial-"));
  dirs.push(base);
  // The upstream stays on a plain path: Git drops `--filter` from a `file://` URL
  // with a non-ASCII character in it and makes a complete clone.
  const root = join(base, "dir with space ü");
  mkdirSync(root);
  const work = join(base, "work");
  mkdirSync(join(work, "kept"), { recursive: true });
  mkdirSync(join(work, "outside"));
  git(work, ["init", "-q", "-b", "main"]);
  writeFileSync(join(work, "kept", "value.txt"), "old\n");
  writeFileSync(join(work, "outside", "b.txt"), "outside\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-qm", "old"]);
  const older = git(work, ["rev-parse", "HEAD"]);
  for (const value of ["mid", "new"]) {
    writeFileSync(join(work, "kept", "value.txt"), `${value}\n`);
    git(work, ["commit", "-qam", value]);
  }
  const upstream = join(base, "upstream.git");
  git(base, ["clone", "-q", "--bare", work, upstream]);
  git(upstream, ["config", "uploadpack.allowFilter", "true"]);
  git(upstream, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  const target = join(root, "target");
  const filter = shape === "sparse-complete" ? [] : ["--filter=blob:none"];
  const shallow = shape.startsWith("shallow");
  const depth = shape === "shallow-history-partial" ? ["2"] : shallow ? ["1"] : [];
  const deep = depth.length > 0 ? ["--depth", ...depth] : [];
  git(root, ["clone", "-q", "--no-checkout", ...filter, ...deep, `file://${upstream}`, target]);
  if (shape.includes("sparse")) git(target, ["sparse-checkout", "set", "--cone", "kept"]);
  git(target, ["checkout", "-q", "main"]);
  // The fixture has the shape it is named after.
  expect(missingAt(target, "HEAD")).toBe(shape.includes("sparse-partial") ? 1 : 0);
  if (shallow) {
    expect(git(target, ["rev-parse", "--is-shallow-repository"])).toBe("true");
    expect(missingInHistory(target)).toBe(shape === "shallow-partial" ? 0 : 1);
  } else {
    const olderMissing: Record<string, number> = { "sparse-partial": 2, partial: 1 };
    expect(missingAt(target, older)).toBe(olderMissing[shape] ?? 0);
  }
  renameSync(upstream, `${upstream}.gone`);
  return { root, target, older };
}

/** Where `create` below puts its envelope (base dir holding home, owner record and tree). */
const envelopeBase = (w: ReturnType<typeof world>) =>
  join(w.root, "runtime", "workspaces", "t1", "a01");

async function create(w: ReturnType<typeof world>, baseRef?: string) {
  const manager = new WorkspaceManager(w.target, { runtimeRoot: join(w.root, "runtime") });
  const runDir = mkdtempSync(join(w.root, "run-"));
  const envelope = await manager.create({
    taskId: "t1",
    attemptId: "a01",
    dirtyPolicy: "snapshot",
    custody: { runId: "run-1", runDir },
    ...(baseRef ? { baseRef } : {}),
  });
  return { manager, envelope, runDir };
}

// Real Git end to end: generous on a loaded machine, still a hang detector.
describe(
  "an isolated run over content the repository never fetched (#501)",
  { timeout: 120_000 },
  () => {
    it("a sparse partial clone at HEAD refuses before the run, naming the missing file", async () => {
      const w = world("sparse-partial");
      const before = sourceState(w.target);
      const refused = await create(w).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(refused).toContain("is incomplete");
      expect(refused).toContain("holds the content of 1 file(s): outside/b.txt");
      expect(refused).toContain("Claudexor fetches nothing itself");
      expect(refused).toContain("`git sparse-checkout disable`");
      expect(refused).toContain("`--in-place`");
      // Refused after its checkout: Git copied the source locally, nothing failed there.
      expect(refused).not.toContain("Git reported:");
      // The never-started envelope its creator made (home, owner record, the partial
      // checkout) is gone before any caller could have disposed of it.
      expect(existsSync(envelopeBase(w))).toBe(false);
      expect(sourceState(w.target)).toEqual(before);
    });

    it("a refusal never removes an envelope directory that was already there", async () => {
      const w = world("sparse-partial");
      mkdirSync(envelopeBase(w), { recursive: true });
      writeFileSync(join(envelopeBase(w), "earlier.txt"), "kept\n");
      const refused = await refusal(create(w));
      expect(refused).toContain("is incomplete");
      expect(read(join(envelopeBase(w), "earlier.txt"))).toBe("kept\n");
    });

    it("a shallow sparse partial clone refuses at its copy, naming the file beside Git's own error", async () => {
      const w = world("shallow-sparse-partial");
      const head = git(w.target, ["rev-parse", "HEAD"]);
      const before = sourceState(w.target);
      const refused = await refusal(create(w));
      // Git's transport copy of a shallow source fails first; the post-checkout check never runs.
      expect(refused).toMatch(new RegExp(`^isolated clone of ${head} failed; Git reported: \\S`));
      expect(refused).toContain("Also observed, not proven as the cause: ");
      expect(refused).toContain("does not hold the content of 1 file(s): outside/b.txt");
      expect(refused).not.toContain("is incomplete");
      expect(refused).toContain("Claudexor fetches nothing itself");
      expect(refused).toContain("`--in-place`");
      expect(existsSync(envelopeBase(w))).toBe(false);
      expect(sourceState(w.target)).toEqual(before);
    });

    it("a shallow partial clone whose history it never fetched refuses with what is missing", async () => {
      const w = world("shallow-history-partial");
      const head = git(w.target, ["rev-parse", "HEAD"]);
      const before = sourceState(w.target);
      const refused = await refusal(create(w));
      // HEAD's files are all there: what is missing is history Git's copy must read.
      expect(refused).toMatch(new RegExp(`^isolated clone of ${head} failed; Git reported: \\S`));
      expect(refused).toContain("does not hold 1 object(s) its branches and tags reach");
      expect(refused).not.toContain("file(s)");
      expect(refused).toContain("Claudexor fetches nothing itself");
      expect(existsSync(envelopeBase(w))).toBe(false);
      expect(sourceState(w.target)).toEqual(before);
    });

    it("an incomplete shallow source whose copy fails for another reason keeps Git's cause first", async () => {
      const w = world("shallow-sparse-partial");
      const head = git(w.target, ["rev-parse", "HEAD"]);
      const before = sourceState(w.target);
      const occupied = join(w.root, "occupied");
      mkdirSync(occupied);
      writeFileSync(join(occupied, "already here"), "\n");
      const failed = await refusal(isolatedCloneAdd(w.target, occupied, "claudexor/t/a01", head));
      // Git's own cause stays whole and first; what the source lacks is an added
      // observation, never presented as the cause of this failure.
      expect(failed).toMatch(new RegExp(`^isolated clone of ${head} failed; Git reported: `));
      expect(failed).toContain("already exists");
      expect(failed).toContain("Also observed, not proven as the cause: ");
      expect(failed).toContain("does not hold the content of 1 file(s): outside/b.txt");
      expect(read(join(occupied, "already here"))).toBe("\n");
      expect(sourceState(w.target)).toEqual(before);
    });

    it("an older base a partial clone never checked out refuses the same way", async () => {
      const w = world("partial");
      const before = sourceState(w.target);
      const refused = await create(w, w.older).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(refused).toContain(`isolated clone of ${w.older} is incomplete`);
      expect(refused).toContain("holds the content of 1 file(s): kept/value.txt");
      expect(sourceState(w.target)).toEqual(before);
    });

    for (const shape of ["partial", "sparse-complete", "shallow-partial"] as const)
      it(`a ${shape} clone whose HEAD content is all present runs and captures as before`, async () => {
        const w = world(shape);
        const { manager, envelope, runDir } = await create(w);
        expect(read(join(envelope.worktree_path, "kept", "value.txt"))).toBe("new\n");
        expect(read(join(envelope.worktree_path, "outside", "b.txt"))).toBe("outside\n");
        expect(peek(envelope.worktree_path, ["status", "--porcelain=v1"])).toBe("");
        writeFileSync(join(envelope.worktree_path, "kept", "value.txt"), "candidate\n");
        const captured = await manager.captureDiff(envelope, runDir);
        expect(captured.captureIncomplete).toBe(false);
        expect(captured.diff).toContain("+candidate");
        expect(captured.diff).not.toContain("outside/b.txt");
      });
  },
);
