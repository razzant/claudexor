/**
 * Every process a run launches carries the run's scope marker (run-deadline/1,
 * INV-144), or is one of the explicitly shared launches several runs use. On
 * representative runs — an isolated Git run with review, a gate and final
 * verification; an in-place Git run with a gate; a directory run in place
 * with a gate — every launch through the run-owned point is recorded: its
 * environment's marker must be the run's, or its shared name must be listed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { observeRunOwnedLaunches, type HarnessAdapter, type RunOwnedLaunch } from "@claudexor/core";
import { createFakeHarness } from "@claudexor/harness-fake";
import type { ReviewerSpec } from "@claudexor/review";
import { ConformanceReport, HarnessManifest } from "@claudexor/schema";
import { Orchestrator, type RunInput } from "./orchestrator.js";

/** The reviewed shared launches (`sharedLaunch` names): nothing else may launch unmarked. */
const SHARED = new Set([
  "cursor-status",
  "claude-auth-status",
  "claude-model-probe",
  "claude-help-probe",
  "program-version",
  "shared-read",
]);

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
}, 0);

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

function repo(prefix: string, withGit = true): string {
  const root = mkdtempSync(join(tmpdir(), `cx-scope-${prefix}-`));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "file.txt"), "before\n");
  if (withGit) {
    git(root, "init", "-q", "-b", "main");
    git(root, "add", ".");
    git(root, "-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "-qm", "base");
  }
  return root;
}

function editor(): HarnessAdapter {
  return {
    ...createFakeHarness("fake-success"),
    async *run(spec) {
      const common = { session_id: spec.session_id, ts: new Date().toISOString() };
      yield { ...common, type: "started", observed_model: "fixture" };
      writeFileSync(join(spec.cwd, "file.txt"), "after\n");
      yield { ...common, type: "message", text: "Done.", final: true };
      yield { ...common, type: "completed", exit_code: 0 };
    },
  };
}

function reviewer(id: string, family: "openai" | "anthropic"): ReviewerSpec {
  const adapter: HarnessAdapter = {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: family,
        capabilities: { review: true, read_files: true },
      });
    },
    async doctor() {
      return ConformanceReport.parse({ harness_id: id, status: "ok", enabled_intents: ["review"] });
    },
    async *run(spec) {
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts, observed_model: `${id}-model` };
      yield { type: "message", session_id: spec.session_id, ts, text: "```json\n[]\n```" };
      yield { type: "completed", session_id: spec.session_id, ts, exit_code: 0 };
    },
  };
  return { adapter, providerFamily: family };
}

const gate = {
  program: process.execPath,
  args: ["-e", "process.exit(0)"],
  envAllowlist: [],
};

async function recorded(input: Partial<RunInput>, reviewers: ReviewerSpec[] = []) {
  const adapter = editor();
  const launches: RunOwnedLaunch[] = [];
  let marker: string | undefined;
  const stop = observeRunOwnedLaunches((launch) => launches.push(launch));
  try {
    const result = await new Orchestrator({
      registry: new Map([[adapter.id, adapter]]),
      reviewers,
    }).run({
      delegated: true,
      mode: "agent",
      prompt: "edit",
      harnesses: [adapter.id],
      n: 1,
      tests: [gate],
      ...input,
      onRunScopeOpened: async (scope) => {
        marker = scope.marker;
      },
    } as RunInput);
    return { result, marker, launches };
  } finally {
    stop();
  }
}

describe("every process a run launches is inside its scope", () => {
  it.each([
    [
      "an isolated Git run with review, a gate and final verification",
      () => ({
        input: { repoRoot: repo("isolated"), review: true },
        reviewers: [reviewer("rev-a", "openai"), reviewer("rev-b", "anthropic")],
      }),
    ],
    [
      "an in-place Git run with a gate",
      () => ({
        input: {
          repoRoot: repo("project"),
          executionRoot: repo("exec"),
          inPlace: true,
          review: false,
        },
        reviewers: [],
      }),
    ],
    [
      "a directory run in place with a gate",
      () => {
        const root = repo("directory", false);
        return {
          input: {
            repoRoot: root,
            executionRoot: root,
            workspaceKind: "directory" as const,
            scopePaths: ["file.txt"],
            inPlace: true,
            review: false,
          },
          reviewers: [],
        };
      },
    ],
  ])("%s", async (_label, setup) => {
    const { input, reviewers } = setup();
    const { result, marker, launches } = await recorded(input as Partial<RunInput>, reviewers);
    expect(result.facts.lifecycle).toBe("succeeded");
    expect(marker).toBeDefined();
    expect(launches.length).toBeGreaterThan(0);
    const strays = launches
      .filter((launch) => launch.marker !== marker && !(launch.shared && SHARED.has(launch.shared)))
      .map(
        (launch) =>
          `${launch.binary} ${launch.args.slice(0, 3).join(" ")}${launch.shared ? ` [shared ${launch.shared}]` : ""}`,
      );
    expect(strays).toEqual([]);
  });
});
