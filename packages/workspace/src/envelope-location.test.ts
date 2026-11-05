import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { oneShotRuntimeDir, projectRuntimeDir } from "@claudexor/util";
import { envelopeRuntimeRoot, physicalEnvelopeBase } from "./envelope-recovery.js";
import { WorkspaceManager } from "./manager.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0);
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

describe("envelope location (#503)", () => {
  it("keeps a project's envelope in its namespace and disposes the physical base from any manager", async () => {
    const project = temp("cx-loc-project-");
    const execution = temp("cx-loc-exec-");
    const runtimeRoot = projectRuntimeDir(project);
    const creator = new WorkspaceManager(execution, { projectRoot: project, runtimeRoot });
    const env = await creator.create({
      taskId: "task",
      attemptId: "a1",
      inPlace: true,
      accessProfile: "readonly",
    });
    const base = join(runtimeRoot, "workspaces", "task", "a1");
    expect(env.home_dir).toBe(join(base, "home"));
    expect(JSON.parse(readFileSync(join(base, "owner.json"), "utf8"))).toMatchObject({
      execution_root: execution,
    });
    // The temporary execution root gets no namespace of its own.
    expect(existsSync(projectRuntimeDir(execution))).toBe(false);
    // A manager bound elsewhere (an adopting successor, a legacy default) disposes where it is.
    await new WorkspaceManager(execution).dispose(env);
    expect(existsSync(base)).toBe(false);
    expect(existsSync(execution)).toBe(true);
  });

  it("trusts a recorded base only inside an engine-owned workspaces directory with the same ids", () => {
    const fallback = join(temp("cx-loc-fallback-"), "workspaces");
    const oneShot = join(oneShotRuntimeDir(), "workspaces", "task", "a1");
    expect(envelopeRuntimeRoot(oneShot)).toBe(oneShotRuntimeDir());
    const ids = { task_id: "task", attempt_id: "a1" };
    expect(physicalEnvelopeBase({ ...ids, home_dir: join(oneShot, "home") }, fallback)).toBe(
      oneShot,
    );
    // Other ids than the envelope's own, or a foreign directory, fall back.
    const crafted = { task_id: "other", attempt_id: "a1", home_dir: join(oneShot, "home") };
    expect(physicalEnvelopeBase(crafted, fallback)).toBe(join(fallback, "other", "a1"));
    const foreign = join(temp("cx-loc-foreign-"), "workspaces", "task", "a1");
    expect(envelopeRuntimeRoot(foreign)).toBeNull();
    expect(physicalEnvelopeBase({ ...ids, home_dir: join(foreign, "home") }, fallback)).toBe(
      join(fallback, "task", "a1"),
    );
  });
});
