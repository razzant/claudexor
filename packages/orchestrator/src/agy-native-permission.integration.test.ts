/** Actual AGY parser -> CLI run loop -> adapter -> Orchestrator. Only the vendor
 * executable and admission probes are replaced; no normalized events are injected.
 * The vendor frames are a synthetic reconstruction, not the historical recording
 * (whose normalized seq 20-23 are retained under harness-agy/src/test-support/normalized). */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliRunLoopOptions, HarnessAdapter } from "@claudexor/core";
import {
  ConformanceReport,
  CredentialProfile,
  HarnessManifest,
  type RunEvent,
} from "@claudexor/schema";
import { ArtifactStore } from "@claudexor/artifact-store";
import { createAgyAdapter } from "../../harness-agy/src/index.js";
import { Orchestrator } from "./orchestrator.js";

const fixture = vi.hoisted(() => ({
  frames: [] as unknown[],
  stderr: "",
  spawns: [] as CliRunLoopOptions[],
}));
vi.mock("@claudexor/core", async (original) => {
  const actual = await original<typeof import("@claudexor/core")>();
  return {
    ...actual,
    runCliHarness: (options: CliRunLoopOptions) => {
      fixture.spawns.push(options);
      return actual.runCliHarness({
        ...options,
        bin: process.execPath,
        args: [
          "-e",
          `
      require('node:fs').readFileSync(0);
      for (const frame of ${JSON.stringify(fixture.frames)}) console.log(JSON.stringify(frame));
      process.stderr.write(${JSON.stringify(fixture.stderr)});
    `,
        ],
      });
    },
  };
});

const narration = "I will read the requested file.";
const diagnostic =
  'jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied.';
// Evict the diagnostic from both the 40-line ring and 1000-character tail.
const longDiagnostic = diagnostic + "\r\n" + ("later stderr " + "x".repeat(80) + "\n").repeat(55);
const answer =
  'Verified fixture answer.\n\n```json\n{"work_report":{"state":"completed","required_inputs":[]}}\n```';
const roots: string[] = [];
afterEach(() => {
  fixture.spawns.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

async function run(
  mode: "ask" | "agent",
  final: "absent" | "empty" | "answer",
  denied: boolean | string = true,
) {
  const root = mkdtempSync(join(tmpdir(), "cx-agy-permission-"));
  roots.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  writeFileSync(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base"],
    { cwd: root, stdio: "pipe" },
  );
  const configDir = process.env.CLAUDEXOR_CONFIG_DIR!;
  const profiles = ["a", "b"].map((id) => {
    const home = join(configDir, "profiles", `agy-${id}`);
    mkdirSync(home, { recursive: true });
    return CredentialProfile.parse({
      profile_id: id,
      display_name: id,
      harness_id: "agy",
      credential_kind: "config_dir_login",
      isolation_locator: home,
    });
  });
  writeFileSync(
    join(configDir, "config.yaml"),
    JSON.stringify({
      runtime: { transient_retry: { max_retries: 2, initial_delay_ms: 1, max_delay_ms: 2 } },
      credential_profiles: profiles,
      harnesses: { agy: { profile_policy: { limit_action: "rotate" } } },
    }),
  );
  fixture.frames = [
    { event: "init", conversation_id: "fixture", init: { tools: [] } },
    { event: "step_update", step_update: { step_type: "agent_response", text_delta: narration } },
    ...["ACTIVE", "DONE"].map((state) => ({
      event: "step_update",
      step_update: {
        step_type: "tool",
        state,
        tool_info: { name: "view_file", parameters: { TargetFile: "/fixture/input.md" } },
      },
    })),
    ...(final === "absent"
      ? []
      : [
          {
            event: "result",
            result: {
              status: "SUCCESS",
              response: final === "answer" ? answer : "",
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ]),
  ];
  fixture.stderr = typeof denied === "string" ? denied : denied ? diagnostic : "";
  const native = createAgyAdapter({ prepareProfileKeychain: () => undefined });
  const adapter: HarnessAdapter = {
    ...native,
    async discover() {
      return HarnessManifest.parse({
        id: "agy",
        display_name: "AGY fixture",
        kind: "local_cli",
        provider_family: "google",
        capabilities: {
          implement: true,
          explain: true,
          read_files: true,
          work_report_transport: "validated",
          web_policy: "uncontrolled",
        },
        capability_profile: native.capabilityProfile,
        auth_modes: ["local_session"],
        access_profiles_supported: ["readonly", "workspace_write"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: "agy",
        status: "ok",
        enabled_intents: ["implement", "explain"],
        auth_sources: [
          { source: "native_session", availability: "available", verification: "passed" },
        ],
      });
    },
    async probeCredentialProfile(profile) {
      return {
        profile_id: profile.profile_id,
        harness_id: "agy",
        availability: "available",
        verification: "passed",
        verification_source: "local_store",
        last_verified_at: new Date().toISOString(),
      };
    },
    async models() {
      return [];
    },
  };
  const events: RunEvent[] = [];
  const result = await new Orchestrator({
    registry: new Map([["agy", adapter]]),
    reviewers: [],
    quotaSnapshots: () => [],
  }).run({
    repoRoot: root,
    mode,
    ...(mode === "agent" ? { inPlace: true } : {}),
    prompt: "Read the fixture file and explain it.",
    harnesses: ["agy"],
    review: false,
    web: "auto",
    onEvent: (event) => events.push(event),
  });
  const terminal = events.find((event) =>
    ["run.failed", "run.completed", "run.blocked"].includes(event.type),
  );
  return {
    result,
    events,
    resumable: terminal?.payload["resumable"],
    finalDir: join(result.runDir, "final"),
  };
}

describe("AGY native permission at the actual consumer boundary", () => {
  it.each([
    ["ask", "absent", "short"],
    ["agent", "absent", "short"],
    ["ask", "empty", "short"],
    ["agent", "empty", "short"],
    ["ask", "absent", "evicted"],
    ["agent", "absent", "evicted"],
    ["ask", "empty", "evicted"],
    ["agent", "empty", "evicted"],
  ] as const)(
    "%s/%s/%s: narration + zero exit + native denial is not a final answer or a retry",
    async (mode, final, detail) => {
      const out = await run(mode, final, detail === "evicted" ? longDiagnostic : diagnostic);
      expect(fixture.spawns).toHaveLength(1);
      expect(fixture.spawns[0]!.spec.access).toBe(mode === "ask" ? "readonly" : "workspace_write");
      expect(out.events.filter((event) => event.type === "route.profile.rotated")).toEqual([]);
      expect(out.resumable).toMatchObject({ cause: "permission_denied" });
      expect(out.result.lifecycle).toBe("failed");
      expect(JSON.stringify(out.result)).toContain("capability_refused");
      expect(existsSync(join(out.finalDir, "answer.md"))).toBe(false);
      expect(readFileSync(join(out.finalDir, "summary.md"), "utf8")).not.toContain(narration);
      expect(
        out.events.some(
          (event) => event.type === "output.ready" && event.payload["kind"] === "answer",
        ),
      ).toBe(false);
      // The durable run stream retains the partial observation in both modes.
      const durable = readFileSync(join(out.result.runDir, "events.jsonl"), "utf8");
      expect(durable).toContain(narration);
      const denial = out.events.find((event) => event.payload["permission_denial"]);
      expect(denial?.payload).toMatchObject({
        type: "error",
        permission_denial: { permission: "read_file", source: "agy_native_stderr" },
        payload: { code: "permission_denied" },
      });
      expect(durable).toContain(
        '"permission_denial":{"permission":"read_file","source":"agy_native_stderr"}',
      );
      expect(
        new Set(
          out.events
            .filter((event) => event.type === "harness.event")
            .map((event) => event.payload["attempt_id"]),
        ),
      ).toEqual(new Set(["a01"]));
      if (detail === "evicted") {
        const completed = out.events.find((event) => event.payload["type"] === "completed");
        expect(JSON.stringify(completed?.payload["payload"])).not.toContain("jetski:");
      }
    },
  );
  it.each(["ask", "agent"] as const)(
    "%s: a real typed final plus warning stays usable (INV-044)",
    async (mode) => {
      const out = await run(mode, "answer", longDiagnostic);
      expect(fixture.spawns).toHaveLength(1);
      expect(out.result.lifecycle).toBe("succeeded");
      expect(out.resumable).toBeUndefined();
      expect(readFileSync(join(out.finalDir, "answer.md"), "utf8")).toContain(
        "Verified fixture answer.",
      );
      expect(JSON.stringify(out.result.facts)).not.toContain("capability_refused");
      expect(out.events.find((event) => event.payload["permission_denial"])?.payload).toMatchObject(
        {
          type: "status",
          permission_denial: { permission: "read_file", source: "agy_native_stderr" },
        },
      );
    },
  );
  it("generic empty SUCCESS without native evidence does not invent permission denial", async () => {
    const out = await run("ask", "empty", false);
    expect(JSON.stringify(out.events)).not.toContain('"permission_denial"');
    expect(out.resumable).not.toMatchObject({ cause: "permission_denied" });
    expect(out.result.lifecycle).toBe("failed");
  });
  it("records the profile HOME the agy child actually received, not the engine HOME", async () => {
    const out = await run("agent", "answer", false);
    expect(out.result.lifecycle).toBe("succeeded");
    const childHome = fixture.spawns[0]!.env?.["HOME"];
    expect(childHome).toContain(join("profiles", "agy-"));
    const attempt = new ArtifactStore(out.result.runDir).readYaml<Record<string, unknown>>(
      join(out.result.runDir, "attempts", "a01", "attempt.yaml"),
    );
    expect(attempt).toMatchObject({ harness_home_isolated: true, harness_home_dir: childHome });
  });
  // The narration is a stream fragment, not a typed final: a stream that ended
  // without its terminal `result` is an honest failure (formerly an Ask success
  // answering with the narration), never an empty "(no output)" success.
  it.each(["ask", "agent"] as const)(
    "%s: no result and no denial is a missing-terminal failure with the narration retained",
    async (mode) => {
      const out = await run(mode, "absent", false);
      expect(out.result.lifecycle).toBe("failed");
      expect(existsSync(join(out.finalDir, "answer.md"))).toBe(false);
      expect(out.events.some((event) => event.payload["permission_denial"])).toBe(false);
      expect(
        out.events.filter(
          (event) =>
            event.type === "harness.event" &&
            String(event.payload["error"]).includes("agy ended without its terminal result"),
        ).length,
      ).toBe(fixture.spawns.length);
      // The tool step was progress: same-session continuations, never a fresh replay.
      expect(fixture.spawns[0]!.args).not.toContain("--conversation");
      for (const spawn of fixture.spawns.slice(1))
        expect(spawn.args[spawn.args.indexOf("--conversation") + 1]).toBe("fixture");
      expect(out.resumable).toMatchObject({ cause: "transport" });
      expect(readFileSync(join(out.finalDir, "retained-output.md"), "utf8")).toContain(narration);
    },
  );
});
