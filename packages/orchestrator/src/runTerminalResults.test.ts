import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { RunFailure } from "@claudexor/schema";
import { writeFailure } from "./runTerminalResults.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function written(failure: Parameters<typeof writeFailure>[2]): RunFailure {
  const root = mkdtempSync(join(tmpdir(), "claudexor-write-failure-"));
  dirs.push(root);
  const store = new ArtifactStore(root, { claudexorDir: join(root, "runtime") });
  const paths = store.createRun("run-1");
  writeFailure(store, paths, failure);
  return RunFailure.parse(store.readYaml(join(paths.finalDir, "failure.yaml")));
}

const base = { phase: "harness", category: "harness_error", safeMessage: "at capacity" };

describe("writeFailure vendorFailure", () => {
  it("writes the vendor's typed failure verbatim beside the engine's own record", () => {
    const vendorFailure = {
      code: "server_overloaded",
      message: "Selected model is at capacity. Please try a different model.",
      source: "codex_rollout",
    };
    const failure = written({ ...base, vendorFailure });
    expect(failure.vendorFailure).toEqual(vendorFailure);
    // The engine's own classification is untouched by the vendor's code.
    expect(failure.category).toBe("harness_error");
    expect(failure.code).toBeNull();
  });

  it("writes null when there is no vendor-typed evidence (omitted or null)", () => {
    expect(written(base).vendorFailure).toBeNull();
    expect(written({ ...base, vendorFailure: null }).vendorFailure).toBeNull();
  });

  it("redacts a secret-like token inside the vendor's words and keeps null parts null (INV-146)", () => {
    // Assembled at runtime so the source never holds a contiguous secret-like token.
    const token = ["sk-or-v1", "c".repeat(40)].join("-");
    const failure = written({
      ...base,
      vendorFailure: { code: null, message: `rejected key ${token}`, source: "codex_rollout" },
    });
    expect(failure.vendorFailure?.code).toBeNull();
    expect(failure.vendorFailure?.message).not.toContain(token);
    expect(failure.vendorFailure?.message).toContain("[redacted]");
    expect(failure.vendorFailure?.source).toBe("codex_rollout");
  });
});
