import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { runCapture } from "@claudexor/core";
import { PreProgressRefusalLedger } from "@claudexor/daemon";
import { Orchestrator } from "@claudexor/orchestrator";
import { ConformanceReport, HarnessEvent, HarnessManifest } from "@claudexor/schema";

// Preserved production evidence ends at these normalized adapter events. The
// historical run predates the ledger; its behavior below is a NEW offline
// regression, not a claim about raw vendor bytes or a live-account rerun.
const recorded = JSON.parse(
  readFileSync(
    new URL("./fixtures/cursor-pre-progress-refusal.normalized.json", import.meta.url),
    "utf8",
  ),
) as { events: unknown[] };
const incident = recorded.events.map((event) => HarnessEvent.parse(event));
const MODEL = "grok-4.7-xhigh-fast";
const OTHER_MODEL = "other-model";
let root: string;
let previous: string | undefined;
let runIndex: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cursor-incident-"));
  previous = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = root;
  runIndex = 0;
  writeFileSync(
    join(root, "config.yaml"),
    [
      "credential_profiles:",
      ...["account-a", "account-b"].flatMap((id) => [
        `  - profile_id: ${id}`,
        "    harness_id: cursor",
        `    display_name: ${id}`,
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${JSON.stringify(join(root, "profiles", id))}`,
      ]),
      "runtime:",
      "  transient_retry:",
      "    max_retries: 0",
      "",
    ].join("\n"),
  );
});
afterEach(() => {
  if (previous === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
  else process.env.CLAUDEXOR_CONFIG_DIR = previous;
  rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

async function run(
  ledger: PreProgressRefusalLedger,
  options: { model?: string; pin?: string; progress?: boolean; healthy?: boolean } = {},
) {
  const repo = join(root, `repo-${runIndex++}`);
  const initialized = await runCapture("git", ["init", "-b", "main", repo]);
  expect(initialized.code).toBe(0);
  writeFileSync(join(repo, "README.md"), "# Offline fixture\n");
  expect((await runCapture("git", ["-C", repo, "add", "README.md"])).code).toBe(0);
  expect(
    (
      await runCapture("git", [
        "-C",
        repo,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "fixture",
      ])
    ).code,
  ).toBe(0);
  const spawns: Array<string | null> = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const adapter: HarnessAdapter = {
    id: "cursor",
    async discover() {
      return HarnessManifest.parse({
        id: "cursor",
        display_name: "Offline recorded Cursor stream",
        kind: "local_cli",
        provider_family: "local",
        access_profiles_supported: ["readonly"],
        capabilities: { plan: true, read_files: true, known_models: [MODEL, OTHER_MODEL] },
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: "cursor",
        status: "ok",
        enabled_intents: ["explain"],
      });
    },
    async probeCredentialProfile(profile) {
      return {
        profile_id: profile.profile_id,
        harness_id: "cursor",
        availability: "available",
        verification: "passed",
        verification_source: "local_store",
        detail: "Offline fixture",
        last_verified_at: new Date().toISOString(),
      };
    },
    async *run(spec) {
      const id = spec.credential_profile?.profile_id ?? null;
      spawns.push(id);
      if (id === "account-a" && !options.healthy) {
        // Preserve order, timestamps, error and terminal payload verbatim;
        // bind only the redacted identities to this fixture's isolated run.
        for (const event of incident) {
          yield { ...event, session_id: spec.session_id, credential_profile_id: id };
          if (event.type === "started" && options.progress)
            yield { type: "thinking", session_id: spec.session_id, ts: event.ts, text: "Working" };
        }
        return;
      }
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts };
      yield { type: "message", session_id: spec.session_id, ts, text: "Answer", final: true };
      yield { type: "completed", session_id: spec.session_id, ts, payload: { exit_code: 0 } };
    },
  };
  const result = await new Orchestrator({
    registry: new Map([["cursor", adapter]]),
    reviewers: [],
    preProgressRefusals: ledger,
  }).run({
    repoRoot: repo,
    mode: "ask",
    prompt: "Offline regression",
    harnesses: ["cursor"],
    model: options.model ?? MODEL,
    ...(options.pin ? { credentialProfileId: options.pin } : {}),
    onEvent: (event) =>
      events.push({ type: event.type, payload: event.payload as Record<string, unknown> }),
  });
  return { spawns, events, lifecycle: result.lifecycle };
}

const marks = (ledger: PreProgressRefusalLedger) =>
  ledger.live().map((mark) => [mark.harness_id, mark.profile_id, mark.requested_model]);

describe("recorded Cursor started → usage refusal → exit 1 (#363)", () => {
  it("demotes that account only for the same requested model on the next unpinned run", async () => {
    expect(incident.map((event) => event.type)).toEqual(["started", "error", "completed"]);
    expect(incident[2]?.payload?.["exit_code"]).toBe(1);
    const ledger = new PreProgressRefusalLedger();
    const first = await run(ledger);
    expect(first.spawns).toEqual(["account-a", "account-b"]);
    expect(first.lifecycle).toBe("succeeded");
    expect(
      first.events.find((event) => event.type === "route.profile.rotated")?.payload["reason"],
    ).toBe("structural_pre_progress_failure");
    expect(marks(ledger)).toEqual([["cursor", "account-a", MODEL]]);
    const second = await run(ledger);
    expect(second.spawns).toEqual(["account-b"]);
    expect(second.events.some((event) => event.type === "route.profile.rotated")).toBe(false);
    // The existing mark neither demotes another model nor excludes a pin.
    expect((await run(ledger, { model: OTHER_MODEL, healthy: true })).spawns).toEqual([
      "account-a",
    ]);
    expect(marks(ledger)).toEqual([["cursor", "account-a", MODEL]]);
    expect((await run(ledger, { pin: "account-a" })).spawns).toEqual(["account-a"]);
  });

  it.each([
    ["explicit pin", { pin: "account-a" }],
    ["agent progress before the same refusal", { progress: true }],
    ["ordinary successful stream", { healthy: true }],
  ] as const)("records no false mark for %s", async (_label, options) => {
    const ledger = new PreProgressRefusalLedger();
    expect((await run(ledger, options)).spawns).toEqual(["account-a"]);
    expect(marks(ledger)).toEqual([]);
    expect((await run(ledger, { healthy: true })).spawns).toEqual(["account-a"]);
  });
});
