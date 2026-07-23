import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlServices } from "./control-services.js";

/**
 * Ф2 finding 7: the project-remove active-run fence parses each non-terminal
 * job's scope through the typed RunScope schema, so a project run can never
 * silently drop out of the fence (fail-open), and a run whose scope cannot be
 * resolved fails CLOSED.
 */
function servicesWith(
  jobs: Array<{ runId?: string; state: string; params?: unknown }>,
  captured: { roots?: ReadonlySet<string> },
) {
  const threads = {
    removeProject: (_id: string, activeRunRoots: ReadonlySet<string>) => {
      captured.roots = activeRunRoots;
      return { projectId: _id, root: "/x", registryRemoved: true };
    },
  };
  return controlServices(
    undefined as never,
    undefined as never,
    threads as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    async () => jobs,
  );
}

describe("removeProject active-run fence: typed scope, no fail-open (Ф2 finding 7)", () => {
  let configDir: string;
  let prev: string | undefined;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "clawdexor-remove-fence-"));
    prev = process.env["CLAUDEXOR_CONFIG_DIR"];
    process.env["CLAUDEXOR_CONFIG_DIR"] = configDir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env["CLAUDEXOR_CONFIG_DIR"];
    else process.env["CLAUDEXOR_CONFIG_DIR"] = prev;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("collects live PROJECT run roots and ignores terminal / no-project runs", async () => {
    const captured: { roots?: ReadonlySet<string> } = {};
    const services = servicesWith(
      [
        // Live project run → its root is fenced.
        { runId: "r1", state: "running", params: { scope: { kind: "project", root: "/repo/a" } } },
        // Terminal run → skipped even though it names a project.
        {
          runId: "r2",
          state: "succeeded",
          params: { scope: { kind: "project", root: "/repo/b" } },
        },
        // Live no-project (pure ask) run → holds no project, safely ignored.
        { runId: "r3", state: "running", params: { scope: { kind: "none" } } },
        // A non-run job (no runId) with no scope → ignored.
        { state: "running", params: {} },
      ],
      captured,
    );
    await services.removeProject("prj-1");
    expect([...(captured.roots ?? [])]).toContain("/repo/a");
    expect([...(captured.roots ?? [])]).not.toContain("/repo/b");
    expect(captured.roots?.size).toBe(1);
  });

  it("FAILS CLOSED when a live RUN's scope cannot be resolved (no silent skip)", async () => {
    const captured: { roots?: ReadonlySet<string> } = {};
    const services = servicesWith(
      [
        // A live run whose params carry a malformed/unrecognizable scope: we
        // cannot prove it does not reference the project being removed, so the
        // removal must refuse loudly rather than fail open.
        { runId: "r9", state: "running", params: { scope: { kind: "project" } } },
      ],
      captured,
    );
    await expect(services.removeProject("prj-1")).rejects.toThrow(/scope of active run r9/);
    // The fence never reached removeProject with an under-counted set.
    expect(captured.roots).toBeUndefined();
  });
});
