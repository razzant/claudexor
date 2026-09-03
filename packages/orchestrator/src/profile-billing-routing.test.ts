import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessAdapter } from "@claudexor/core";
import { ConformanceReport, HarnessManifest } from "@claudexor/schema";
import { afterEach, describe, expect, it } from "vitest";
import { Orchestrator } from "./orchestrator.js";

const scratchDirs: string[] = [];

function scratch(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of scratchDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function initializedRepo(): string {
  const repo = scratch("claudexor-profile-billing-repo-");
  execFileSync("git", ["-C", repo, "init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# test\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "-m",
    "init",
  ]);
  return repo;
}

function profileOnlyCodex(): HarnessAdapter {
  return {
    id: "codex",
    async discover() {
      return HarnessManifest.parse({
        id: "codex",
        display_name: "Codex",
        kind: "local_cli",
        provider_family: "openai",
        capabilities: { read_files: true },
        access_profiles_supported: ["readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: "codex",
        status: "unavailable",
        reasons: ["the default Codex home is not logged in"],
        auth_sources: [
          {
            source: "native_session",
            availability: "unavailable",
            verification: "not_run",
          },
        ],
      });
    },
    async probeCredentialProfile(profile) {
      return {
        profile_id: profile.profile_id,
        harness_id: profile.harness_id,
        availability: "available",
        verification: "passed",
        verification_source: "local_store",
        last_verified_at: new Date().toISOString(),
      };
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield {
        type: "started",
        session_id: spec.session_id,
        ts,
        credential_route: "vendor_native",
        credential_profile_id: "work-primary",
      } as const;
      yield { type: "message", session_id: spec.session_id, ts, text: "ok" } as const;
      yield { type: "completed", session_id: spec.session_id, ts } as const;
    },
  };
}

describe("profile-backed subscription routing", () => {
  it("keeps a vendor-verified Codex profile eligible when paid fallback is never", async () => {
    const configDir = scratch("claudexor-profile-billing-config-");
    const profileHome = join(configDir, "profiles", "work-primary");
    mkdirSync(profileHome, { recursive: true });
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "routing:",
        "  paid_fallback: never",
        "credential_profiles:",
        "  - profile_id: work-primary",
        "    harness_id: codex",
        "    display_name: Work (Primary)",
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${profileHome}`,
        "    secret_ref: null",
        "    enabled: true",
        "    created_at: 2026-09-01T07:05:45.812Z",
        "",
      ].join("\n"),
    );
    const previousConfigDir = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    try {
      const observedAt = new Date().toISOString();
      const result = await new Orchestrator({
        registry: new Map([["codex", profileOnlyCodex()]]),
        reviewers: [],
        quotaSnapshots: () => [
          {
            subject: {
              harness: "codex",
              credential_route: "vendor_native",
              plan_label: "pro",
              subject_id: "work-primary",
            },
            constraints: [],
            source: "codex_app_server",
            observed_at: observedAt,
            freshness: "fresh",
          },
        ],
      }).run({
        repoRoot: initializedRepo(),
        prompt: "hello",
        mode: "ask",
        harnesses: ["codex"],
        credentialProfileId: "work-primary",
        web: "auto",
      });

      expect(result.lifecycle, result.summary).toBe("succeeded");
      expect(result.candidates).toEqual([
        expect.objectContaining({ harnessId: "codex", status: "success" }),
      ]);
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfigDir;
    }
  });
});
