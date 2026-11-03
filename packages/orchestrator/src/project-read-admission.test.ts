import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { runCapture } from "@claudexor/core";
import { ConformanceReport, HarnessManifest, type HarnessRunSpec } from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import { timelineEvents } from "../../control-api/src/run-timeline.js";
import { createRawApiAdapter } from "../../harness-raw-api/src/index.js";
import { Orchestrator } from "./orchestrator.js";

// #133: answering needs no file access, so a raw API whose doctor
// enables `explain` serves Ask without a project, while project-scoped Ask —
// answered by the harness reading the project itself — refuses before dispatch
// for a route that cannot read files. Auto routing stays doctor-ok only.

const reapDirs: string[] = [];
function reapMk(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  reapDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of reapDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)
beforeEach(() => {
  vi.stubEnv("CLAUDEXOR_TEST_OPENROUTER_KEY", "sk-test-not-a-real-key");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** The real raw-API manifest and doctor (degraded: key present, unsmoked);
 * dispatch and inventory are recorded instead of reaching the network. */
function openRouter(dispatched: HarnessRunSpec[]): HarnessAdapter {
  const adapter = createRawApiAdapter({
    id: "openrouter",
    providerFamily: "unknown",
    baseUrl: "http://127.0.0.1:9/never",
    keyEnv: "CLAUDEXOR_TEST_OPENROUTER_KEY",
  });
  adapter.models = async () => [];
  adapter.run = async function* (spec) {
    dispatched.push(spec);
    const ts = new Date().toISOString();
    yield { type: "started", session_id: spec.session_id, ts };
    yield { type: "message", session_id: spec.session_id, ts, text: "4", final: true };
    yield { type: "completed", session_id: spec.session_id, ts };
  };
  return adapter;
}

/** A doctor-ok harness that reads files, for the Auto pool. */
function reader(id: string, dispatched: HarnessRunSpec[]): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "anthropic",
        capabilities: { plan: true, read_files: true, web_policy: "tools" },
        access_profiles_supported: ["readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({ harness_id: id, status: "ok", enabled_intents: [] });
    },
    async *run(spec) {
      dispatched.push(spec);
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts };
      yield { type: "message", session_id: spec.session_id, ts, text: "4", final: true };
      yield { type: "completed", session_id: spec.session_id, ts };
    },
  };
}

async function project(): Promise<string> {
  const repo = reapMk("claudexor-project-read-");
  await runCapture("git", ["-C", repo, "init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  await runCapture("git", ["-C", repo, "add", "-A"]);
  await runCapture("git", [
    "-C",
    repo,
    ...["-c", "user.email=t@t.dev", "-c", "user.name=t", "commit", "-m", "init"],
  ]);
  return repo;
}

function noProject(): string {
  const root = noProjectRepoRoot();
  mkdirSync(root, { recursive: true });
  return root;
}

describe("Ask capability is separate from reading project files (#133)", () => {
  it("an explicitly selected degraded raw API answers Ask without a project", async () => {
    const dispatched: HarnessRunSpec[] = [];
    const res = await new Orchestrator({
      registry: new Map([["openrouter", openRouter(dispatched)]]),
      reviewers: [],
    }).run({
      repoRoot: noProject(),
      prompt: "2+2?",
      mode: "ask",
      contextMode: "off",
      harnesses: ["openrouter"],
    });
    expect(res.lifecycle, res.summary).toBe("succeeded");
    expect(dispatched.map((spec) => spec.intent)).toEqual(["explain"]);
  });

  it("a project Ask on a route that cannot read files refuses before dispatch, naming the remedy", async () => {
    const dispatched: HarnessRunSpec[] = [];
    const res = await new Orchestrator({
      registry: new Map([["openrouter", openRouter(dispatched)]]),
      reviewers: [],
    }).run({
      repoRoot: await project(),
      prompt: "What does README.md say?",
      mode: "ask",
      harnesses: ["openrouter"],
    });
    expect(res.lifecycle).toBe("failed");
    expect(res.summary).toContain(
      "openrouter (cannot read project files: ask without a project or choose a harness that reads files)",
    );
    expect(dispatched).toEqual([]);
    const failure = readFileSync(join(res.runDir, "final", "failure.yaml"), "utf8");
    expect(failure).toContain("phase: routing");
    expect(failure).toContain("category: harness_unavailable");
  });

  it("the Auto pool never routes the degraded raw API, even as the requested primary, and says so", async () => {
    const remote: HarnessRunSpec[] = [];
    const local: HarnessRunSpec[] = [];
    const res = await new Orchestrator({
      registry: new Map([
        ["openrouter", openRouter(remote)],
        ["reader", reader("reader", local)],
      ]),
      reviewers: [],
    }).run({
      repoRoot: noProject(),
      prompt: "2+2?",
      mode: "ask",
      contextMode: "off",
      primaryHarness: "openrouter",
    });
    expect(res.lifecycle, res.summary).toBe("succeeded");
    expect(remote).toEqual([]);
    expect(local.map((spec) => spec.intent)).toEqual(["explain"]);
    // The substitution is disclosed as a typed event the receipt renders.
    const events = readFileSync(join(res.runDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
    const detail = "openrouter is degraded: key present but route unproven (no isolated smoke)";
    expect(events.find((event) => event.type === "route.primary.diverged")?.payload).toMatchObject({
      requested: "openrouter",
      effective: "reader",
      reason: "readiness_preferred",
      detail,
    });
    // The run-detail timeline consumer shows that cause, not missing auth.
    expect(
      timelineEvents({}, events).find((row) => row.type === "route.primary.diverged"),
    ).toMatchObject({ severity: "warning", detail });
  });
});
