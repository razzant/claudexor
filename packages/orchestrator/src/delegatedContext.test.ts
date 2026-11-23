import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
import { runCapture } from "@claudexor/core";
import { createFakeHarness } from "@claudexor/harness-fake";
import { ContextPack, type HarnessRunSpec } from "@claudexor/schema";
import { projectRuntimeDir, sha256 } from "@claudexor/util";
import { Orchestrator } from "./orchestrator.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

async function tree(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "delegated-context-"));
  roots.push(root);
  await runCapture("git", ["-C", root, "init", "-b", "main"]);
  return root;
}

function config(root: string, content: string): void {
  mkdirSync(join(root, ".claudexor"), { recursive: true });
  writeFileSync(join(root, ".claudexor", "config.yaml"), `version: 1\n${content}`);
}

function orchestrator(specs: HarnessRunSpec[] = []): Orchestrator {
  const base = createFakeHarness("fake-success");
  const adapter: HarnessAdapter = {
    ...base,
    async *run(spec) {
      specs.push(spec);
      yield* base.run(spec);
    },
  };
  return new Orchestrator({ registry: new Map([[adapter.id, adapter]]), reviewers: [] });
}

describe("delegated execution content", () => {
  it("records a released-reader-compatible failure on a Plan that loses the file after admission", async () => {
    const repoRoot = await tree();
    const executionRoot = await tree();
    config(repoRoot, "context:\n  mandatory_files: [REQUIRED.md]\n");
    const required = join(executionRoot, "REQUIRED.md");
    writeFileSync(required, "contents only in this workspace\n");
    const specs: HarnessRunSpec[] = [];
    const result = await orchestrator(specs).run({
      repoRoot,
      executionRoot,
      delegated: true,
      mode: "plan",
      prompt: "Read the required file",
      harnesses: ["fake-success"],
      onRunStart: () => rmSync(required),
    });
    expect(result.lifecycle).toBe("failed");
    expect(specs).toHaveLength(0);
    const failure = new ArtifactStore(repoRoot).readYaml(
      join(result.runDir, "final", "failure.yaml"),
    );
    expect(failure).toMatchObject({
      phase: "context",
      category: "project",
      // Keep the released 6.2.0 failure code enum closed. The untracked file vanished
      // before the atlas listed paths, so there is no per-path read error to report.
      code: null,
      safeMessage: expect.stringContaining("REQUIRED.md (not present in the context inventory)"),
    });
  });

  it("builds the Plan atlas from execution bytes with project-owned rules and artifacts", async () => {
    const repoRoot = await tree();
    const executionRoot = await tree();
    config(repoRoot, "context:\n  mandatory_files: [README.md]\n  exclude: [hidden.ts]\n");
    config(executionRoot, "context:\n  mandatory_files: [WRONG.md]\n");
    writeFileSync(join(repoRoot, "README.md"), "author content\n");
    writeFileSync(join(repoRoot, "author-only.ts"), "author\n");
    writeFileSync(join(executionRoot, "README.md"), "execution content\n");
    writeFileSync(join(executionRoot, "execution-only.ts"), "execution\n");
    writeFileSync(join(executionRoot, "hidden.ts"), "excluded by project config\n");
    const specs: HarnessRunSpec[] = [];

    const result = await orchestrator(specs).run({
      repoRoot,
      executionRoot,
      delegated: true,
      mode: "plan",
      prompt: "Plan from the bound workspace",
      harnesses: ["fake-success"],
    });

    expect(result.lifecycle).toBe("succeeded");
    expect(specs).toHaveLength(1);
    expect(specs[0]!.cwd).toBe(executionRoot);
    expect(specs[0]!.prompt).toContain("execution-only.ts");
    expect(specs[0]!.prompt).not.toContain("author-only.ts");
    expect(specs[0]!.prompt).not.toContain("hidden.ts");
    const pack = ContextPack.parse(
      new ArtifactStore(repoRoot).readYaml(join(result.runDir, "context", "context_pack.yaml")),
    );
    expect(pack.files.mandatory).toEqual([
      { path: "README.md", hash: sha256("execution content\n") },
    ]);
    expect(pack.atlas.map((entry) => entry.path)).not.toContain("author-only.ts");
    expect(result.runDir.startsWith(`${projectRuntimeDir(repoRoot)}/`)).toBe(true);
    expect(result.runDir.startsWith(`${projectRuntimeDir(executionRoot)}/`)).toBe(false);
  });

  it.each(["ask", "plan", "agent"] as const)(
    "%s validates project-required context in executionRoot before spawning",
    async (mode) => {
      const repoRoot = await tree();
      const executionRoot = await tree();
      config(repoRoot, "context:\n  mandatory_files: [REQUIRED.md]\n");
      writeFileSync(join(repoRoot, "REQUIRED.md"), "author file cannot satisfy execution\n");
      const specs: HarnessRunSpec[] = [];
      const orch = orchestrator(specs);
      const input = {
        repoRoot,
        executionRoot,
        delegated: true,
        mode,
        access: "readonly" as const,
        prompt: "Read required context",
        harnesses: ["fake-success"],
      };
      await expect(orch.run(input)).rejects.toMatchObject({
        code: "mandatory_context_unavailable",
        status: 409,
        retryable: false,
        context: {
          executionRoot,
          unavailableFiles: [{ path: "REQUIRED.md", reason: "ENOENT" }],
        },
      });
      expect(specs).toHaveLength(0);

      rmSync(join(repoRoot, "REQUIRED.md"));
      writeFileSync(join(executionRoot, "REQUIRED.md"), "available only in execution\n");
      const result = await orch.run(input);
      expect(result.lifecycle).toBe("succeeded");
      expect(specs).toHaveLength(1);
      expect(specs[0]!.cwd).toBe(executionRoot);
    },
  );
});
