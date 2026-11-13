import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { HarnessManifest } from "@claudexor/schema";
import type { ReviewerSpec } from "./reviewEngine.js";

/**
 * A reviewer's `metadata.json` is a synchronous whole-file write on the main
 * thread. Adapters stamp the credential route, profile and observed model on
 * every harness event, so the reviewer loop rewrites the file when one of
 * those values changes, never per event (#688). The spy wraps `writeFileSync`
 * for every module of this test's graph.
 */
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const patched = { writeFileSync: vi.fn(actual.writeFileSync) };
  return { ...actual, ...patched, default: { ...actual, ...patched } };
});
const { reviewCandidate } = await import("./reviewEngine.js");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const DIFF = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

/** A reviewer whose every event carries its route facts: one event per entry of
 * `profiles`, each stamped with that profile, then the final answer. */
function routedReviewer(profiles: readonly string[]): ReviewerSpec {
  const adapter: HarnessAdapter = {
    id: "routed",
    async discover() {
      return HarnessManifest.parse({
        id: "routed",
        display_name: "routed",
        kind: "local_cli",
        provider_family: "openai",
        capabilities: { review: true, read_files: true },
      });
    },
    async doctor() {
      throw new Error("not used");
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      const route = { credential_route: "vendor_native" as const, observed_model: "m1" };
      for (const [index, profile] of profiles.entries())
        yield {
          type: "message",
          session_id: spec.session_id,
          ts,
          text: `note ${index}`,
          credential_profile_id: profile,
          ...route,
        };
      yield {
        type: "message",
        session_id: spec.session_id,
        ts,
        text: "[]",
        final: true,
        credential_profile_id: profiles.at(-1),
        ...route,
      };
    },
  };
  return { adapter, providerFamily: "openai" };
}

/** Review once; answer every `metadata.json` the reviewer wrote, in order. */
async function metadataWrites(profiles: readonly string[]) {
  const cwd = mkdtempSync(join(tmpdir(), "claudexor-reviewer-metadata-"));
  roots.push(cwd);
  const evidenceDir = join(cwd, ".claudexor-review-evidence");
  mkdirSync(evidenceDir, { recursive: true });
  for (const name of ["USER_INTENT.md", "FORBIDDEN_FINDINGS.md", "PLAN_ACCEPTED.md"])
    writeFileSync(join(evidenceDir, name), "(none)\n");
  writeFileSync(join(evidenceDir, "TESTS.txt"), "(tests not run)\n");
  writeFileSync(join(evidenceDir, "DECIDED_TRADEOFFS.md"), "(none)\n");
  const artifactsDir = join(cwd, "artifacts");
  const metadataPath = join(artifactsDir, "01-routed", "metadata.json");
  vi.mocked(fs.writeFileSync).mockClear();
  await reviewCandidate({
    candidateLabel: "Routed candidate",
    diff: DIFF,
    evidenceDir,
    artifactsDir,
    cwd,
    reviewers: [routedReviewer(profiles)],
  });
  const writes = vi
    .mocked(fs.writeFileSync)
    .mock.calls.filter(([path]) => String(path) === metadataPath)
    .map(([, data]) => JSON.parse(String(data)) as Record<string, unknown>);
  const final = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
  // The writes that recorded a newly observed profile, in order.
  const profileChanges = writes
    .map((metadata) => metadata["observed_credential_profile_id"])
    .filter((profile, index, all) => profile !== undefined && profile !== all[index - 1]);
  return { writes: writes.length, profileChanges, final };
}

describe("reviewer metadata follows a changed value, not each event (#688)", () => {
  it("writes metadata.json once for many events of one profile, and once more when it changes", async () => {
    const few = await metadataWrites(Array.from({ length: 20 }, () => "profile-a"));
    const many = await metadataWrites(Array.from({ length: 200 }, () => "profile-a"));
    const changed = await metadataWrites([
      ...Array.from({ length: 100 }, () => "profile-a"),
      ...Array.from({ length: 100 }, () => "profile-b"),
    ]);
    // Direction 1: ten times the events cost no extra write; a changed profile
    // costs exactly one.
    expect(many.writes).toBe(few.writes);
    expect(many.profileChanges).toEqual(["profile-a"]);
    expect(changed.profileChanges).toEqual(["profile-a", "profile-b"]);
    expect(changed.writes).toBe(many.writes + 1);
    // Direction 2: the route facts are still recorded, the changed one included.
    expect(many.final).toMatchObject({
      observed_credential_profile_id: "profile-a",
      observed_model: "m1",
      auth_modes: ["local_session"],
      status: "completed",
    });
    expect(changed.final).toMatchObject({
      observed_credential_profile_id: "profile-b",
      observed_model: "m1",
      auth_modes: ["local_session"],
      status: "completed",
    });
  });
});
