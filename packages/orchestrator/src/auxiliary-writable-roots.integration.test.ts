import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { runCapture, type HarnessAdapter } from "@claudexor/core";
import { createFakeHarness } from "@claudexor/harness-fake";
import {
  HarnessManifest,
  RoutePoolDegradedPayload,
  RunFailure,
  TaskContract,
  type HarnessRunSpec,
  type RunEvent,
} from "@claudexor/schema";
import { Orchestrator, type RunInput } from "./orchestrator.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

async function fixture(): Promise<{ repoRoot: string; cache: string; cacheLink: string }> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "aux-roots-run-")));
  roots.push(base);
  const repoRoot = join(base, "project");
  const cache = join(base, "shared", "uv-cache");
  mkdirSync(repoRoot);
  mkdirSync(cache, { recursive: true });
  const cacheLink = join(base, "cache-link");
  symlinkSync(cache, cacheLink);
  await runCapture("git", ["-C", repoRoot, "init", "-b", "main"]);
  writeFileSync(join(repoRoot, "README.md"), "fixture\n");
  await runCapture("git", ["-C", repoRoot, "add", "README.md"]);
  await runCapture("git", [
    "-C",
    repoRoot,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "fixture",
  ]);
  return { repoRoot, cache, cacheLink };
}

/** A routable (non-fake-kind) lane over the deterministic fake implementer. */
function lane(id: string, capable: boolean, specs: HarnessRunSpec[]): HarnessAdapter {
  const base = createFakeHarness("fake-implement");
  return {
    ...base,
    id,
    async discover() {
      const manifest = await base.discover();
      return HarnessManifest.parse({
        ...manifest,
        id,
        kind: "local_cli",
        capability_profile: {
          ...manifest.capability_profile,
          access_control: {
            ...manifest.capability_profile.access_control,
            auxiliary_writable_roots: capable,
          },
        },
      });
    },
    async doctor(spec) {
      return { ...(await base.doctor(spec)), harness_id: id };
    },
    async *run(spec) {
      specs.push(spec);
      yield* base.run(spec);
    },
  };
}

function orchestrator(specs: HarnessRunSpec[]): Orchestrator {
  const registry = new Map(
    [lane("aux-capable", true, specs), lane("aux-plain", false, specs)].map((a) => [a.id, a]),
  );
  return new Orchestrator({ registry, reviewers: [] });
}

const agent = (repoRoot: string, extra: Partial<RunInput> = {}): RunInput => ({
  repoRoot,
  mode: "agent",
  prompt: "Bootstrap the environment",
  access: "workspace_write",
  review: false,
  n: 1,
  ...extra,
});

describe("auxiliary writable roots through a run", () => {
  it("routes Auto only to capable lanes and records the canonical grant", async () => {
    const { repoRoot, cache, cacheLink } = await fixture();
    const specs: HarnessRunSpec[] = [];
    const events: RunEvent[] = [];
    const result = await orchestrator(specs).run(
      agent(repoRoot, {
        auxiliaryWritableRoots: [cacheLink, cache],
        onEvent: (event) => events.push(event),
      }),
    );
    expect(result.lifecycle).toBe("succeeded");
    expect(specs.map((spec) => [spec.access, spec.auxiliary_writable_roots])).toEqual([
      ["workspace_write", [cache]],
    ]);
    expect(specs[0]!.prompt).toContain(
      `writable service directories outside the execution workspace`,
    );
    expect(specs[0]!.prompt).toContain(cache);
    const degraded = RoutePoolDegradedPayload.parse(
      events.find((event) => event.type === "route.pool.degraded")?.payload,
    );
    expect(degraded.dropped_lanes).toEqual([
      expect.objectContaining({ harness_id: "aux-plain", stage: "access" }),
    ]);
    const contract = TaskContract.parse(
      new ArtifactStore(repoRoot).readYaml(join(result.runDir, "context", "task.yaml")),
    );
    expect(contract.access).toMatchObject({
      effective_profile: "workspace_write",
      auxiliary_writable_roots: [cache],
    });
  });

  it("refuses an explicit lane that cannot apply the grant before it spawns", async () => {
    const { repoRoot, cache } = await fixture();
    const specs: HarnessRunSpec[] = [];
    const result = await orchestrator(specs).run(
      agent(repoRoot, { harnesses: ["aux-plain"], auxiliaryWritableRoots: [cache] }),
    );
    expect(result.lifecycle).toBe("failed");
    expect(specs).toEqual([]);
    expect(
      RunFailure.parse(
        new ArtifactStore(repoRoot).readYaml(join(result.runDir, "final/failure.yaml")),
      ),
    ).toMatchObject({ code: "auxiliary_writable_roots_unsupported" });
  });

  it.each([
    ["omitted", {}],
    ["explicit []", { auxiliaryWritableRoots: [] }],
  ])("keeps %s byte-for-byte legacy on every lane, capable or not", async (_name, extra) => {
    const { repoRoot } = await fixture();
    const specs: HarnessRunSpec[] = [];
    const result = await orchestrator(specs).run(
      agent(repoRoot, { harnesses: ["aux-plain"], ...extra }),
    );
    expect(result.lifecycle).toBe("succeeded");
    expect(specs[0]!.auxiliary_writable_roots).toEqual([]);
    expect(specs[0]!.prompt).not.toContain("writable service directories");
    const contract = TaskContract.parse(
      new ArtifactStore(repoRoot).readYaml(join(result.runDir, "context", "task.yaml")),
    );
    expect(contract.access.auxiliary_writable_roots).toEqual([]);
  });

  it.each([
    [{ access: "readonly" as const }, "auxiliary_writable_roots_access_conflict"],
    [{ access: "full" as const }, "auxiliary_writable_roots_access_conflict"],
    [{ access: "inherit_native" as const }, "auxiliary_writable_roots_access_conflict"],
    [{ mode: "plan" as const, n: undefined }, "auxiliary_writable_roots_access_conflict"],
    [{ mode: "ask" as const, n: undefined }, "auxiliary_writable_roots_access_conflict"],
  ])("refuses %o before any lane spawns", async (extra, code) => {
    const { repoRoot, cache } = await fixture();
    const specs: HarnessRunSpec[] = [];
    await expect(
      orchestrator(specs).run(agent(repoRoot, { ...extra, auxiliaryWritableRoots: [cache] })),
    ).rejects.toMatchObject({ code, status: 400 });
    expect(specs).toEqual([]);
  });

  it.each(["live-project", "delegated-directory"] as const)(
    "refuses %s service roots inside captured work before a lane starts",
    async (kind) => {
      const { repoRoot, cache } = await fixture();
      const executionRoot = kind === "live-project" ? repoRoot : join(repoRoot, "..", "work");
      const scratch = join(executionRoot, "scratch");
      mkdirSync(scratch, { recursive: true });
      const specs: HarnessRunSpec[] = [];
      await expect(
        orchestrator(specs).run(
          agent(repoRoot, {
            inPlace: true,
            ...(kind === "live-project"
              ? {}
              : {
                  delegated: true,
                  executionRoot,
                  workspaceKind: "directory",
                  scopePaths: ["."],
                }),
            auxiliaryWritableRoots: [cache, scratch],
          }),
        ),
      ).rejects.toMatchObject({
        code: "auxiliary_writable_root_unsafe",
        status: 400,
        context: { reason: "execution_tree" },
      });
      expect(specs).toEqual([]);
    },
  );

  it("refuses a missing or project-reaching directory at the engine boundary", async () => {
    const { repoRoot } = await fixture();
    const specs: HarnessRunSpec[] = [];
    await expect(
      orchestrator(specs).run(
        agent(repoRoot, { auxiliaryWritableRoots: [join(repoRoot, "..", "absent")] }),
      ),
    ).rejects.toMatchObject({ code: "auxiliary_writable_root_invalid" });
    await expect(
      orchestrator(specs).run(
        agent(repoRoot, { auxiliaryWritableRoots: [join(repoRoot, ".git")] }),
      ),
    ).rejects.toMatchObject({ code: "auxiliary_writable_root_unsafe" });
    expect(specs).toEqual([]);
  });
});
