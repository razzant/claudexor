/**
 * #333 over the built CLI and a real daemon with offline fakes:
 * `claudexor project remove <id> --purge-trashed-threads` removes a project
 * together with the threads already in its trash, in one action. The default
 * removal, a misspelled or invalid opt-in, a mixed project and running or
 * queued work change nothing; the user's project folder and Git state are never
 * touched (only the thread's own worktree, branch and lane homes go); a cleanup
 * that cannot finish (a directory that refuses deletion, a Git refusal such as
 * a locked worktree, a runtime directory that is a link, never followed) is
 * reported pending and completes when the daemon next starts after the cause
 * is gone, in the repository it recorded even after a move and with another
 * repository at the old project path.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  ControlDaemonStatus,
  ControlProjectRemoveReceipt,
  type ControlThread,
} from "@claudexor/schema";
import { cli, makeSandbox, readEvents, type Sandbox } from "./support.js";
import { controlApi } from "./project-trash-api.js";

let sandbox: Sandbox | undefined;
afterEach(() => {
  try {
    sandbox?.dispose();
  } finally {
    sandbox = undefined;
  }
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", ["-c", "user.email=c@x", "-c", "user.name=c", ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();

function treeBytes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (dir === root && name === ".git") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else
        out[relative(root, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(root);
  return out;
}

/** Everything of the user's project the removal must leave as it was. */
function userState(root: string) {
  return {
    files: treeBytes(root),
    head: git(root, ["rev-parse", "HEAD"]),
    refs: git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    index: git(root, ["ls-files", "-s"]),
    worktrees: git(root, ["worktree", "list", "--porcelain"]),
    status: git(root, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"]),
  };
}

/** A user's Git project with committed and uncommitted data, registered by the CLI. */
function userProject(sb: Sandbox, name: string) {
  const root = join(sb.home, name);
  mkdirSync(root);
  writeFileSync(join(root, "sentinel.txt"), `${name}: user data that must survive\n`);
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "user commit"]);
  writeFileSync(join(root, "untracked-note.txt"), "uncommitted user note\n");
  const registered = cli(sb, ["project", "register", root, "--json"]);
  expect(registered.code, registered.stdout + registered.stderr).toBe(0);
  return { root, id: (registered.json() as { id: string }).id };
}

/** Claudexor-owned directories of one thread under the sandbox runtime tree. */
function ownedDirs(sb: Sandbox, kind: "threads" | "lanes", threadId: string): string[] {
  const projects = join(sb.configDir, "projects");
  if (!existsSync(projects)) return [];
  return readdirSync(projects)
    .map((digest) => join(projects, digest, kind, threadId))
    .filter((path) => existsSync(path));
}

/** Every entry under an owned directory: file digests, link targets, directories. */
function ownedTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const key = relative(root, path);
      if (stat.isSymbolicLink()) out[key] = `link:${readlinkSync(path)}`;
      else if (stat.isDirectory()) {
        out[key] = "dir";
        walk(path);
      } else if (stat.isFile())
        out[key] = createHash("sha256").update(readFileSync(path)).digest("hex");
      else out[key] = "special";
    }
  };
  walk(root);
  return out;
}

function remove(sb: Sandbox, id: string, purgeTrashed: boolean) {
  const result = cli(sb, [
    "project",
    "remove",
    id,
    ...(purgeTrashed ? ["--purge-trashed-threads"] : []),
    "--json",
  ]);
  return { code: result.code, body: result.json() as Record<string, unknown>, result };
}

it("[INV-035:project-remove-trashed-threads] removes a project with only its trashed threads in one action; default, mixed, running and queued removals change nothing", async () => {
  sandbox = makeSandbox();
  const sb = sandbox;
  const started = cli(sb, ["daemon", "start", "--json"], {
    env: { CLAUDEXOR_MAX_CONCURRENT: "1", CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS: "600000" },
  });
  expect(started.code, started.stdout + started.stderr).toBe(0);
  const api = controlApi(sb);
  await api.connect();

  // The default removal is unchanged: a thread-less project, the old receipt shape.
  const empty = userProject(sb, "p-empty");
  const plain = remove(sb, empty.id, false);
  expect(plain.code, plain.result.stdout + plain.result.stderr).toBe(0);
  expect(ControlProjectRemoveReceipt.parse(plain.body)).toMatchObject({
    projectId: empty.id,
    registryRemoved: true,
    artifactsRetained: true,
  });
  expect(plain.body).not.toHaveProperty("purgedThreads");

  // A project whose threads are all in the trash: an isolated thread with an
  // unapplied Agent change in its own worktree and branch, and an in-place
  // thread whose Ask turn owns a durable lane home.
  const app = userProject(sb, "p-app");
  const appBefore = userState(app.root);
  const isolated = await api.thread(app.root, "isolated", "app-isolated");
  const write = await api.turn(isolated, { prompt: "write a change" }, "app-write");
  expect((await api.terminal(write.runId!)).summary.state).toBe("succeeded");
  const [worktree] = ownedDirs(sb, "threads", isolated);
  expect(readFileSync(join(worktree!, "tree", "FAKE_CHANGE.txt"), "utf8")).toContain(
    "fake-session",
  );
  const branch = `refs/heads/claudexor/thread-${isolated}`;
  expect(git(app.root, ["rev-parse", "--verify", branch])).toMatch(/^[0-9a-f]{40}$/);
  const asked = await api.thread(app.root, "in_place", "app-asked");
  const ask = await api.turn(asked, { prompt: "a question", mode: "ask" }, "app-ask");
  expect((await api.terminal(ask.runId!)).summary.state).toBe("succeeded");
  expect(ownedDirs(sb, "lanes", asked)).toHaveLength(1);
  await api.trash(isolated);
  await api.trash(asked);
  const refused = remove(sb, app.id, false);
  expect(refused.code).toBe(1);
  expect(refused.body).toMatchObject({ ok: false, code: "project_has_threads" });
  expect(await api.projectIds()).toContain(app.id);
  expect(await api.threadStates()).toMatchObject({ [isolated]: "trashed", [asked]: "trashed" });

  // Only the exact opt-in purges. A misspelled parameter name is an ignored
  // query parameter, so the request is the default removal and refuses this
  // trashed-only project; an invalid or repeated value of the real parameter
  // is refused before the service runs; a misspelled CLI flag never reaches the
  // daemon. None of them changes the registry, the threads, the open cleanup
  // obligations, an owned worktree or lane home, or the user's project.
  const appState = async () => ({
    projects: await api.projectIds(),
    threads: ((await api.call("GET", "/threads")).body.threads as ControlThread[]).filter((t) =>
      [isolated, asked].includes(t.id),
    ),
    obligations: await api.openObligations(),
    owned: [isolated, asked]
      .flatMap((id) => [...ownedDirs(sb, "threads", id), ...ownedDirs(sb, "lanes", id)])
      .map((dir) => [dir, ownedTree(dir)]),
    user: userState(app.root),
  });
  await vi.waitFor(async () => expect(await api.openObligations()).toBe(0), {
    timeout: 30_000,
    interval: 100,
  });
  const quiet = await appState();
  expect(quiet.threads.map((t) => t.state)).toEqual(["trashed", "trashed"]);
  // At least the isolated worktree and the Ask thread's lane home exist.
  expect(quiet.owned.map(([dir]) => dir)).toEqual(
    expect.arrayContaining([worktree!, ...ownedDirs(sb, "lanes", asked)]),
  );
  for (const query of ["trashedThread=purge", "TrashedThreads=purge", "purge=true"]) {
    const misspelled = await api.call("DELETE", `/projects/${app.id}?${query}`);
    expect(misspelled.status, `${query}: ${misspelled.text}`).toBe(409);
    expect(misspelled.body).toMatchObject({ code: "project_has_threads" });
  }
  for (const query of [
    "trashedThreads=true",
    "trashedThreads=",
    "trashedThreads=purge&trashedThreads=purge",
  ]) {
    const invalid = await api.call("DELETE", `/projects/${app.id}?${query}`);
    expect(invalid.status, `${query}: ${invalid.text}`).toBe(400);
    expect(invalid.body).toMatchObject({ code: "invalid_request" });
  }
  const typo = cli(sb, ["project", "remove", app.id, "--purge-trashed-thread", "--json"]);
  expect(typo.code, typo.stdout + typo.stderr).toBe(2);
  expect(typo.json()).toMatchObject({
    ok: false,
    message: expect.stringContaining("--purge-trashed-thread"),
  });
  expect(await appState()).toEqual(quiet);

  // Mixed: one thread in the trash, one not. The opt-in refuses and changes nothing.
  const mixed = userProject(sb, "p-mixed");
  const mixedBefore = userState(mixed.root);
  const gone = await api.thread(mixed.root, "in_place", "mixed-trashed");
  const goneAsk = await api.turn(gone, { prompt: "q", mode: "ask" }, "mixed-ask");
  expect((await api.terminal(goneAsk.runId!)).summary.state).toBe("succeeded");
  const kept = await api.thread(mixed.root, "in_place", "mixed-kept");
  await api.trash(gone);
  const mixedRefusal = remove(sb, mixed.id, true);
  expect(mixedRefusal.code).toBe(1);
  expect(mixedRefusal.body).toMatchObject({
    ok: false,
    code: "project_has_threads",
    message: expect.stringContaining("outside the trash"),
  });
  expect(await api.threadStates()).toMatchObject({ [gone]: "trashed", [kept]: "active" });
  expect(ownedDirs(sb, "lanes", gone)).toHaveLength(1);
  expect(await api.projectIds()).toContain(mixed.id);

  // Running and queued work of trashed threads (one run slot) refuse the opt-in.
  const busy = userProject(sb, "p-busy");
  const busyThread = await api.thread(busy.root, "in_place", "busy-thread");
  const hang = await api.turn(
    busyThread,
    { prompt: "hold the only run slot", mode: "ask", harnesses: ["fake-hang"] },
    "busy-hang",
  );
  await vi.waitFor(
    () => expect(readEvents(hang.runDir!).some((e) => e.type === "harness.event")).toBe(true),
    { timeout: 30_000, interval: 50 },
  );
  const queued = userProject(sb, "p-queued");
  const queuedThread = await api.thread(queued.root, "in_place", "queued-thread");
  // Accepted, not started: the only run slot is held.
  const waiting = await api.turn(
    queuedThread,
    { prompt: "wait for the slot", mode: "ask" },
    "queued-ask",
    202,
  );
  expect(waiting.state).toBe("queued");
  expect(await api.jobState(waiting.jobId)).toBe("queued");
  await api.trash(busyThread);
  await api.trash(queuedThread);
  for (const project of [busy, queued]) {
    const result = remove(sb, project.id, true);
    expect(result.code, JSON.stringify(result.body)).toBe(1);
    expect(result.body).toMatchObject({ ok: false, code: "project_has_active_run" });
    expect(await api.projectIds()).toContain(project.id);
  }
  expect(await api.jobState(hang.jobId)).toBe("running");
  expect(await api.jobState(waiting.jobId)).toBe("queued");
  expect(await api.threadStates()).toMatchObject({
    [busyThread]: "trashed",
    [queuedThread]: "trashed",
  });
  expect(ownedDirs(sb, "lanes", busyThread)).toHaveLength(1);
  const cancel = await api.call(
    "POST",
    `/runs/${hang.runId}/control`,
    { control: { kind: "cancel" } },
    "cancel-hang",
  );
  expect(cancel.status, cancel.text).toBe(200);
  expect((await api.terminal(hang.runId!)).summary.state).toBe("cancelled");
  await vi.waitFor(
    async () =>
      expect(["succeeded", "failed", "cancelled", "interrupted"]).toContain(
        await api.jobState(waiting.jobId),
      ),
    { timeout: 60_000, interval: 100 },
  );

  // The opt-in: one action purges exactly the trashed threads and retires the
  // project; the user's folder, HEAD, refs, index, worktrees and status are as
  // before (the thread's own branch and worktree are gone), run trees stay.
  const removed = remove(sb, app.id, true);
  expect(removed.code, removed.result.stdout + removed.result.stderr).toBe(0);
  const receipt = ControlProjectRemoveReceipt.parse(removed.body);
  expect(receipt).toMatchObject({ projectId: app.id, root: app.root, registryRemoved: true });
  expect(receipt.purgedThreads?.map((t) => t.threadId).sort()).toEqual([isolated, asked].sort());
  expect(receipt.purgedThreads?.every((t) => t.cleanup === "completed" && !t.cleanupError)).toBe(
    true,
  );
  expect(await api.projectIds()).not.toContain(app.id);
  for (const id of [isolated, asked])
    expect([...ownedDirs(sb, "threads", id), ...ownedDirs(sb, "lanes", id)]).toEqual([]);
  expect(userState(app.root)).toEqual(appBefore);
  expect(existsSync(write.runDir!)).toBe(true);
  expect(existsSync(ask.runDir!)).toBe(true);
  expect((await api.call("GET", `/threads/${isolated}`)).status).toBe(404);
  expect((await api.call("POST", `/threads/${asked}/restore`)).status).toBe(404);
  const listed = await api.threadStates();
  expect(listed).not.toHaveProperty(isolated);
  expect(listed).not.toHaveProperty(asked);

  const human = cli(sb, ["project", "remove", busy.id, "--purge-trashed-threads"]);
  expect(human.code, human.stdout + human.stderr).toBe(0);
  expect(human.stdout).toContain(`Purged 1 trashed thread(s): ${busyThread}.`);
  expect(human.stdout).not.toContain("warning:");
  expect(ownedDirs(sb, "lanes", busyThread)).toEqual([]);
  const queuedRemoved = remove(sb, queued.id, true);
  expect(queuedRemoved.code, JSON.stringify(queuedRemoved.body)).toBe(0);
  expect(
    ControlProjectRemoveReceipt.parse(queuedRemoved.body).purgedThreads?.map((t) => t.threadId),
  ).toEqual([queuedThread]);

  // The mixed project goes once its last thread is explicitly trashed too.
  await api.trash(kept);
  const mixedRemoved = remove(sb, mixed.id, true);
  expect(mixedRemoved.code, JSON.stringify(mixedRemoved.body)).toBe(0);
  expect(
    ControlProjectRemoveReceipt.parse(mixedRemoved.body)
      .purgedThreads?.map((t) => t.threadId)
      .sort(),
  ).toEqual([gone, kept].sort());
  expect(userState(mixed.root)).toEqual(mixedBefore);
  for (const project of [empty, app, mixed, busy, queued])
    expect(readFileSync(join(project.root, "sentinel.txt"), "utf8")).toContain(
      "user data that must survive",
    );
}, 240_000);

// Mode bits cannot refuse an unlink to root or on Windows.
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "[INV-035:project-remove-pending-cleanup] reports a cleanup it could not finish as pending and completes it when the daemon next starts",
  async () => {
    sandbox = makeSandbox();
    const sb = sandbox;
    const started = cli(sb, ["daemon", "start", "--json"]);
    expect(started.code, started.stdout + started.stderr).toBe(0);
    const api = controlApi(sb);
    await api.connect();
    const project = userProject(sb, "p-recover");
    const before = userState(project.root);
    const threadId = await api.thread(project.root, "in_place", "recover-thread");
    const ask = await api.turn(threadId, { prompt: "q", mode: "ask" }, "recover-ask");
    expect((await api.terminal(ask.runId!)).summary.state).toBe("succeeded");
    await api.trash(threadId);
    const [laneDir] = ownedDirs(sb, "lanes", threadId);
    const lanesRoot = dirname(laneDir!);
    // The lane home's parent refuses to lose an entry: the purge commits, but
    // its directory cleanup cannot finish.
    chmodSync(lanesRoot, 0o555);
    let removed: ReturnType<typeof remove>;
    try {
      removed = remove(sb, project.id, true);
    } finally {
      chmodSync(lanesRoot, 0o755);
    }
    expect(removed.code, removed.result.stdout + removed.result.stderr).toBe(0);
    expect(ControlProjectRemoveReceipt.parse(removed.body).purgedThreads).toEqual([
      {
        threadId,
        cleanup: "pending",
        cleanupError: expect.stringMatching(/EACCES|permission denied/i),
      },
    ]);
    expect(await api.projectIds()).not.toContain(project.id);
    expect(existsSync(laneDir!)).toBe(true);
    const pending = ControlDaemonStatus.parse((await api.call("GET", "/daemon/status")).body);
    expect(pending.store?.obligations_open).toBeGreaterThanOrEqual(1);

    // Startup replays the open purge obligation through the same purge owner.
    const stopped = cli(sb, ["daemon", "stop", "--json"]);
    expect(stopped.code, stopped.stdout + stopped.stderr).toBe(0);
    const restarted = cli(sb, ["daemon", "start", "--json"]);
    expect(restarted.code, restarted.stdout + restarted.stderr).toBe(0);
    await api.connect();
    await vi.waitFor(() => expect(existsSync(laneDir!)).toBe(false), {
      timeout: 30_000,
      interval: 100,
    });
    await vi.waitFor(
      async () =>
        expect(
          ControlDaemonStatus.parse((await api.call("GET", "/daemon/status")).body).store
            ?.obligations_open,
        ).toBe(0),
      { timeout: 30_000, interval: 100 },
    );
    expect(await api.projectIds()).not.toContain(project.id);
    expect(await api.threadStates()).not.toHaveProperty(threadId);
    expect(userState(project.root)).toEqual(before);
    expect(existsSync(ask.runDir!)).toBe(true);
  },
  180_000,
);

it("[INV-035:project-remove-cleanup-refusal] keeps cleanup pending while Git refuses or a runtime directory is a link, touching nothing of the user's, and finishes it at the next start once lifted", async () => {
  sandbox = makeSandbox();
  const sb = sandbox;
  const started = cli(sb, ["daemon", "start", "--json"]);
  expect(started.code, started.stdout + started.stderr).toBe(0);
  const api = controlApi(sb);
  await api.connect();

  // An isolated thread whose worktree the user locked with `git worktree lock`.
  const locked = userProject(sb, "p-locked");
  const lockedOriginal = userState(locked.root);
  const isolated = await api.thread(locked.root, "isolated", "locked-isolated");
  const write = await api.turn(isolated, { prompt: "write a change" }, "locked-write");
  expect((await api.terminal(write.runId!)).summary.state).toBe("succeeded");
  const tree = join(ownedDirs(sb, "threads", isolated)[0]!, "tree");
  git(locked.root, ["worktree", "lock", tree]);
  const lockedBefore = userState(locked.root);
  await api.trash(isolated);

  // An Ask thread whose project lanes directory became a link to a user folder
  // holding a directory named like the thread.
  const linked = userProject(sb, "p-linked");
  const asked = await api.thread(linked.root, "in_place", "linked-asked");
  const ask = await api.turn(asked, { prompt: "q", mode: "ask" }, "linked-ask");
  expect((await api.terminal(ask.runId!)).summary.state).toBe("succeeded");
  const lanesRoot = dirname(ownedDirs(sb, "lanes", asked)[0]!);
  const userFolder = join(sb.home, "user-folder");
  mkdirSync(join(userFolder, asked), { recursive: true });
  writeFileSync(join(userFolder, asked, "keep.txt"), "user data that must survive\n");
  renameSync(lanesRoot, `${lanesRoot}.real`);
  symlinkSync(userFolder, lanesRoot, "dir");
  await api.trash(asked);

  // An isolated thread whose repository the user moved without a relink and
  // repaired with `git worktree repair`, while another Git process holds the
  // thread branch's ref lock.
  const moved = userProject(sb, "p-moved");
  const movedOriginal = userState(moved.root);
  const relocated = await api.thread(moved.root, "isolated", "moved-isolated");
  const movedWrite = await api.turn(relocated, { prompt: "write a change" }, "moved-write");
  expect((await api.terminal(movedWrite.runId!)).summary.state).toBe("succeeded");
  await api.trash(relocated);
  const movedTo = join(sb.home, "p-moved-elsewhere");
  renameSync(moved.root, movedTo);
  git(movedTo, ["worktree", "repair"]);
  const refLock = join(movedTo, ".git", "refs", "heads", "claudexor", `thread-${relocated}.lock`);
  writeFileSync(refLock, "held by another Git process\n");

  for (const [project, threadId, error] of [
    [locked, isolated, /git worktree remove failed/],
    [linked, asked, /link; refusing to follow/],
    [moved, relocated, /git branch -D/],
  ] as const) {
    const removed = remove(sb, project.id, true);
    expect(removed.code, removed.result.stdout + removed.result.stderr).toBe(0);
    expect(ControlProjectRemoveReceipt.parse(removed.body).purgedThreads).toEqual([
      { threadId, cleanup: "pending", cleanupError: expect.stringMatching(error) },
    ]);
    expect(await api.projectIds()).not.toContain(project.id);
  }
  // The locked worktree with its change, registration and branch is all there.
  expect(userState(locked.root)).toEqual(lockedBefore);
  expect(existsSync(join(tree, "FAKE_CHANGE.txt"))).toBe(true);
  expect(readFileSync(join(userFolder, asked, "keep.txt"), "utf8")).toContain("must survive");
  expect(git(movedTo, ["branch", "--list", `claudexor/thread-${relocated}`])).not.toBe("");
  expect(await api.openObligations()).toBeGreaterThanOrEqual(3);

  // Lift every cause; the next start replays each cleanup through the purge
  // owner. A new empty repository now at the moved project's old path must not
  // stand in for the moved one, which still holds the thread branch.
  git(locked.root, ["worktree", "unlock", tree]);
  unlinkSync(lanesRoot);
  renameSync(`${lanesRoot}.real`, lanesRoot);
  unlinkSync(refLock);
  mkdirSync(moved.root);
  git(moved.root, ["init", "-q"]);
  const stopped = cli(sb, ["daemon", "stop", "--json"]);
  expect(stopped.code, stopped.stdout + stopped.stderr).toBe(0);
  const restarted = cli(sb, ["daemon", "start", "--json"]);
  expect(restarted.code, restarted.stdout + restarted.stderr).toBe(0);
  await api.connect();
  await vi.waitFor(async () => expect(await api.openObligations()).toBe(0), {
    timeout: 30_000,
    interval: 100,
  });
  expect([
    ...ownedDirs(sb, "threads", isolated),
    ...ownedDirs(sb, "lanes", asked),
    ...ownedDirs(sb, "threads", relocated),
  ]).toEqual([]);
  expect(userState(locked.root)).toEqual(lockedOriginal);
  expect(readFileSync(join(userFolder, asked, "keep.txt"), "utf8")).toContain("must survive");
  // Only the main worktree's path changed with the move.
  const movedAfter = userState(movedTo);
  expect({ ...movedAfter, worktrees: null }).toEqual({ ...movedOriginal, worktrees: null });
  expect(movedAfter.worktrees.match(/^worktree /gm)).toHaveLength(1);
  expect(git(moved.root, ["for-each-ref"])).toBe("");
  for (const root of [locked.root, linked.root, movedTo])
    expect(readFileSync(join(root, "sentinel.txt"), "utf8")).toContain(
      "user data that must survive",
    );
}, 180_000);
