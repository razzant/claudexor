import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runCapture, type HarnessAdapter } from "@claudexor/core";
import { ConformanceReport, HarnessManifest } from "@claudexor/schema";
import { ArtifactStore } from "@claudexor/artifact-store";
import { processTiming } from "@claudexor/util";
import { Orchestrator } from "./orchestrator.js";

const reapDirs: string[] = [];
afterAll(() => {
  for (const dir of reapDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

async function initRepo(): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), "claudexor-run-end-writes-"));
  reapDirs.push(repo);
  await runCapture("git", ["-C", repo, "init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  await runCapture("git", ["-C", repo, "add", "-A"]);
  await runCapture("git", [
    "-C",
    repo,
    "-c",
    "user.email=t@t.dev",
    "-c",
    "user.name=t",
    "commit",
    "-m",
    "init",
  ]);
  return repo;
}

const implementer: HarnessAdapter = {
  id: "impl",
  async discover() {
    return HarnessManifest.parse({
      id: "impl",
      display_name: "impl",
      kind: "local_cli",
      provider_family: "local",
      capabilities: { implement: true },
      access_profiles_supported: ["workspace_write", "full"],
    });
  },
  async doctor() {
    return ConformanceReport.parse({
      harness_id: "impl",
      status: "ok",
      enabled_intents: ["implement"],
    });
  },
  async *run(spec) {
    const ts = new Date().toISOString();
    yield { type: "started", session_id: spec.session_id, ts, credential_route: "managed_api_key" };
    writeFileSync(join(spec.cwd, "CHANGED.txt"), "real change\n");
    yield { type: "message", session_id: spec.session_id, ts, text: "Implemented." };
    yield { type: "completed", session_id: spec.session_id, ts };
  },
};

describe("run-end artifact writes (#688)", () => {
  it("await the attempt, patch, scope and product files; telemetry stays synchronous and labeled", async () => {
    const repo = await initRepo();
    const sync = {
      yaml: vi.spyOn(ArtifactStore.prototype, "writeYaml"),
      text: vi.spyOn(ArtifactStore.prototype, "writeText"),
      patch: vi.spyOn(ArtifactStore.prototype, "writePatch"),
    };
    const awaited = {
      yaml: vi.spyOn(ArtifactStore.prototype, "writeYamlAsync"),
      text: vi.spyOn(ArtifactStore.prototype, "writeTextAsync"),
      patch: vi.spyOn(ArtifactStore.prototype, "writePatchAsync"),
    };
    const recorded = vi.spyOn(processTiming, "recordSync");
    try {
      const res = await new Orchestrator({
        registry: new Map([["impl", implementer]]),
      }).run({ repoRoot: repo, prompt: "do it", mode: "agent", harnesses: ["impl"], n: 1 });
      expect(res.lifecycle).toBe("succeeded");
      const paths = (spy: { mock: { calls: unknown[][] } }) =>
        spy.mock.calls.map(([path]) => relative(res.runDir, String(path)).replaceAll("\\", "/"));
      // Direction 1: the per-run-end files went through the awaited writers.
      expect(paths(awaited.yaml)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^attempts\/[^/]+\/attempt\.yaml$/),
          "final/process_scope.yaml",
          "final/work_product.yaml",
        ]),
      );
      expect(paths(awaited.patch)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^attempts\/[^/]+\/patch\.diff$/),
          "final/patch.diff",
        ]),
      );
      expect(paths(awaited.text)).toContain("final/summary.md");
      for (const path of [...paths(sync.yaml), ...paths(sync.text), ...paths(sync.patch)])
        expect(path).not.toMatch(
          /attempt\.yaml$|patch\.diff$|process_scope\.yaml$|work_product\.yaml$|summary\.md$/,
        );
      // Direction 2: the telemetry artifact deliberately stays synchronous, and
      // its section names itself in worstSync; the files read back whole.
      expect(paths(sync.yaml)).toContain("final/telemetry.yaml");
      expect(recorded.mock.calls.some(([op]) => op === "run.telemetry_write")).toBe(true);
      expect(readFileSync(join(res.runDir, "final", "patch.diff"), "utf8")).toContain(
        "CHANGED.txt",
      );
      expect(readFileSync(join(res.runDir, "final", "process_scope.yaml"), "utf8")).toContain(
        "marker:",
      );
    } finally {
      for (const spy of [...Object.values(sync), ...Object.values(awaited), recorded])
        spy.mockRestore();
    }
  });
});
