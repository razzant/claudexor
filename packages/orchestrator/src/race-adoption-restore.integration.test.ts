import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
import { revertInPlaceFromAnchor } from "@claudexor/delivery";
import { createFakeHarness } from "@claudexor/harness-fake";
import type { ReviewerSpec } from "@claudexor/review";
import { ConformanceReport, HarnessManifest, type ProviderFamily } from "@claudexor/schema";
import { Orchestrator } from "./orchestrator.js";

// INV-114 through the real race adoption: `adopted:false`/`not_applied` means
// the tree is unchanged. An adoption that fails after writing is taken back; one
// that cannot be taken back is recorded as live and revertable, never not_applied.
const roots: string[] = [];
// The fixtures' own Git never reads the operator's global or system config.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): { root: string; git: (...args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), "cx-race-restore-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { env: GIT_ENV }).toString("utf8");
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "file.txt"), "before\n");
  writeFileSync(join(root, ".gitattributes"), "*.weird filter=up\n");
  git("add", ".");
  git("-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "-qm", "base");
  return { root, git };
}

function reviewer(id: string, providerFamily: ProviderFamily): ReviewerSpec {
  const model = `${id}-model`;
  return {
    providerFamily,
    requestedModel: model,
    adapter: {
      id,
      async discover() {
        return HarnessManifest.parse({
          id,
          display_name: id,
          kind: "local_cli",
          provider_family: providerFamily,
          access_profiles_supported: ["readonly"],
          capabilities: { review: true, known_models: [model] },
        });
      },
      async doctor() {
        return ConformanceReport.parse({
          harness_id: id,
          status: "ok",
          enabled_intents: ["review"],
        });
      },
      async *run(spec) {
        const base = { session_id: spec.session_id, ts: new Date().toISOString() };
        const route = { credential_route: "managed_api_key" as const };
        yield { ...base, ...route, type: "started", observed_model: model };
        yield { ...base, type: "message", text: "```json\n[]\n```" };
        yield { ...base, type: "completed" };
      },
    },
  };
}

/** A two-candidate race that wins in isolation and is adopted into the live tree. */
async function race(root: string) {
  const base = createFakeHarness("fake-success");
  const adapter: HarnessAdapter = {
    ...base,
    async *run(spec) {
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started", observed_model: "fixture" };
      writeFileSync(join(spec.cwd, "file.txt"), "after\n");
      writeFileSync(join(spec.cwd, "new.weird"), "lower bytes\n");
      yield { ...common, type: "message", text: "Done.", final: true };
      yield { ...common, type: "completed", exit_code: 0 };
    },
  };
  const result = await new Orchestrator({
    registry: new Map([[adapter.id, adapter]]),
    reviewers: [reviewer("rev-o", "openai"), reviewer("rev-g", "google")],
  }).run({
    repoRoot: root,
    mode: "agent",
    prompt: "edit",
    harnesses: [adapter.id],
    n: 2,
    inPlace: true,
    synthesis: "never",
  });
  const store = new ArtifactStore(result.runDir);
  return {
    result,
    meta: store.readYaml<{ meta: Record<string, any> }>(
      join(result.runDir, "final/work_product.yaml"),
    )!.meta,
    receipt: store.readYaml<Record<string, any>>(
      join(result.runDir, "final/delivery_receipt.yaml"),
    )!,
  };
}

describe("race adoption keeps adopted:false true (INV-114)", () => {
  it("an adoption that fails its content proof is taken back: adopted:false over an unchanged tree", async () => {
    const { root, git } = repo();
    git("config", "filter.up.clean", "tr a-z A-Z");
    git("config", "filter.up.smudge", "cat");
    const { meta, receipt } = await race(root);
    expect(receipt).toMatchObject({
      applied: false,
      refused: true,
      treeMutated: false,
      refusal: { code: "delivery_content_mismatch" },
    });
    expect(receipt.deliveryPair).toBeUndefined();
    expect(receipt.detail).toContain("the write was taken back, so the target is unchanged");
    expect(meta).toMatchObject({ adopted: false, apply_state: "not_applied" });
    expect(meta.revert_anchor_id).toBeNull();
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("before\n");
    expect(existsSync(join(root, "new.weird"))).toBe(false);
    expect(git("status", "--porcelain")).toBe("");
  });

  it("an adoption that cannot be taken back is recorded live and revertable, not adopted:false", async () => {
    const { root, git } = repo();
    // The proof's own clean succeeds once and mismatches; the restore's snapshot then fails.
    const script = join(mkdtempSync(join(tmpdir(), "cx-race-restore-filter-")), "clean.sh");
    roots.push(join(script, ".."));
    writeFileSync(
      script,
      `#!/bin/sh\nif [ -e "${script}.ran" ]; then exit 1; fi\n: > "${script}.ran"\ntr a-z A-Z\n`,
    );
    chmodSync(script, 0o755);
    git("config", "filter.up.clean", script);
    git("config", "filter.up.smudge", "cat");
    git("config", "filter.up.required", "true");
    const { meta, receipt } = await race(root);
    expect(receipt).toMatchObject({
      applied: false,
      refused: true,
      treeMutated: true,
      refusal: { code: "delivery_content_mismatch" },
    });
    expect(receipt.detail).toContain("RECOVERY REQUIRED");
    expect(meta).toMatchObject({
      adopted: true,
      apply_state: "applied_review_blocked",
      execution_root: expect.any(String),
    });
    expect(meta.revert_anchor_id).toEqual(expect.any(String));
    expect(existsSync(join(root, "new.weird"))).toBe(true);
    // Once the fault is gone the recorded anchor really reverts the write that stayed.
    git("config", "--unset", "filter.up.required");
    git("config", "--unset", "filter.up.clean");
    expect(await revertInPlaceFromAnchor(root, meta.revert_anchor_id)).toMatchObject({
      reverted: true,
    });
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("before\n");
    expect(existsSync(join(root, "new.weird"))).toBe(false);
  });
});
