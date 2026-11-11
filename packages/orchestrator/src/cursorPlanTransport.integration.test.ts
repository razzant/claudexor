import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCapture, type CliRunLoopOptions, type HarnessAdapter } from "@claudexor/core";
import type { HarnessEvent } from "@claudexor/schema";
import { ArtifactStore } from "@claudexor/artifact-store";
import { createCursorAdapter } from "../../harness-cursor/src/index.js";
import { Orchestrator } from "./orchestrator.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

afterAll(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

async function initializedRepository(): Promise<string> {
  const root = temporaryDirectory("claudexor-cursor-plan-");
  await runCapture("git", ["-C", root, "init", "-b", "main"]);
  writeFileSync(join(root, "README.md"), "# Cursor Plan fixture\n");
  await runCapture("git", ["-C", root, "add", "-A"]);
  await runCapture("git", [
    "-C",
    root,
    "-c",
    "user.email=qa@example.invalid",
    "-c",
    "user.name=QA",
    "commit",
    "-m",
    "fixture",
  ]);
  return root;
}

describe("Cursor Plan validated transport composition", () => {
  it("uses read-only Ask transport and delivers a validated WorkReport without fallback", async () => {
    const repo = await initializedRepository();
    const configDir = temporaryDirectory("claudexor-cursor-plan-config-");
    let captured: CliRunLoopOptions | undefined;
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => ({ kind: "authenticated" }),
      cursorApiKey: () => null,
      listCursorModels: async () => [],
      smokeIsolatedApiKey: async () => ({ ok: false, detail: "not needed" }),
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        captured = opts;
        const plan = [
          "# Plan",
          "",
          "## Goal",
          "Create the requested file without changing unrelated code.",
          "",
          "## Steps",
          "1. Confirm the repository root.",
          "2. Create the file with the exact requested content.",
          "3. Verify its bytes and Git status.",
          "",
          "## Risks",
          "- Do not commit unless the user asks.",
          "",
          "## Open Questions",
          "- [single] Where should the file live? :: repository root :: tmp directory",
          "- [text] Should the file be committed?",
        ].join("\n");
        const envelope = [
          plan,
          "```json",
          '{"work_report":{"state":"completed","required_inputs":[]}}',
          "```",
        ].join("\n");
        const frames = [
          { type: "system", subtype: "init", model: "cursor-test" },
          { type: "assistant", message: { content: [{ text: envelope }] } },
          { type: "result", subtype: "success", total_cost_usd: 0 },
        ];
        for (const frame of frames) {
          for (const event of opts.parseEvent?.(frame, opts.spec.session_id) ?? []) yield event;
        }
        yield {
          type: "completed",
          session_id: opts.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });

    const previousConfig = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    // Unified account model (D-U3): a cursor run routes through an account
    // row's file store — pin one so the plan transport composes under it.
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: work",
        "    harness_id: cursor",
        "    display_name: Work",
        "    credential_kind: config_dir_login",
        `    isolation_locator: '${join(configDir, "profiles", "cursor-work")}'`,
        "",
      ].join("\n"),
    );
    mkdirSync(join(configDir, "profiles", "cursor-work"), { recursive: true });
    let result;
    try {
      const registry = new Map<string, HarnessAdapter>([["cursor", adapter]]);
      result = await new Orchestrator({ registry, reviewers: [] }).run({
        repoRoot: repo,
        prompt: "Create a read-only implementation plan.",
        mode: "plan",
        harnesses: ["cursor"],
        credentialProfileId: "work",
      });
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfig;
    }

    const args = captured?.args ?? [];
    expect(args.flatMap((arg, index) => (arg === "--mode" ? [args[index + 1]] : []))).toEqual([
      "ask",
    ]);
    expect(args).toContain("--sandbox");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("enabled");
    expect(args).toContain("--trust");
    expect(args).toContain("--force");
    expect(args).not.toContain(captured?.input);
    expect(captured?.input).toContain("complete final answer as normal Markdown");
    expect(captured?.input).not.toContain('"output"');

    expect(result.lifecycle).toBe("succeeded");
    expect(result.facts.work_state).toEqual({
      state: "completed",
      source: "validated",
    });
    const plan = readFileSync(join(result.runDir, "final", "plan.md"), "utf8").trim();
    expect(plan).toContain("# Plan");
    expect(plan).toContain("3. Verify its bytes and Git status.");
    expect(plan).toContain("## Open Questions");
    expect(plan).not.toContain("work_report");
    const questions = JSON.parse(
      readFileSync(join(result.runDir, "final", "questions.json"), "utf8"),
    ) as { parse: string; questions: Array<{ kind: string; prompt: string }> };
    expect(questions.parse).toBe("found");
    expect(questions.questions).toHaveLength(2);
    expect(questions.questions.map((question) => question.kind)).toEqual(["single", "text"]);
    const events = readFileSync(join(result.runDir, "events.jsonl"), "utf8");
    expect(events).not.toContain("route.fallback.started");
    expect(events).not.toContain("work_report contract");
    expect((await runCapture("git", ["-C", repo, "status", "--porcelain"])).stdout).toBe("");
  });

  it("records the profile HOME a Cursor agent child actually received", async () => {
    const repo = temporaryDirectory("claudexor-cursor-home-");
    writeFileSync(join(repo, "README.md"), "fixture\n");
    const configDir = temporaryDirectory("claudexor-cursor-home-config-");
    const profileHome = join(configDir, "profiles", "cursor-work");
    mkdirSync(profileHome, { recursive: true });
    writeFileSync(
      join(configDir, "config.yaml"),
      [
        "credential_profiles:",
        "  - profile_id: work",
        "    harness_id: cursor",
        "    display_name: Work",
        "    credential_kind: config_dir_login",
        `    isolation_locator: '${profileHome}'`,
        "",
      ].join("\n"),
    );
    let captured: CliRunLoopOptions | undefined;
    const adapter = createCursorAdapter({
      detectVersion: async () => "cursor-test",
      nativeAuthOk: async () => ({ kind: "authenticated" }),
      cursorApiKey: () => null,
      listCursorModels: async () => [],
      smokeIsolatedApiKey: async () => ({ ok: false, detail: "not needed" }),
      runCliHarness: async function* (opts: CliRunLoopOptions): AsyncGenerator<HarnessEvent> {
        captured = opts;
        const answer = [
          "Done.",
          "```json",
          '{"work_report":{"state":"completed","required_inputs":[]}}',
          "```",
        ].join("\n");
        for (const frame of [
          { type: "system", subtype: "init", model: "cursor-test" },
          { type: "assistant", message: { content: [{ text: answer }] } },
          { type: "result", subtype: "success", result: answer },
        ])
          for (const event of opts.parseEvent?.(frame, opts.spec.session_id) ?? []) yield event;
        yield { type: "completed", session_id: opts.spec.session_id, ts: new Date().toISOString() };
      },
    });
    const previousConfig = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = configDir;
    let result;
    try {
      result = await new Orchestrator({
        registry: new Map<string, HarnessAdapter>([["cursor", adapter]]),
        reviewers: [],
      }).run({
        repoRoot: repo,
        workspaceKind: "directory",
        inPlace: true,
        prompt: "Reply Done.",
        mode: "agent",
        harnesses: ["cursor"],
        credentialProfileId: "work",
        review: false,
      });
    } finally {
      if (previousConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previousConfig;
    }
    expect(result.lifecycle, result.summary).toBe("succeeded");
    const childHome = captured?.env?.["HOME"];
    expect(childHome).toBe(realpathSync(profileHome));
    const attempt = new ArtifactStore(repo).readYaml<Record<string, unknown>>(
      join(result.runDir, "attempts", "a01", "attempt.yaml"),
    );
    expect(attempt).toMatchObject({ harness_home_isolated: true, harness_home_dir: childHome });
  });
});
