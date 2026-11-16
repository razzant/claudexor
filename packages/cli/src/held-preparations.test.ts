// #694 r17: the daemon's held preparation maintenance over real runtime
// directories — discovery reaches a thread the thread list no longer names (a
// purged one), envelope bases and staging directories; a selector is resolved
// only within the roots the daemon knows; a thread's release runs in the
// serializer it is handed and refuses while any of its turns (read-only and
// before-run ones included) is queued or running; a stale digest changes nothing.
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { preparationQuiet } from "@claudexor/core";
import { projectRuntimeDir } from "@claudexor/util";
import { ControlHeldPreparations, ControlPreparationReleaseReceipt } from "@claudexor/schema";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  ensureObjectStore,
  holdEnvelopePreparation,
  holdPreparationChild,
  holdThreadPreparation,
  objectStorePath,
  readThreadPreparation,
  recordDigest,
  releaseThreadPreparation,
  threadGeneration,
  threadPreparationRecordPath,
  writeStagingOwner,
  writeThreadPreparation,
  type PreparationQuietRead,
  type ThreadPreparationRecord,
} from "@claudexor/workspace";
import { mintRunScopeMarker } from "@claudexor/core";
import { heldPreparationServices, type ThreadSerializer } from "./held-preparations.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0);
const win32Quiet: PreparationQuietRead = (facts) =>
  preparationQuiet(facts, { platform: "win32", probePidAlive: () => false });
const GIT = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

async function world(
  jobs: Array<{ state: string; params?: unknown }> = [],
  quiet: PreparationQuietRead = win32Quiet,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-held-prep-")));
  dirs.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q"], { cwd: project, env: GIT });
  const runtime = projectRuntimeDir(project);
  // A purged thread: no thread record anywhere, only its leftover directory.
  const tree = join(runtime, "threads", "purged-1", "tree");
  mkdirSync(tree, { recursive: true });
  writeThreadPreparation({
    schema: 1,
    thread_id: "purged-1",
    tree,
    scope: null,
    opened_at: new Date(Date.now() - 60_000).toISOString(),
    early: true,
    own_registration: null,
    own_branch: null,
    held: { reason: "output_held", groups: [], at: new Date().toISOString() },
  });
  // An envelope base of a stopped run, and one finished long ago (not held).
  const base = join(runtime, "workspaces", "task-1", "a1");
  mkdirSync(join(base, "tree"), { recursive: true });
  writeFileSync(
    join(base, "owner.json"),
    `${JSON.stringify({ pid: 2 ** 22 + 11, envelope_id: "e1", created_at: new Date().toISOString(), preparation: { scope_marker: null, preparing: true } })}\n`,
  );
  const finished = join(runtime, "workspaces", "task-1", "a2");
  mkdirSync(finished, { recursive: true });
  writeFileSync(
    join(finished, "owner.json"),
    `${JSON.stringify({ pid: 1, preparation: { scope_marker: null, preparing: false } })}\n`,
  );
  await ensureObjectStore(project, "sha1");
  const staging = join(
    objectStorePath(project),
    "objects",
    "tmp_claudexor-00000000-0000-4000-8000-000000000001",
  );
  mkdirSync(staging, { recursive: true });
  writeStagingOwner(staging, {
    schema: 1,
    intent: "index-pack",
    creator: { pid: 2 ** 22 + 13 },
    scope: { marker: mintRunScopeMarker() },
    writer: null,
  });
  const service = heldPreparationServices({
    roots: () => ({ projects: () => [project], execution: () => [] }),
    jobs: () => jobs,
    quiet,
    readWriter: null,
  });
  const calls: string[] = [];
  const serialize: ThreadSerializer = (threadId, work) => {
    calls.push(threadId);
    return work();
  };
  return { project, tree, base, finished, staging, service, calls, serialize };
}

function savedCleanup(
  tree: string,
  basis: "platform_limit" | "handover",
  fields: Partial<ThreadPreparationRecord> = {},
): ThreadPreparationRecord {
  const { held: _stop, early: _early, ...original } = readThreadPreparation(tree)!;
  const record = { ...original, own_registration: false, ...fields };
  record.cleanup_basis = { generation: threadGeneration(record), basis };
  writeThreadPreparation(record);
  return record;
}

describe("held preparation maintenance (#694 r17)", () => {
  it.each(
    (["platform_limit", "handover"] as const).flatMap((basis) =>
      (["early", "complete", "partial", "absent"] as const).map((phase) => ({ basis, phase })),
    ),
  )(
    "$basis cleanup of $phase releases through maintenance on its saved basis without new consent",
    async ({ basis, phase }) => {
      const quiet = vi.fn(win32Quiet);
      const w = await world([], quiet);
      savedCleanup(w.tree, basis, {
        ...(phase === "early" ? { early: true } : {}),
        ...(phase === "complete" ? { complete: true } : {}),
      });
      if (phase === "absent") rmSync(w.tree, { recursive: true });
      else writeFileSync(join(w.tree, "keep"), "existing bytes\n");
      const path = threadPreparationRecordPath(w.tree);
      const bytes = readFileSync(path, "utf8");
      const held = ControlHeldPreparations.parse(await w.service.heldPreparations());
      const item = held.preparations.find((entry) => entry.kind === "thread")!;
      expect(item).toMatchObject({
        read: { status: "quiet", unproven: expect.stringContaining("no process groups") },
        release: "saved_cleanup",
        operator_release: null,
        refusal: null,
        on_release: expect.stringContaining("not a machine proof"),
      });
      expect(item.on_release).toContain(`saved ${basis} cleanup basis`);
      expect(readFileSync(path, "utf8")).toBe(bytes); // Inspection is read-only.
      quiet.mockClear();
      const request = {
        selector: item.selector,
        digest: item.digest,
        confirm_processes_ended: true as const,
      };
      expect(
        await w.service.releasePreparation({ ...request, digest: "0".repeat(64) }, w.serialize),
      ).toMatchObject({ outcome: "stale", basis: null, confirmed_at: null });
      expect(quiet).not.toHaveBeenCalled();
      expect(readFileSync(path, "utf8")).toBe(bytes);
      // The owner's fresh read sees the record before cleanup: no transient
      // confirmation was written only to disappear with the record.
      quiet.mockImplementation((facts) => {
        expect(readThreadPreparation(w.tree)).not.toHaveProperty("operator_release");
        return win32Quiet(facts);
      });
      const result = await w.service.releasePreparation(request, w.serialize);
      const receipt = ControlPreparationReleaseReceipt.parse(
        JSON.parse(JSON.stringify({ ...result, operation_id: "delivery-test", replayed: false })),
      );
      expect(receipt).toMatchObject({
        outcome: phase === "complete" ? "completed" : "released",
        basis: "saved_cleanup",
        confirmed_at: null,
        continued: false,
        stop: null,
        reasons: [],
      });
      expect(quiet).toHaveBeenCalled();
      expect(existsSync(path)).toBe(false);
      if (phase === "early" || phase === "complete")
        expect(readFileSync(join(w.tree, "keep"), "utf8")).toBe("existing bytes\n");
      else expect(existsSync(w.tree)).toBe(false);
      expect(existsSync(w.base)).toBe(true);
      expect(existsSync(w.staging)).toBe(true);
    },
  );

  it.each([
    "new generation",
    "new hold",
    "unknown basis",
    "unknown read",
    "measured member",
    "current child",
    "active turn",
  ])("a saved cleanup basis never overrides %s in inspection or release", async (change) => {
    const jobs: Array<{ state: string; params?: unknown }> = [];
    const quiet: PreparationQuietRead =
      change === "unknown read" || change === "measured member"
        ? async () => ({ status: "held", reasons: [change] })
        : win32Quiet;
    const w = await world(jobs, quiet);
    const record = savedCleanup(w.tree, "handover", { early: true });
    if (change === "new generation")
      writeThreadPreparation({
        ...record,
        opened_at: new Date(Date.parse(record.opened_at) + 1_000).toISOString(),
      });
    if (change === "new hold")
      holdThreadPreparation(w.tree, { reason: "scope_unsettled", groups: [] });
    if (change === "unknown basis")
      writeFileSync(
        threadPreparationRecordPath(w.tree),
        JSON.stringify({
          ...record,
          cleanup_basis: { ...record.cleanup_basis, basis: "unknown" },
        }),
      );
    if (change === "active turn")
      jobs.push({ state: "queued", params: { threadId: "purged-1", mode: "ask" } });
    let exited!: () => void;
    const exit = new Promise<void>((resolve) => {
      exited = resolve;
    });
    if (change === "current child") holdPreparationChild(w.tree, exit);
    try {
      const bytes = readFileSync(threadPreparationRecordPath(w.tree), "utf8");
      const item = (await w.service.heldPreparations()).preparations.find(
        (entry) => entry.kind === "thread",
      )!;
      const confirmable = ["new generation", "new hold", "unknown basis"].includes(change);
      expect(item.release).toBe(confirmable ? "operator_confirmation" : "refused");
      if (confirmable || change === "unknown read" || change === "measured member")
        expect(item.on_release).not.toContain("saved handover cleanup basis");
      if (change === "current child") expect(item.refusal).toContain("current child");
      if (change === "active turn") expect(item.refusal).toContain("queued or running");
      // Active turns are a serializer gate, not a workspace-layer process fact.
      if (change !== "active turn")
        await expect(releaseThreadPreparation(w.project, w.tree, quiet)).rejects.toMatchObject({
          code: "termination_unconfirmed",
        });
      expect(readFileSync(threadPreparationRecordPath(w.tree), "utf8")).toBe(bytes);
      const result = await w.service.releasePreparation(
        { selector: item.selector, digest: item.digest, confirm_processes_ended: true },
        w.serialize,
      );
      if (confirmable) {
        // Legacy operator recovery still works on a genuinely unproven generation.
        expect(result).toMatchObject({
          outcome: "released",
          basis: "operator_confirmed",
          confirmed_at: expect.any(String),
        });
      } else {
        expect(result).toMatchObject({ outcome: "refused", basis: null, confirmed_at: null });
        expect(readFileSync(threadPreparationRecordPath(w.tree), "utf8")).toBe(bytes);
      }
    } finally {
      exited();
      await exit;
    }
  });

  it("a proven end still releases a saved cleanup without operator consent", async () => {
    const quiet = vi.fn<PreparationQuietRead>(async () => ({ status: "quiet" }));
    const w = await world([], quiet);
    savedCleanup(w.tree, "handover", { complete: true });
    const item = (await w.service.heldPreparations()).preparations.find(
      (entry) => entry.kind === "thread",
    )!;
    expect(item.release).toBe("machine");
    quiet.mockClear();
    expect(
      await w.service.releasePreparation(
        { selector: item.selector, digest: item.digest, confirm_processes_ended: true },
        w.serialize,
      ),
    ).toMatchObject({ outcome: "completed", basis: "machine_proven", confirmed_at: null });
    expect(quiet).toHaveBeenCalledTimes(2); // Confirmation boundary, then the resource's release.
    expect(existsSync(w.tree)).toBe(true);
  });

  it("a new hold in the owner's release read keeps the saved cleanup untouched", async () => {
    const quiet = vi.fn(win32Quiet);
    const w = await world([], quiet);
    savedCleanup(w.tree, "handover", { complete: true });
    const item = (await w.service.heldPreparations()).preparations.find(
      (entry) => entry.kind === "thread",
    )!;
    expect(item.release).toBe("saved_cleanup");
    const bytes = readFileSync(threadPreparationRecordPath(w.tree), "utf8");
    quiet.mockImplementationOnce(win32Quiet).mockResolvedValue({
      status: "held",
      reasons: ["scope identity unreadable"],
    });
    expect(
      await w.service.releasePreparation(
        { selector: item.selector, digest: item.digest, confirm_processes_ended: true },
        w.serialize,
      ),
    ).toMatchObject({ outcome: "refused", basis: null, confirmed_at: null });
    expect(readFileSync(threadPreparationRecordPath(w.tree), "utf8")).toBe(bytes);
    expect(existsSync(w.tree)).toBe(true);
  });

  it.each([false, true])(
    "retains prior consent alongside saved cleanup (proven read: %s)",
    async (proven) => {
      const quiet = vi.fn<PreparationQuietRead>(
        proven ? async () => ({ status: "quiet" }) : win32Quiet,
      );
      const w = await world([], quiet);
      const record = savedCleanup(w.tree, "handover", { complete: true });
      const prior = {
        confirmed_at: "2026-11-15T10:00:00.000Z",
        generation: threadGeneration(record),
        observation: { reasons: [], unproven: "no census" },
      };
      writeThreadPreparation({ ...record, operator_release: prior });
      const item = (await w.service.heldPreparations()).preparations.find(
        (entry) => entry.kind === "thread",
      )!;
      expect(item).toMatchObject({
        release: proven ? "machine" : "operator_confirmation",
        operator_release: { confirmed_at: prior.confirmed_at },
      });
      quiet.mockImplementation((facts) => {
        expect(readThreadPreparation(w.tree)?.operator_release).toEqual(prior);
        return proven ? Promise.resolve({ status: "quiet" }) : win32Quiet(facts);
      });
      expect(
        await w.service.releasePreparation(
          { selector: item.selector, digest: "0".repeat(64), confirm_processes_ended: true },
          w.serialize,
        ),
      ).toMatchObject({
        outcome: "completed",
        basis: proven ? "machine_proven" : "operator_confirmed",
        confirmed_at: prior.confirmed_at,
        continued: true,
      });
      expect(existsSync(threadPreparationRecordPath(w.tree))).toBe(false);
      expect(existsSync(w.tree)).toBe(true);
    },
  );

  it("discloses missing root coverage and refuses resolution with the read error, never root_unknown", async () => {
    const w = await world();
    const items = (await w.service.heldPreparations()).preparations;
    for (const failed of ["projects", "execution"] as const) {
      const service = heldPreparationServices({
        roots: () => ({
          projects: () => {
            if (failed === "projects") throw new Error("project SQL unavailable");
            return [w.project];
          },
          execution: () => {
            if (failed === "execution") throw new Error("execution SQL unavailable");
            return [w.project];
          },
        }),
        jobs: () => [],
        quiet: win32Quiet,
        readWriter: null,
      });
      const result = await service.heldPreparations();
      expect(result.errors).toEqual([
        expect.stringMatching(/roots could not be read: .* SQL unavailable/),
      ]);
      expect(result.preparations.some((item) => item.path === w.base)).toBe(true);
      const item = items.find((item) => item.kind === "thread")!;
      const selector =
        failed === "projects"
          ? item.selector
          : `prep1.${Buffer.from(JSON.stringify({ k: "envelope", root: w.tree, task: "t", attempt: "a" })).toString("base64url")}`;
      await expect(
        service.releasePreparation(
          { selector, digest: item.digest, confirm_processes_ended: true },
          w.serialize,
        ),
      ).rejects.toMatchObject({ status: 503, code: "preparation_roots_unreadable" });
    }
    // A failed directory read needed to resolve an execution namespace is also
    // missing coverage, not evidence that the selected root is unknown.
    rmSync(join(w.tree, "..", ".."), { recursive: true });
    writeFileSync(join(projectRuntimeDir(w.project), "threads"), "not a directory");
    expect((await w.service.heldPreparations()).errors).toEqual([
      expect.stringMatching(/not a plain directory/),
    ]);
    const selector = `prep1.${Buffer.from(JSON.stringify({ k: "envelope", root: w.tree, task: "t", attempt: "a" })).toString("base64url")}`;
    await expect(
      w.service.releasePreparation(
        { selector, digest: "0".repeat(64), confirm_processes_ended: true },
        w.serialize,
      ),
    ).rejects.toMatchObject({ status: 503, code: "preparation_roots_unreadable" });
  });

  it("inspection and release both refuse a current child after its preparation returned, and known live creators", async () => {
    const w = await world();
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const directExit = once(child, "exit").then(() => {});
    await once(child, "spawn");
    try {
      const cause = {
        reason: "direct_child_alive" as const,
        rootPid: child.pid!,
        groups: [],
        directExited: false,
        directExit,
      };
      holdThreadPreparation(w.tree, cause);
      await holdEnvelopePreparation(w.base, cause);
      holdPreparationChild(w.staging, directExit);
      for (const item of (await w.service.heldPreparations()).preparations) {
        expect(item.release).toBe("refused");
        expect(item.refusal).toMatch(/current child|still under way/);
        expect(
          await w.service.releasePreparation(
            { selector: item.selector, digest: item.digest, confirm_processes_ended: true },
            w.serialize,
          ),
        ).toMatchObject({ outcome: "refused" });
      }
      child.stdin.end();
      await directExit;
      // The base's owner stamps asynchronously. Finish that producer before
      // seeding the separate external-creator fixture below.
      await vi.waitFor(() =>
        expect(
          JSON.parse(readFileSync(join(w.base, "owner.json"), "utf8")).preparation.held
            .direct_exit_observed_at,
        ).toEqual(expect.any(Number)),
      );
      await vi.waitFor(async () =>
        expect(
          (await w.service.heldPreparations()).preparations.every(
            (item) => item.release === "operator_confirmation",
          ),
        ).toBe(true),
      );
    } finally {
      child.stdin.end();
      await directExit;
    }
    const creator = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const exit = once(creator, "exit");
    await once(creator, "spawn");
    try {
      const ownerPath = join(w.base, "owner.json");
      writeFileSync(
        ownerPath,
        JSON.stringify({
          ...JSON.parse(readFileSync(ownerPath, "utf8")),
          pid: creator.pid,
          started: null,
        }),
      );
      writeStagingOwner(w.staging, {
        schema: 1,
        intent: "index-pack",
        scope: null,
        writer: null,
        creator: { pid: creator.pid! },
      });
      for (const item of (await w.service.heldPreparations()).preparations.filter(
        (item) => item.kind !== "thread",
      )) {
        expect(item.release).toBe("refused");
        expect(item.refusal).toMatch(/creator/);
        expect(
          await w.service.releasePreparation(
            { selector: item.selector, digest: item.digest, confirm_processes_ended: true },
            w.serialize,
          ),
        ).toMatchObject({ outcome: "refused" });
      }
    } finally {
      creator.stdin.end();
      await exit;
    }
  });

  it("reads active jobs once per inspection, then reads current jobs inside release serialization", async () => {
    const w = await world();
    const jobs = vi.fn((): Array<{ state: string; params: { threadId: string } }> => []);
    const service = heldPreparationServices({
      roots: () => ({ projects: () => [w.project], execution: () => [] }),
      jobs,
      quiet: win32Quiet,
      readWriter: null,
    });
    const item = (await service.heldPreparations()).preparations.find(
      (item) => item.kind === "thread",
    )!;
    expect(jobs).toHaveBeenCalledTimes(1);
    const serialize: ThreadSerializer = (_id, work) => {
      jobs.mockReturnValue([{ state: "queued", params: { threadId: "purged-1" } }]);
      return work();
    };
    expect(
      await service.releasePreparation(
        { selector: item.selector, digest: item.digest, confirm_processes_ended: true },
        serialize,
      ),
    ).toMatchObject({
      outcome: "refused",
      reasons: ["a turn of this thread is queued or running"],
    });
    expect(jobs).toHaveBeenCalledTimes(2);
  });

  it("lists what is held under the known roots — a purged thread's record too — with a fresh read, and releases nothing", async () => {
    const w = await world();
    const held = await w.service.heldPreparations();
    expect(held.errors).toEqual([]);
    const byKind = Object.fromEntries(held.preparations.map((item) => [item.kind, item]));
    expect(Object.keys(byKind).sort()).toEqual(["envelope", "staging", "thread"]);
    expect(byKind.thread).toMatchObject({
      path: w.tree,
      thread_id: "purged-1",
      stop: { reason: "output_held", groups: [] },
      read: { status: "quiet", unproven: expect.stringMatching(/no process groups/) },
      release: "operator_confirmation",
      refusal: null,
      operator_release: null,
      on_release: expect.stringMatching(/removes only this record/),
      digest: recordDigest(readFileSync(join(w.tree, "..", "preparation.json"))),
    });
    expect(byKind.envelope).toMatchObject({ path: w.base, release: "operator_confirmation" });
    expect(byKind.staging).toMatchObject({ path: w.staging, release: "operator_confirmation" });
    expect(held.preparations.some((item) => item.path === w.finished)).toBe(false);
    // A read is not a release.
    expect(existsSync(join(w.tree, "..", "preparation.json"))).toBe(true);
    expect(existsSync(w.base)).toBe(true);
    expect(existsSync(w.staging)).toBe(true);
  });

  it("releases the selected resource on its inspected digest, in its thread's serializer; a stale digest changes nothing", async () => {
    const w = await world();
    const held = await w.service.heldPreparations();
    const thread = held.preparations.find((item) => item.kind === "thread")!;
    const stale = await w.service.releasePreparation(
      { selector: thread.selector, digest: "0".repeat(64), confirm_processes_ended: true },
      w.serialize,
    );
    expect(stale).toMatchObject({
      outcome: "stale",
      basis: null,
      remains: expect.stringMatching(/unchanged/),
    });
    expect(existsSync(join(w.tree, "..", "preparation.json"))).toBe(true);
    const done = await w.service.releasePreparation(
      { selector: thread.selector, digest: thread.digest, confirm_processes_ended: true },
      w.serialize,
    );
    expect(done).toMatchObject({
      outcome: "released",
      basis: "operator_confirmed",
      continued: false,
      // The record is gone: the answer keeps what it said and what was confirmed.
      generation: expect.stringMatching(/^thread:purged-1:/),
      stop: { reason: "output_held", groups: [], at: expect.any(String) },
      confirmed_at: expect.any(String),
      note: expect.stringMatching(
        /unconfirmed termination, its costs and its dispatch facts are unchanged/,
      ),
    });
    expect(w.calls).toEqual(["purged-1", "purged-1"]);
    expect(existsSync(join(w.tree, "..", "preparation.json"))).toBe(false);
    for (const kind of ["envelope", "staging"] as const) {
      const item = held.preparations.find((entry) => entry.kind === kind)!;
      expect(
        await w.service.releasePreparation(
          { selector: item.selector, digest: item.digest, confirm_processes_ended: true },
          w.serialize,
        ),
      ).toMatchObject({ kind, outcome: "released", basis: "operator_confirmed" });
      expect(existsSync(item.path)).toBe(false);
    }
    // Released already: nothing is held there, which proves nothing about the earlier request.
    expect(
      await w.service.releasePreparation(
        { selector: thread.selector, digest: thread.digest, confirm_processes_ended: true },
        w.serialize,
      ),
    ).toMatchObject({ outcome: "not_held" });
  });

  it("refuses while any turn of the thread is queued or running — a read-only or before-run one too", async () => {
    for (const job of [
      { state: "queued", params: { threadId: "purged-1", mode: "ask" } },
      { state: "running", params: { threadId: "purged-1", mode: "agent" } },
    ]) {
      const w = await world([job]);
      const held = await w.service.heldPreparations();
      const thread = held.preparations.find((item) => item.kind === "thread")!;
      expect(thread).toMatchObject({
        release: "refused",
        refusal: "a turn of this thread is queued or running",
      });
      expect(
        await w.service.releasePreparation(
          { selector: thread.selector, digest: thread.digest, confirm_processes_ended: true },
          w.serialize,
        ),
      ).toMatchObject({
        outcome: "refused",
        reasons: ["a turn of this thread is queued or running"],
      });
      expect(existsSync(join(w.tree, "..", "preparation.json"))).toBe(true);
    }
  });

  it.runIf(process.platform !== "win32")(
    "never follows a link below a runtime root: a linked thread directory, tree or record, a linked envelope base or staging directory is not listed and its crafted selector is refused, the files outside untouched",
    async () => {
      const w = await world();
      const runtime = projectRuntimeDir(w.project);
      const outside = realpathSync(mkdtempSync(join(tmpdir(), "cx-held-prep-outside-")));
      dirs.push(outside);
      const encode = (value: unknown) =>
        `prep1.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
      // Real owner records, outside the runtime tree, reached through links inside it.
      const record = (tree: string, id: string) => ({
        schema: 1,
        thread_id: id,
        tree,
        scope: null,
        opened_at: new Date(Date.now() - 60_000).toISOString(),
        own_registration: false,
        own_branch: null,
        held: { reason: "output_held", groups: [], at: new Date().toISOString() },
      });
      const victim = (name: string) => {
        const dir = join(outside, name);
        mkdirSync(join(dir, "tree"), { recursive: true });
        writeFileSync(join(dir, "tree", "keep.txt"), "user data\n");
        return dir;
      };
      // 1. The thread directory itself is a link.
      const linkedDir = victim("linked-dir");
      writeFileSync(
        join(linkedDir, "preparation.json"),
        JSON.stringify(record(join(runtime, "threads", "linked", "tree"), "linked")),
      );
      symlinkSync(linkedDir, join(runtime, "threads", "linked"));
      // 2. A plain thread directory whose tree is a link.
      const linkedTree = victim("linked-tree");
      mkdirSync(join(runtime, "threads", "treelink"));
      writeFileSync(
        join(runtime, "threads", "treelink", "preparation.json"),
        JSON.stringify(record(join(runtime, "threads", "treelink", "tree"), "treelink")),
      );
      symlinkSync(join(linkedTree, "tree"), join(runtime, "threads", "treelink", "tree"));
      // 3. A plain thread directory whose record is a link.
      mkdirSync(join(runtime, "threads", "recordlink", "tree"), { recursive: true });
      writeFileSync(
        join(outside, "record.json"),
        JSON.stringify(record(join(runtime, "threads", "recordlink", "tree"), "recordlink")),
      );
      symlinkSync(
        join(outside, "record.json"),
        join(runtime, "threads", "recordlink", "preparation.json"),
      );
      // 4. An envelope base that is a link.
      const base = victim("linked-base");
      writeFileSync(
        join(base, "owner.json"),
        JSON.stringify({ pid: 2 ** 22 + 9, preparation: { scope_marker: null, preparing: true } }),
      );
      symlinkSync(base, join(runtime, "workspaces", "task-1", "a9"));
      // 5. A staging directory that is a link.
      const staging = victim("linked-staging");
      writeFileSync(
        join(staging, "owner.json"),
        JSON.stringify({
          schema: 1,
          intent: "index-pack",
          creator: { pid: 2 ** 22 + 7 },
          scope: null,
          writer: null,
        }),
      );
      const stagingName = "tmp_claudexor-00000000-0000-4000-8000-000000000009";
      symlinkSync(staging, join(runtime, "git-store", "objects", stagingName));

      const held = await w.service.heldPreparations();
      const listed = held.preparations.map((item) => item.path);
      for (const path of [
        join(runtime, "threads", "linked", "tree"),
        join(runtime, "threads", "treelink", "tree"),
        join(runtime, "threads", "recordlink", "tree"),
        join(runtime, "workspaces", "task-1", "a9"),
        join(runtime, "git-store", "objects", stagingName),
      ])
        expect(listed).not.toContain(path);
      // Disclosed, not listed (the healthy held ones still are).
      expect(held.errors.join("\n")).toMatch(/link/);
      expect(held.preparations.map((item) => item.kind).sort()).toEqual([
        "envelope",
        "staging",
        "thread",
      ]);
      for (const selector of [
        { k: "thread", root: w.project, id: "linked" },
        { k: "thread", root: w.project, id: "treelink" },
        { k: "thread", root: w.project, id: "recordlink" },
        { k: "envelope", root: w.project, task: "task-1", attempt: "a9" },
        { k: "staging", root: w.project, name: stagingName },
      ]) {
        const refused = await w.service
          .releasePreparation(
            {
              selector: encode(selector),
              digest: "0".repeat(64),
              confirm_processes_ended: true,
            },
            w.serialize,
          )
          .catch((error: { status?: number; code?: string }) => error);
        expect(refused, JSON.stringify(selector)).toMatchObject({
          status: 409,
          code: "preparation_not_plain",
        });
      }
      expect(w.calls).toEqual([]);
      for (const dir of ["linked-dir", "linked-tree", "linked-base", "linked-staging"])
        expect(readFileSync(join(outside, dir, "tree", "keep.txt"), "utf8")).toBe("user data\n");
      expect(readdirSync(outside).sort()).toEqual([
        "linked-base",
        "linked-dir",
        "linked-staging",
        "linked-tree",
        "record.json",
      ]);
    },
  );

  it("resolves only selectors it issued, within the roots it knows now: anything else is refused before any file is read", async () => {
    const w = await world();
    const encode = (value: unknown) =>
      `prep1.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
    const release = (selector: string) =>
      w.service
        .releasePreparation(
          { selector, digest: "0".repeat(64), confirm_processes_ended: true },
          w.serialize,
        )
        .catch((error: { status?: number; code?: string }) => error);
    expect(await release("thread:/etc")).toMatchObject({ status: 400 });
    for (const id of [".", ".."])
      expect(await release(encode({ k: "thread", root: w.project, id }))).toMatchObject({
        status: 400,
      });
    expect(
      await release(encode({ k: "envelope", root: w.project, task: "..", attempt: "a1" })),
    ).toMatchObject({ status: 400 });
    expect(await release(encode({ k: "thread", root: w.project, id: "../../x" }))).toMatchObject({
      status: 400,
    });
    expect(await release(encode({ k: "staging", root: w.project, name: "pack" }))).toMatchObject({
      status: 400,
    });
    expect(await release(encode({ k: "thread", root: "/", id: "purged-1" }))).toMatchObject({
      status: 404,
      code: "preparation_root_unknown",
    });
    expect(
      await release(encode({ k: "envelope", root: "/tmp", task: "t", attempt: "a" })),
    ).toMatchObject({ status: 404 });
    expect(w.calls).toEqual([]);
  });

  // #694 V16: an inspection reads a thread record by the releases' own parser, so
  // it never offers a confirmation every release refuses.
  it("shows a record that is not this tree's, or torn, as unreadable with the releases' reason; both are refused and kept, the valid record beside them stays confirmable", async () => {
    const w = await world();
    const threads = join(projectRuntimeDir(w.project), "threads");
    const foreign = join(threads, "foreign-1", "preparation.json");
    mkdirSync(join(threads, "foreign-1", "tree"), { recursive: true });
    // Another thread's record in this directory: it names purged-1's tree.
    writeFileSync(foreign, readFileSync(join(w.tree, "..", "preparation.json")));
    const torn = join(threads, "torn-1", "preparation.json");
    mkdirSync(join(threads, "torn-1"), { recursive: true });
    writeFileSync(torn, '{"schema":1,"thread_id":"torn-1"');
    const items = (await w.service.heldPreparations()).preparations;
    const row = (id: string) => items.find((item) => item.thread_id === id)!;
    expect(row("purged-1")).toMatchObject({ release: "operator_confirmation", refusal: null });
    for (const [id, record, why] of [
      ["foreign-1", foreign, /^not this tree's record$/],
      ["torn-1", torn, /JSON/],
    ] as const) {
      const item = row(id);
      expect(item, id).toMatchObject({
        release: "refused",
        refusal: expect.stringMatching(/^its record cannot be read: /),
        read: { status: "held", reasons: [item.refusal] },
        digest: recordDigest(readFileSync(record)),
        on_release: expect.stringMatching(/never released/),
      });
      expect(item.refusal!.slice("its record cannot be read: ".length)).toMatch(why);
      const answer = await w.service.releasePreparation(
        { selector: item.selector, digest: item.digest, confirm_processes_ended: true },
        w.serialize,
      );
      expect(answer, id).toMatchObject({ outcome: "refused" });
      // The same reason as the inspection's.
      expect(answer.reasons).toEqual([
        `the record cannot be parsed: ${item.refusal!.slice("its record cannot be read: ".length)}`,
      ]);
      expect(existsSync(record)).toBe(true);
    }
  });

  /** The config root spelled another way (null: this filesystem has none such). */
  const spellings: Array<[string, (config: string) => string | null]> = [
    [
      "through a link",
      (config) => {
        if (process.platform === "win32") return null; // a link needs a privilege there
        const link = join(realpathSync(mkdtempSync(join(tmpdir(), "cx-held-prep-link-"))), "c");
        dirs.push(dirname(link));
        symlinkSync(config, link, "dir");
        return link;
      },
    ],
    [
      "in another letter case",
      (config) => {
        const respelled = join(dirname(config), basename(config).toUpperCase());
        return existsSync(respelled) ? respelled : null;
      },
    ],
  ];
  it.for(spellings)(
    "a record an earlier daemon wrote with the config root spelled %s is unreadable to this one, inspected and released alike; restoring that spelling releases it",
    async ([, spell], context) => {
      const config = realpathSync(mkdtempSync(join(tmpdir(), "cx-held-prep-config-")));
      dirs.push(config);
      const earlier = spell(config);
      if (earlier === null) return context.skip(); // a case-sensitive filesystem
      vi.stubEnv("CLAUDEXOR_CONFIG_DIR", earlier);
      try {
        const w = await world(); // written as the earlier daemon spelled the root
        vi.stubEnv("CLAUDEXOR_CONFIG_DIR", config); // this daemon: the same directory
        const item = (await w.service.heldPreparations()).preparations.find(
          (entry) => entry.thread_id === "purged-1",
        )!;
        expect(item).toMatchObject({
          release: "refused",
          refusal: "its record cannot be read: not this tree's record",
        });
        expect(
          await w.service.releasePreparation(
            { selector: item.selector, digest: item.digest, confirm_processes_ended: true },
            w.serialize,
          ),
        ).toMatchObject({
          outcome: "refused",
          reasons: ["the record cannot be parsed: not this tree's record"],
        });
        expect(existsSync(join(w.tree, "..", "preparation.json"))).toBe(true);
        // The recovery: the daemon started again with the producer's spelling.
        vi.stubEnv("CLAUDEXOR_CONFIG_DIR", earlier);
        const again = (await w.service.heldPreparations()).preparations.find(
          (entry) => entry.thread_id === "purged-1",
        )!;
        expect(again).toMatchObject({ release: "operator_confirmation", refusal: null });
        expect(
          await w.service.releasePreparation(
            { selector: again.selector, digest: again.digest, confirm_processes_ended: true },
            w.serialize,
          ),
        ).toMatchObject({ outcome: "released", basis: "operator_confirmed" });
        expect(existsSync(join(w.tree, "..", "preparation.json"))).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});
