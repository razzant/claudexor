import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { envelopeBaseOf, readEnvelopeCustody } from "./envelope-custody.js";
import { WorkspaceManager } from "./manager.js";
import {
  RETAINED_ENVELOPE_POINTER,
  adoptRetainedEnvelope,
  holdsRetainedSources,
  recoverOrphanCustody,
  releaseRetainedEnvelope,
  retainForContinuation,
  retainForInspection,
  retainedEnvelopeBase,
  retainedEnvelopeOfRun,
  retainedSourcesOfRun,
} from "./retained-envelopes.js";

/** chmod 0o000 denies reads only where the platform honors the mode bits for
 * the current user (not root, not Windows where Node changes only the write
 * bit): probe the real capability once instead of guessing from uid. */
const canDenyRead = (() => {
  const dir = mkdtempSync(join(tmpdir(), "claudexor-retained-probe-"));
  const probe = join(dir, "probe");
  try {
    writeFileSync(probe, "x");
    chmodSync(probe, 0o000);
    try {
      readFileSync(probe);
      return false;
    } catch (error) {
      return (error as { code?: string }).code === "EACCES";
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
function thrownBy(fn: () => unknown): { code?: string; message: string } {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error("expected the strict read to throw");
}

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function temp(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `claudexor-retained-${name}-`)));
  dirs.push(dir);
  return dir;
}

function initRepo(): string {
  const dir = temp("repo");
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "a\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
  return dir;
}

/** Route-scoped auth material the adapters place in a scoped home. */
function seedAuth(home: string): { codexAuth: string; bridge: string } {
  const codexAuth = join(home, ".codex", "auth.json");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(codexAuth, "{}\n");
  const bridge = join(home, ".claudexor-claude-native", "Library", "Keychains");
  mkdirSync(join(home, ".claudexor-claude-native", "Library"), { recursive: true });
  symlinkSync(tmpdir(), bridge, "dir");
  return { codexAuth, bridge };
}

function linkExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

async function createKept(repo: string, runDir: string, taskId = "task-p") {
  const wsm = new WorkspaceManager(repo);
  const env = await wsm.create({
    taskId,
    attemptId: "a01",
    baseRef: "HEAD",
    dirtyPolicy: "snapshot",
    custody: { runId: "run-p", runDir },
  });
  writeFileSync(join(env.worktree_path, "a.txt"), "edited\n");
  writeFileSync(join(env.worktree_path, "new.txt"), "new file\n");
  return { wsm, env };
}

describe("retained envelopes (A9 custody)", () => {
  it("rebuilds a missing retained pointer from authoritative custody after a crash", async () => {
    const runDir = temp("missing-pointer");
    const { env } = await createKept(initRepo(), runDir);
    retainForContinuation(env, { runId: "run-p", runDir }, "transport");
    rmSync(join(runDir, RETAINED_ENVELOPE_POINTER));
    expect(retainedEnvelopeOfRun(runDir, "run-p")).toBeNull();
    expect(await recoverOrphanCustody(envelopeBaseOf(env))).toBe("kept");
    expect(retainedEnvelopeOfRun(runDir, "run-p")).toMatchObject({
      cause: "transport",
      envelope: { id: env.id },
    });
  });

  it("keeps a dead holder's session capsule even when its tree is unchanged", async () => {
    const runDir = temp("capsule-only");
    const env = await new WorkspaceManager(initRepo()).create({
      taskId: "task-session",
      attemptId: "a01",
      baseRef: "HEAD",
      custody: { runId: "run-p", runDir },
    });
    const attemptDir = join(runDir, "attempts", "a01");
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(
      join(attemptDir, "session-capsule.json"),
      JSON.stringify({
        harness: "fake",
        nativeSessionId: "session-p",
        holderProfileId: null,
        file: null,
        mtimeMs: null,
        sidecars: [],
        cwd: env.worktree_path,
        requestedModel: null,
      }) + "\n",
    );
    expect(await recoverOrphanCustody(envelopeBaseOf(env))).toBe("retained");
    expect(retainedEnvelopeOfRun(runDir, "run-p")).toMatchObject({
      cause: "host_restart",
      envelope: { id: env.id },
    });
    expect(existsSync(env.worktree_path)).toBe(true);
  });
  it("survives dispose, strips route-scoped auth, and is adopted with identical files", async () => {
    const repo = initRepo();
    const predRunDir = temp("pred-run");
    const succRunDir = temp("succ-run");
    const { wsm, env } = await createKept(repo, predRunDir);
    const base = envelopeBaseOf(env);
    expect(readEnvelopeCustody(base)).toMatchObject({ state: "live", holder_run_id: "run-p" });
    const auth = seedAuth(env.home_dir);

    const custody = retainForContinuation(env, { runId: "run-p", runDir: predRunDir }, "cancelled");
    expect(custody).toMatchObject({ state: "retained", cause: "cancelled" });
    expect(custody.bytes).toBeGreaterThan(0);
    expect(existsSync(auth.codexAuth)).toBe(false);
    expect(linkExists(auth.bridge)).toBe(false);
    expect(retainedEnvelopeOfRun(predRunDir, "run-p")?.envelope.id).toBe(env.id);
    expect(retainedEnvelopeOfRun(predRunDir, "run-other")).toBeNull();

    // Durable custody, not per-instance memory: no manager disposes it.
    await wsm.dispose(env);
    await new WorkspaceManager(repo).dispose(env);
    expect(existsSync(env.worktree_path)).toBe(true);

    const adopted = adoptRetainedEnvelope(custody, { runId: "run-s", runDir: succRunDir });
    expect(adopted).toEqual(env);
    expect(readFileSync(join(adopted.worktree_path, "a.txt"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(adopted.worktree_path, "new.txt"), "utf8")).toBe("new file\n");
    expect(readEnvelopeCustody(base)).toMatchObject({ state: "live", holder_run_id: "run-s" });
    expect(JSON.parse(readFileSync(join(base, "owner.json"), "utf8"))).toMatchObject({
      pid: process.pid,
      envelope_id: env.id,
    });
    // The predecessor no longer reports the envelope; its pointer is gone.
    expect(existsSync(join(predRunDir, RETAINED_ENVELOPE_POINTER))).toBe(false);
    expect(retainedEnvelopeOfRun(predRunDir, "run-p")).toBeNull();

    // A live (adopted) envelope that finishes is disposed as before.
    await wsm.dispose(adopted);
    expect(existsSync(base)).toBe(false);
  });

  it("releases a kept envelope and its run pointer on disposition", async () => {
    const repo = initRepo();
    const runDir = temp("run");
    const { env } = await createKept(repo, runDir);
    const custody = retainForContinuation(env, { runId: "run-p", runDir }, null);
    await releaseRetainedEnvelope(custody);
    expect(existsSync(envelopeBaseOf(env))).toBe(false);
    expect(existsSync(join(runDir, RETAINED_ENVELOPE_POINTER))).toBe(false);
  });

  it("recovers custody of ownerless envelopes after a crash", async () => {
    const repo = initRepo();
    const runDir = temp("run");
    // Crashed mid-attempt with edits: kept as retained (host_restart).
    const { env: crashed } = await createKept(repo, runDir, "task-crash");
    expect(await recoverOrphanCustody(envelopeBaseOf(crashed))).toBe("retained");
    expect(readEnvelopeCustody(envelopeBaseOf(crashed))).toMatchObject({
      state: "retained",
      cause: "host_restart",
    });
    expect(retainedEnvelopeOfRun(runDir, "run-p")?.envelope.id).toBe(crashed.id);
    // Already retained: kept, its auth stripped again.
    const auth = seedAuth(crashed.home_dir);
    expect(await recoverOrphanCustody(envelopeBaseOf(crashed))).toBe("kept");
    expect(existsSync(auth.codexAuth)).toBe(false);
    // Crashed before any change: nothing to continue, an ordinary orphan.
    const clean = await new WorkspaceManager(repo).create({
      taskId: "task-clean",
      attemptId: "a01",
      baseRef: "HEAD",
      custody: { runId: "run-c", runDir },
    });
    expect(await recoverOrphanCustody(envelopeBaseOf(clean))).toBeNull();
    // No custody at all: an ordinary orphan.
    const plain = await new WorkspaceManager(repo).create({
      taskId: "task-plain",
      attemptId: "a01",
    });
    writeFileSync(join(plain.worktree_path, "a.txt"), "edited\n");
    expect(await recoverOrphanCustody(envelopeBaseOf(plain))).toBeNull();
  });
});

describe("strict reads at the destructive seam", () => {
  it("reads absent and stale inspection addresses as nothing held but reports an unreadable or invalid pointer or custody record", async () => {
    const repo = initRepo();
    const runDir = temp("run");
    const { env } = await createKept(repo, runDir);
    // Nothing retained yet: every address is absent.
    expect(retainedSourcesOfRun(runDir, "run-p")).toEqual([]);
    const custody = retainForInspection(env, { runId: "run-p", runDir });
    expect(retainedSourcesOfRun(runDir, "run-p").map((s) => s.envelope.id)).toEqual([env.id]);
    expect(retainedSourcesOfRun(runDir, "run-other")).toEqual([]); // another holder: not held
    const pointer = join(runDir, "attempts", "a01", "retained-envelope.json");
    const pointerBytes = readFileSync(pointer);
    const custodyFile = join(envelopeBaseOf(env), "continuation-custody.json");
    const custodyBytes = readFileSync(custodyFile);
    const reports: unknown[] = [];

    writeFileSync(pointer, "{");
    expect(thrownBy(() => retainedSourcesOfRun(runDir, "run-p")).message).toMatch(
      /invalid retained-envelope pointer at .*a01[\\/]retained-envelope\.json/,
    );
    expect(holdsRetainedSources(runDir, "run-p", (e) => reports.push(e))).toBe(true);
    expect(retainedEnvelopeBase(runDir, "a01")).toBeNull(); // observational: still tolerant
    writeFileSync(pointer, JSON.stringify({ envelope_base: 42 }));
    expect(thrownBy(() => retainedSourcesOfRun(runDir, "run-p")).message).toMatch(
      /envelope_base is missing/,
    );
    for (const address of ["", "relative/dir"]) {
      // An empty or relative address names no envelope: never "nothing retained".
      writeFileSync(pointer, JSON.stringify({ envelope_base: address }));
      expect(thrownBy(() => retainedSourcesOfRun(runDir, "run-p")).message).toMatch(
        /envelope_base is not absolute/,
      );
    }
    rmSync(pointer);
    mkdirSync(pointer);
    expect(thrownBy(() => retainedSourcesOfRun(runDir, "run-p")).code).toBe("EISDIR");
    rmSync(pointer, { recursive: true });
    writeFileSync(pointer, pointerBytes);
    if (canDenyRead) {
      chmodSync(pointer, 0o000);
      expect(thrownBy(() => retainedSourcesOfRun(runDir, "run-p")).code).toBe("EACCES");
      expect(holdsRetainedSources(runDir, "run-p", (e) => reports.push(e))).toBe(true);
      chmodSync(pointer, 0o600);
      chmodSync(custodyFile, 0o000);
      expect(thrownBy(() => retainedSourcesOfRun(runDir, "run-p")).code).toBe("EACCES");
      expect(readEnvelopeCustody(envelopeBaseOf(env))).toBeNull(); // observational: tolerant
      chmodSync(custodyFile, 0o600);
    }
    writeFileSync(custodyFile, "{");
    expect(thrownBy(() => retainedSourcesOfRun(runDir, "run-p")).message).toMatch(
      /invalid envelope custody record at .*continuation-custody\.json/,
    );
    expect(holdsRetainedSources(runDir, "run-p", (e) => reports.push(e))).toBe(true);
    writeFileSync(custodyFile, custodyBytes);
    expect(reports.length).toBe(canDenyRead ? 3 : 2);
    // Readable again: held, and a stale address (custody released) is nothing held.
    expect(retainedSourcesOfRun(runDir, "run-p")).toHaveLength(1);
    await releaseRetainedEnvelope(custody);
    writeFileSync(pointer, pointerBytes); // a stale address left behind
    expect(retainedSourcesOfRun(runDir, "run-p")).toEqual([]);
    expect(holdsRetainedSources(runDir, "run-p", (e) => reports.push(e))).toBe(false);
    expect(reports.length).toBe(canDenyRead ? 3 : 2);
  });

  it("reads the continuation singleton pointer with the same strictness", async () => {
    const repo = initRepo();
    const runDir = temp("run");
    const { env } = await createKept(repo, runDir);
    retainForContinuation(env, { runId: "run-p", runDir }, "cancelled");
    expect(retainedSourcesOfRun(runDir, "run-p").map((s) => s.envelope.id)).toEqual([env.id]);
    const pointer = join(runDir, RETAINED_ENVELOPE_POINTER);
    const reports: unknown[] = [];
    writeFileSync(pointer, "null");
    expect(thrownBy(() => retainedSourcesOfRun(runDir, "run-p")).message).toMatch(
      /envelope_base is missing/,
    );
    expect(holdsRetainedSources(runDir, "run-p", (e) => reports.push(e))).toBe(true);
    expect(retainedEnvelopeOfRun(runDir, "run-p")).toBeNull(); // observational: tolerant
    writeFileSync(pointer, JSON.stringify({ envelope_base: "" }));
    expect(thrownBy(() => retainedSourcesOfRun(runDir, "run-p")).message).toMatch(
      /envelope_base is not absolute/,
    );
    if (canDenyRead) {
      writeFileSync(pointer, JSON.stringify({ envelope_base: envelopeBaseOf(env) }));
      chmodSync(pointer, 0o000);
      expect(thrownBy(() => retainedSourcesOfRun(runDir, "run-p")).code).toBe("EACCES");
      chmodSync(pointer, 0o600);
    }
    rmSync(pointer);
    expect(retainedSourcesOfRun(runDir, "run-p")).toEqual([]); // absent: nothing held
    expect(reports).toHaveLength(1);
  });
});
