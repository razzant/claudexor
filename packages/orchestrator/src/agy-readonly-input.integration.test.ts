/** #653 at the actual consumer boundary: Orchestrator -> AGY adapter -> CLI run
 * loop -> a scripted vendor child. Only the executable is replaced. The child
 * behaves as agy 1.5.0 did in the recorded 8 Nov runs: a command matched by a
 * deny rule fails as a tool step and the turn continues (arm B); without one,
 * plan mode's unanswerable ask is auto-denied and the turn ends empty (arm A);
 * piped input past 192,000 bytes is cut with the vendor's notice (24 triage
 * transcripts). So the same scenarios fail on the base tree. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { createAgyAdapter } from "../../harness-agy/src/index.js";
import { summarizeThreadPrefix } from "./continuity-summary.js";
import { Orchestrator } from "./orchestrator.js";

const fixture = vi.hoisted(() => ({
  script: "",
  scenario: {} as Record<string, unknown>,
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
        args: [fixture.script, JSON.stringify(options.args), JSON.stringify(fixture.scenario)],
      });
    },
  };
});

/** The scripted vendor. `memory` stands in for the native conversation history
 * a resumed session keeps (the files it was pointed to). */
const VENDOR = String.raw`
const fs = require('node:fs'); const crypto = require('node:crypto'); const path = require('node:path');
const args = JSON.parse(process.argv[2]); const scenario = JSON.parse(process.argv[3]);
let input = fs.readFileSync(0);
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const step = (index, state, extra) => emit({ event: 'step_update', step_update: { step_index: index, state, ...extra } });
const tool = (index, state, name, parameters, more) => step(index, state, { step_type: 'tool', tool_name: name, tool_info: { name, parameters, ...more } });
const fence = '\x60\x60\x60';
const report = '\n\n' + fence + 'json\n{"work_report":{"state":"completed","required_inputs":[]}}\n' + fence;
const result = (response, more) => emit({ event: 'result', result: { status: 'SUCCESS', response: response && response + report, usage: { input_tokens: 1, output_tokens: 1 }, ...more } });
const at = args.indexOf('--settings');
const settings = at < 0 ? null : JSON.parse(fs.readFileSync(args[at + 1], 'utf8'));
if (scenario.recordSettingsPath && at >= 0) fs.writeFileSync(scenario.recordSettingsPath, args[at + 1]);
const deny = settings?.permissions?.deny ?? [];
// The vendor keeps only the first 192,000 bytes of a larger piped prompt.
if (input.length > 192000) input = Buffer.concat([input.subarray(0, 192000), Buffer.from('\n<truncated ' + (input.length - 192000) + ' bytes>')]);
const text = input.toString('utf8');
emit({ event: 'init', conversation_id: 'fixture', init: { model: 'gemini-fixture', tools: [] } });
step(0, 'DONE', { step_type: 'user_input' });
// What the bootstrap tells a reader: the directory once, then each numbered range.
function readListed(paths) {
  const lines = text.split('\n');
  const dirAt = lines.findIndex((line) => line.endsWith('in this directory:'));
  const listed = {};
  if (dirAt >= 0) for (const line of lines.slice(dirAt + 2)) {
    const range = /^\d+\. (instructions|task)-(\d+)\.txt(?: to (?:instructions|task)-(\d+)\.txt)? \(/.exec(line);
    if (!range) continue;
    const [, role, first, last = first] = range;
    for (let n = Number(first); n <= Number(last); n += 1)
      (listed[role] ??= []).push(path.join(lines[dirAt + 1], role + '-' + String(n).padStart(first.length, '0') + '.txt'));
  }
  return paths ?? listed;
}
function digestOf(listed) {
  return Object.fromEntries(Object.entries(listed).map(([role, files]) => {
    const bytes = Buffer.concat(files.map((file) => fs.readFileSync(file)));
    return [role, { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), tail: bytes.subarray(-48).toString('utf8') }];
  }));
}
if (scenario.kind === 'deny') {
  tool(1, 'ACTIVE', 'run_command', { CommandLine: 'ls -la' });
  if (!deny.includes('command(*)')) {
    // Arm A: the ask cannot be answered headlessly; the turn ends with nothing.
    tool(1, 'DONE', 'run_command', { CommandLine: 'ls -la' });
    result('', { denied_actions: [{ action: 'command', display_name: 'RunCommand' }] });
    process.stderr.write('jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.\n');
    process.exit(0);
  }
  tool(1, 'ERROR', 'run_command', { CommandLine: 'ls -la' }, { error: { type: 'TOOL_ERROR', message: 'permission check failed for unsandboxed "ls -la": Permission denied for unsandboxed(ls -la). Matches user-configured deny rule.' } });
  step(2, 'DONE', { step_type: 'agent_response' });
  tool(3, 'ACTIVE', 'read_file', { Path: scenario.nonceFile });
  const nonce = fs.readFileSync(scenario.nonceFile, 'utf8').trim();
  tool(3, 'DONE', 'read_file', { Path: scenario.nonceFile }, { output: '1 lines' });
  result('nonce: ' + nonce);
} else if (scenario.kind === 'large') {
  const listed = readListed();
  const seen = Object.keys(listed).length ? digestOf(listed) : { inline: { sha256: crypto.createHash('sha256').update(input).digest('hex'), tail: input.subarray(-48).toString('utf8') } };
  result(JSON.stringify(seen));
} else if (scenario.kind === 'resume') {
  if (!args.includes('--conversation')) {
    fs.writeFileSync(scenario.memory, JSON.stringify(readListed()));
    tool(1, 'ACTIVE', 'read_file', { Path: 'first-part' });
    tool(1, 'DONE', 'read_file', { Path: 'first-part' }, { output: 'partial' });
    process.exit(0); // no terminal result: the engine continues this session
  }
  result(JSON.stringify(digestOf(JSON.parse(fs.readFileSync(scenario.memory, 'utf8')))));
} else if (scenario.kind === 'summary') {
  // A summariser that answers only from what it could read.
  const listed = readListed();
  const answer = listed.task ? 'SUMMARY task=' + digestOf({ task: listed.task }).task.sha256 : 'SUMMARY inline=' + crypto.createHash('sha256').update(input).digest('hex');
  emit({ event: 'result', result: { status: 'SUCCESS', response: answer, usage: { input_tokens: 1, output_tokens: 1 } } });
} else if (scenario.kind === 'hang') {
  if (scenario.started) fs.writeFileSync(scenario.started, 'started');
  setTimeout(() => result('too late'), 60000);
}
`;

const roots: string[] = [];
afterEach(() => {
  fixture.spawns.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "cx-agy-readonly-"));
  roots.push(root);
  fixture.script = join(root, "vendor.cjs");
  writeFileSync(fixture.script, VENDOR);
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "pipe" });
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base"],
    { cwd: repo, stdio: "pipe" },
  );
  const configDir = process.env.CLAUDEXOR_CONFIG_DIR!;
  const home = join(configDir, "profiles", `agy-${root.slice(-6)}`);
  mkdirSync(home, { recursive: true });
  const profile = CredentialProfile.parse({
    profile_id: "fixture",
    display_name: "fixture",
    harness_id: "agy",
    credential_kind: "config_dir_login",
    isolation_locator: home,
  });
  writeFileSync(
    join(configDir, "config.yaml"),
    JSON.stringify({
      runtime: { transient_retry: { max_retries: 2, initial_delay_ms: 1, max_delay_ms: 2 } },
      credential_profiles: [profile],
    }),
  );
  return { root, repo, home, profile };
}

function adapter(): HarnessAdapter {
  const native = createAgyAdapter({ prepareProfileKeychain: () => undefined });
  return {
    ...native,
    async discover() {
      return HarnessManifest.parse({
        id: "agy",
        display_name: "AGY fixture",
        kind: "local_cli",
        provider_family: "google",
        capabilities: {
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
        enabled_intents: ["explain"],
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
}

async function ask(
  repo: string,
  prompt: string,
  extra: { instructions?: string; signal?: AbortSignal; onEvent?: (e: RunEvent) => void } = {},
) {
  const events: RunEvent[] = [];
  const result = await new Orchestrator({
    registry: new Map([["agy", adapter()]]),
    reviewers: [],
    quotaSnapshots: () => [],
  }).run({
    repoRoot: repo,
    mode: "ask",
    prompt,
    harnesses: ["agy"],
    review: false,
    web: "auto",
    ...(extra.instructions ? { instructions: extra.instructions } : {}),
    ...(extra.signal ? { signal: extra.signal } : {}),
    onEvent: (event) => {
      events.push(event);
      extra.onEvent?.(event);
    },
  });
  return { result, events, journal: readFileSync(join(result.runDir, "events.jsonl"), "utf8") };
}

const harnessEvents = (events: RunEvent[]) =>
  events.filter((event) => event.type === "harness.event").map((event) => event.payload);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** The JSON line the scripted vendor answered with (before its WorkReport fence). */
const seenBy = (events: RunEvent[]) =>
  JSON.parse(
    String(
      harnessEvents(events).find((event) => event["type"] === "message" && event["final"])?.[
        "text"
      ],
    ).split("\n")[0]!,
  );

describe("AGY readonly: a denied command returns to the model (#653)", () => {
  it("denies the command, keeps reading and delivers the final answer", async () => {
    const { root, repo, home } = sandbox();
    const nonceFile = join(root, "outside", "nonce.txt");
    mkdirSync(join(root, "outside"));
    writeFileSync(nonceFile, "nonce-5c1e7a\n");
    const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ["command(ls -la)"], deny: ["read_file(/secret/**)"] },
      }),
    );
    const recordSettingsPath = join(root, "settings-path.txt");
    fixture.scenario = { kind: "deny", nonceFile, recordSettingsPath };
    const out = await ask(repo, `List the workspace, then read ${nonceFile} and report its nonce.`);
    expect(fixture.spawns).toHaveLength(1);
    expect(fixture.spawns[0]!.spec.access).toBe("readonly");
    expect(out.result.lifecycle).toBe("succeeded");
    expect(readFileSync(join(out.result.runDir, "final", "answer.md"), "utf8")).toContain(
      "nonce: nonce-5c1e7a",
    );
    const refused = harnessEvents(out.events).find(
      (event) =>
        event["type"] === "tool_result" &&
        (event["tool"] as { name?: string })?.name === "run_command",
    );
    expect(refused).toMatchObject({
      tool: {
        use_id: "step-1",
        status: "error",
        target: "ls -la",
        error_summary: expect.stringContaining("deny rule"),
      },
    });
    expect(out.journal).not.toContain('"permission_denial"');
    expect(out.events.filter((event) => event.type === "route.profile.rotated")).toEqual([]);
    // Controls unchanged: the profile keeps its rules (plus the read grant); the session file is gone.
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      permissions: { allow: ["command(ls -la)", "read_file(*)"], deny: ["read_file(/secret/**)"] },
    });
    expect(existsSync(readFileSync(recordSettingsPath, "utf8"))).toBe(false);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })).toBe(
      "",
    );
  });

  it("stops a running readonly turn on cancellation and removes the session file", async () => {
    const { root, repo } = sandbox();
    const started = join(root, "started");
    const recordSettingsPath = join(root, "settings-path.txt");
    fixture.scenario = { kind: "hang", started, recordSettingsPath };
    const stop = new AbortController();
    const timer = setInterval(() => {
      if (existsSync(started)) stop.abort();
    }, 50);
    try {
      const out = await ask(repo, "Wait.", { signal: stop.signal });
      expect(stop.signal.aborted).toBe(true);
      expect(out.result.lifecycle).toBe("cancelled");
      expect(existsSync(join(out.result.runDir, "final", "answer.md"))).toBe(false);
    } finally {
      clearInterval(timer);
    }
    expect(existsSync(readFileSync(recordSettingsPath, "utf8"))).toBe(false);
  });
});

describe("AGY oversized input reaches the model whole (#653)", () => {
  const unit = 'Строка задания 🙂 with "quotes"\tand tabs\n';
  it("delivers the task and instructions byte for byte, tail included, from the run's context", async () => {
    const { repo } = sandbox();
    const tail = "TAIL-NONCE-91d2 Ω";
    const prompt = `${unit.repeat(9_000)}${tail}`;
    const instructions = `Rule: read everything.\n${unit.repeat(4_000)}`;
    fixture.scenario = { kind: "large" };
    const out = await ask(repo, prompt, { instructions });
    expect(fixture.spawns).toHaveLength(1);
    const spec = fixture.spawns[0]!.spec;
    // What the vendor could see: exactly the bytes the adapter was handed, per
    // role, past the 192,000-byte cut (the base tree shows a cut inline input).
    expect(seenBy(out.events)).toEqual({
      instructions: { sha256: sha(spec.instructions!.trim()), tail: expect.any(String) },
      task: { sha256: sha(spec.prompt), tail: expect.any(String) },
    });
    expect(spec.prompt).toContain(prompt);
    expect(spec.instructions).toContain(instructions.trim());
    expect(spec.input_file_dir).toBe(join(out.result.runDir, "context"));
    expect(Buffer.byteLength(fixture.spawns[0]!.input!)).toBeLessThan(16_384);
    expect(out.result.lifecycle).toBe("succeeded");
    expect(out.journal).toContain('"code":"agy_input_file_delivery"');
    // The files belong to the run and outlive the child.
    expect(
      readdirSync(join(out.result.runDir, "context")).filter((name) =>
        name.startsWith("agy-input-"),
      ),
    ).toHaveLength(1);
  });

  it("keeps the files readable for the resumed session of a later try", async () => {
    const { root, repo } = sandbox();
    const tail = "TAIL-AFTER-RESUME 🙂";
    const prompt = `${unit.repeat(9_000)}${tail}`;
    fixture.scenario = { kind: "resume", memory: join(root, "conversation-memory.json") };
    const out = await ask(repo, prompt);
    expect(fixture.spawns.length).toBeGreaterThanOrEqual(2);
    const second = fixture.spawns[1]!;
    expect(second.args[second.args.indexOf("--conversation") + 1]).toBe("fixture");
    expect(second.spec.input_file_dir).toBe(fixture.spawns[0]!.spec.input_file_dir);
    expect(out.result.lifecycle).toBe("succeeded");
    const seen = seenBy(out.events);
    expect(seen.task.sha256).toBe(sha(fixture.spawns[0]!.spec.prompt));
    expect(fixture.spawns[0]!.spec.prompt).toContain(tail);
  });
});

describe("AGY readonly policy preparation at the consumer (#653 review)", () => {
  it("refuses a readonly run before spawning when the profile settings cannot be read", async () => {
    const { repo, home } = sandbox();
    const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(settingsPath, "{ not json");
    fixture.scenario = { kind: "deny", nonceFile: "/nonexistent" };
    const out = await ask(repo, "Read a file and report it.");
    expect(fixture.spawns).toHaveLength(0);
    expect(out.result.lifecycle).toBe("failed");
    expect(out.journal).toContain('"code":"agy_readonly_session_policy_unavailable"');
    expect(readFileSync(settingsPath, "utf8")).toBe("{ not json");
  });

  // Review rl-20261108T203611 (Astra probe class): valid rules, and a read
  // grant that cannot be saved (ENOSPC there; a read-only directory here).
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps the denial, then the read and the answer, when the read grant cannot be saved",
    async () => {
      const { root, repo, home } = sandbox();
      const nonceFile = join(root, "outside", "nonce.txt");
      mkdirSync(join(root, "outside"));
      writeFileSync(nonceFile, "nonce-unsaved-grant\n");
      const dir = join(home, ".gemini", "antigravity-cli");
      mkdirSync(dir, { recursive: true });
      const settings = JSON.stringify({ permissions: { allow: ["command(ls -la)"], deny: [] } });
      writeFileSync(join(dir, "settings.json"), settings);
      chmodSync(dir, 0o500);
      try {
        fixture.scenario = { kind: "deny", nonceFile };
        const out = await ask(repo, `List the workspace, then read ${nonceFile} and report it.`);
        expect(fixture.spawns).toHaveLength(1);
        expect(out.result.lifecycle).toBe("succeeded");
        expect(readFileSync(join(out.result.runDir, "final", "answer.md"), "utf8")).toContain(
          "nonce: nonce-unsaved-grant",
        );
        expect(out.journal).toContain('"code":"agy_read_grant_unavailable"');
        expect(out.journal).toContain('"code":"agy_readonly_session_policy"');
        expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(settings);
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );
});

describe("AGY file delivery under a long relocated config directory (#653 review)", () => {
  // Review rl-20261108T203611 (Astra): 9,437,222 bytes under a valid relocated
  // CLAUDEXOR_CONFIG_DIR made the old per-file bootstrap 226,723 bytes.
  it.skipIf(process.platform === "win32")(
    "delivers a 9 MB task whole with a bootstrap that does not grow with it",
    async () => {
      const base = process.env.CLAUDEXOR_CONFIG_DIR!;
      const relocated = join(base, "l".repeat(200), "o".repeat(200), "n".repeat(120));
      mkdirSync(relocated, { recursive: true });
      process.env.CLAUDEXOR_CONFIG_DIR = relocated;
      const { repo } = sandbox();
      const line = `${'Строка ledger entry with "quotes"\tand tabs 🙂 '.repeat(3)}\n`;
      const tail = "TAIL-AFTER-9MB-RELOCATED Ω";
      const prompt = line.repeat(Math.ceil(9_437_222 / Buffer.byteLength(line))) + tail;
      fixture.scenario = { kind: "large" };
      const out = await ask(repo, prompt);
      expect(fixture.spawns).toHaveLength(1);
      const spec = fixture.spawns[0]!.spec;
      expect(spec.input_file_dir!.length).toBeGreaterThan(600);
      // The vendor child sees every byte of the task the adapter was handed.
      expect(seenBy(out.events)).toEqual({
        instructions: { sha256: sha(spec.instructions!.trim()), tail: expect.any(String) },
        task: { sha256: sha(spec.prompt), tail: expect.any(String) },
      });
      expect(spec.prompt).toContain(tail);
      expect(Buffer.byteLength(fixture.spawns[0]!.input!)).toBeLessThan(
        4_096 + spec.input_file_dir!.length,
      );
      expect(out.result.lifecycle).toBe("succeeded");
    },
    120_000,
  );
});

describe("AGY thread summary pass through the enclosing run's context (#653 review)", () => {
  const turns = Array.from({ length: 40 }, (_, i) => ({
    id: `t${i}`,
    prompt: `${"Вопрос о плане работ ".repeat(200)}${i}`,
    outputText: `${"answer with decisions ".repeat(200)}${i}`,
  }));
  function summaryParams(profile: CredentialProfile, cwd: string, inputFileDir?: string) {
    return {
      adapter: adapter(),
      turns,
      cwd,
      env: {},
      credentialProfile: profile,
      authPreference: "auto" as const,
      envInheritance: "mirror_native" as const,
      ...(inputFileDir ? { inputFileDir } : {}),
    };
  }

  it("summarises a prefix too large for stdin from files and answers only from them", async () => {
    const { root, repo, profile } = sandbox();
    const context = join(root, "run", "context");
    fixture.scenario = { kind: "summary" };
    const summary = await summarizeThreadPrefix(summaryParams(profile, repo, context));
    expect(fixture.spawns).toHaveLength(1);
    const spec = fixture.spawns[0]!.spec;
    expect(Buffer.byteLength(spec.prompt)).toBeGreaterThan(160_000);
    expect(spec.input_file_dir).toBe(context);
    expect(spec.prompt).toContain(
      "no tool calls except to read this conversation if it was delivered to you as files",
    );
    expect(Buffer.byteLength(fixture.spawns[0]!.input!)).toBeLessThan(4_096);
    expect(summary).toBe(`SUMMARY task=${sha(spec.prompt)}`);
    expect(readdirSync(context).filter((name) => name.startsWith("agy-input-"))).toHaveLength(1);
  });

  it("keeps the mechanical fallback without a run directory, sending nothing", async () => {
    const { repo, profile } = sandbox();
    fixture.scenario = { kind: "summary" };
    expect(await summarizeThreadPrefix(summaryParams(profile, repo))).toBeNull();
    expect(fixture.spawns).toHaveLength(0);
  });
});
