/** Ordinary work of an Agent run on agy's workspace_write path, at the
 * consumer boundary: Orchestrator -> AGY adapter -> CLI run loop -> a scripted
 * vendor child in a synthetic repository, in place or in the run's own shared
 * Git clone. Only the executable and the version observation are replaced.
 * The script models the CLI behavior agy documents (sandbox, permissions,
 * settings and headless pages): a session file merges into the profile's
 * settings key by key, replacing each list it names; a `command` allow rule
 * runs its command without asking; otherwise, with `enableTerminalSandbox` on,
 * `proceed-in-sandbox` runs a sandboxed command without asking, and the
 * sandbox can read the paths `read_file` rules allow; any other command asks,
 * and a headless run soft-denies it. It shows what the engine sends and does on
 * this path, never that agy enforces its sandbox. */
import { createHash } from "node:crypto";
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
import { createAgyAdapter } from "../../harness-agy/src/index.js";
import { Orchestrator } from "./orchestrator.js";

const fixture = vi.hoisted(() => ({
  script: "",
  version: "1.5.14",
  scenario: {} as Record<string, unknown>,
  spawns: [] as CliRunLoopOptions[],
}));
vi.mock("@claudexor/core", async (original) => {
  const actual = await original<typeof import("@claudexor/core")>();
  return {
    ...actual,
    observeHarnessProgram: async () => ({
      selection: { version: fixture.version },
      program: null,
      key: "fixture",
    }),
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

const VENDOR = String.raw`
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const args = JSON.parse(process.argv[2]); const scenario = JSON.parse(process.argv[3]);
const input = fs.readFileSync(0, 'utf8');
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const tool = (index, state, name, parameters, more) => emit({ event: 'step_update', step_update: { step_index: index, state, step_type: 'tool', tool_name: name, tool_info: { name, parameters, ...more } } });
const fence = '\x60\x60\x60';
const report = '\n\n' + fence + 'json\n{"work_report":{"state":"completed","required_inputs":[]}}\n' + fence;
const at = args.indexOf('--settings');
const session = at < 0 ? null : JSON.parse(fs.readFileSync(args[at + 1], 'utf8'));
const profilePath = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'settings.json');
const profile = fs.existsSync(profilePath) ? JSON.parse(fs.readFileSync(profilePath, 'utf8')) : {};
// Key by key; a list the session names replaces the profile's.
const effective = { ...profile, ...(session ?? {}), permissions: { ...(profile.permissions ?? {}), ...(session?.permissions ?? {}) } };
const allow = effective.permissions.allow ?? [];
// On Windows agy strips the drive letter and turns backslashes into slashes first.
const norm = (p) => p.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/');
const readable = (target) => allow.includes('read_file(*)') || allow.some((rule) => rule.startsWith('read_file(') && norm(target).startsWith(norm(rule.slice(10, -1))));
const sandboxed = effective.enableTerminalSandbox === true && effective.toolPermission === 'proceed-in-sandbox';
const softDeny = (permission) => {
  emit({ event: 'result', result: { status: 'SUCCESS', response: '', usage: { input_tokens: 1, output_tokens: 1 } } });
  process.stderr.write('jetski: no output produced — a tool required the "' + permission + '" permission that headless mode cannot prompt for, so it was auto-denied.\n');
  process.exit(0);
};
emit({ event: 'init', conversation_id: 'fixture', init: { model: 'gemini-fixture', tools: [] } });
const seen = { mode: args[args.indexOf('--mode') + 1], session };
if (scenario.large) {
  // The bootstrap names the directory on the line after this one.
  const lines = input.split('\n');
  const dir = lines[lines.findIndex((line) => line.endsWith('in this directory:')) + 1];
  if (!readable(dir)) softDeny('read_file');
  const bytes = Buffer.concat(fs.readdirSync(dir).filter((name) => name.startsWith('task-')).sort().map((name) => fs.readFileSync(path.join(dir, name))));
  seen.task = crypto.createHash('sha256').update(bytes).digest('hex');
}
if (scenario.git) {
  // A sandboxed read-only Git command in the run's shared clone also reads the
  // project's object store through its alternates, outside the workspace:
  // visible to the sandbox only through a read rule.
  tool(3, 'ACTIVE', 'run_command', { CommandLine: 'git status --porcelain' });
  const alternates = path.join(process.cwd(), '.git', 'objects', 'info', 'alternates');
  const stores = fs.existsSync(alternates) ? fs.readFileSync(alternates, 'utf8').split('\n').filter(Boolean) : [];
  seen.shared = stores.length > 0 && stores.every((store) => !path.resolve(store).startsWith(process.cwd()));
  if (!sandboxed) softDeny('command');
  seen.git = stores.every(readable) ? execFileSync('git', ['status', '--porcelain'], { cwd: process.cwd(), encoding: 'utf8' }) : 'not visible';
  tool(3, 'DONE', 'run_command', { CommandLine: 'git status --porcelain' }, { output: 'status' });
}
// An ordinary edit inside the workspace: accept-edits approves it.
tool(1, 'ACTIVE', 'write_to_file', { TargetFile: 'notes.md' });
fs.writeFileSync(path.join(process.cwd(), 'notes.md'), 'edited by the fixture\n');
tool(1, 'DONE', 'write_to_file', { TargetFile: 'notes.md' }, { output: 'wrote notes.md' });
if (scenario.command) {
  // An ordinary build step inside the workspace. An allow rule naming it runs it
  // without asking (on a personal account also outside the sandbox); otherwise
  // only the sandbox with proceed-in-sandbox does; anything else asks.
  const command = 'npm run build';
  tool(2, 'ACTIVE', 'run_command', { CommandLine: command });
  const listed = (list) => (effective.permissions[list] ?? []).some((rule) => rule === 'command(*)' || rule === 'command(' + command + ')');
  if (listed('deny') || listed('ask')) softDeny('command');
  if (listed('allow')) seen.ran = 'allow rule';
  else if (sandboxed) seen.ran = 'sandbox';
  else softDeny('command');
  fs.mkdirSync(path.join(process.cwd(), 'build'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'build', 'output.txt'), 'built\n');
  tool(2, 'DONE', 'run_command', { CommandLine: command }, { output: 'built' });
}
emit({ event: 'result', result: { status: 'SUCCESS', response: JSON.stringify(seen) + report, usage: { input_tokens: 1, output_tokens: 1 } } });
`;

const TERMINAL = { enableTerminalSandbox: true, toolPermission: "proceed-in-sandbox" };
const GRANT = "read_file(*)";
const roots: string[] = [];
afterEach(() => {
  fixture.spawns.length = 0;
  fixture.version = "1.5.14";
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

function sandbox(profileSettings?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "cx-agy-workspace-write-"));
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
  const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
  if (profileSettings !== undefined) {
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(profileSettings));
  }
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
      runtime: { transient_retry: { max_retries: 0, initial_delay_ms: 1, max_delay_ms: 2 } },
      credential_profiles: [profile],
    }),
  );
  return { repo, settingsPath };
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
          implement: true,
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
        enabled_intents: ["implement"],
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

async function agent(
  repo: string,
  prompt: string,
  scenario: Record<string, unknown>,
  inPlace = true,
) {
  fixture.scenario = scenario;
  const events: RunEvent[] = [];
  const result = await new Orchestrator({
    registry: new Map([["agy", adapter()]]),
    reviewers: [],
    quotaSnapshots: () => [],
  }).run({
    repoRoot: repo,
    mode: "agent",
    ...(inPlace ? { inPlace: true } : {}),
    prompt,
    harnesses: ["agy"],
    review: false,
    web: "auto",
    onEvent: (event) => events.push(event),
  });
  const final = (name: string) => join(result.runDir, "final", name);
  const terminal = events.find((event) =>
    ["run.failed", "run.completed", "run.blocked"].includes(event.type),
  );
  return {
    result,
    journal: readFileSync(join(result.runDir, "events.jsonl"), "utf8"),
    resumable: terminal?.payload["resumable"],
    seen: existsSync(final("answer.md"))
      ? (JSON.parse(readFileSync(final("answer.md"), "utf8").split("\n")[0]!) as Record<
          string,
          unknown
        >)
      : null,
    patch: existsSync(final("patch.diff")) ? readFileSync(final("patch.diff"), "utf8") : null,
  };
}

const changed = (repo: string) =>
  execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: repo,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .sort();
const savedProfile = (settingsPath: string): unknown =>
  JSON.parse(readFileSync(settingsPath, "utf8"));

describe("AGY workspace_write: ordinary work inside the workspace", () => {
  it("edits a file and runs a sandboxed build step in one headless turn", async () => {
    const { repo, settingsPath } = sandbox();
    const out = await agent(repo, "Add notes.md, then build.", { command: true });
    expect(fixture.spawns).toHaveLength(1);
    expect(fixture.spawns[0]!.spec.access).toBe("workspace_write");
    expect(out.result.lifecycle).toBe("succeeded");
    // The command ran because of the sandbox request, not because of an allow rule.
    expect(out.seen).toEqual({ mode: "accept-edits", session: TERMINAL, ran: "sandbox" });
    expect(readFileSync(join(repo, "notes.md"), "utf8")).toBe("edited by the fixture\n");
    expect(readFileSync(join(repo, "build", "output.txt"), "utf8")).toBe("built\n");
    expect(changed(repo)).toEqual(["?? build/output.txt", "?? notes.md"]);
    expect(out.journal).toContain('"code":"agy_workspace_write_session_policy"');
    // The profile gains the read grant every agy run keeps, and nothing else.
    expect(savedProfile(settingsPath)).toEqual({ permissions: { allow: [GRANT] } });
    expect(out.journal).not.toContain('"permission_denial"');
  });

  it("runs Git through the read grant in the run's own shared clone", async () => {
    const { repo } = sandbox();
    const out = await agent(repo, "Check the status, then add notes.md.", { git: true }, false);
    expect(fixture.spawns).toHaveLength(1);
    expect(fixture.spawns[0]!.spec.cwd).not.toBe(repo);
    expect(out.result.lifecycle).toBe("succeeded");
    expect(out.seen).toMatchObject({ mode: "accept-edits", session: TERMINAL, shared: true });
    expect(out.seen!["git"]).toBe("");
    expect(out.patch).toContain("edited by the fixture");
    expect(changed(repo)).toEqual([]);
  });

  it("keeps a profile's saved request-review: the edit lands, the command still asks", async () => {
    const saved = { toolPermission: "request-review" };
    const { repo, settingsPath } = sandbox(saved);
    const out = await agent(repo, "Add notes.md, then build.", { command: true });
    expect(fixture.spawns[0]!.args).not.toContain("--settings");
    expect(out.result.lifecycle).toBe("failed");
    expect(out.resumable).toMatchObject({ cause: "permission_denied" });
    expect(out.journal).toContain('"code":"agy_workspace_write_terminal_kept"');
    expect(out.journal).toContain(
      '"permission_denial":{"permission":"command","source":"agy_native_stderr"}',
    );
    expect(existsSync(join(repo, "build"))).toBe(false);
    expect(savedProfile(settingsPath)).toEqual({ ...saved, permissions: { allow: [GRANT] } });
  });

  it("leaves a command the profile allows in force and its rules unchanged", async () => {
    const saved = { permissions: { allow: ["command(npm run build)"] } };
    const { repo, settingsPath } = sandbox(saved);
    const out = await agent(repo, "Add notes.md, then build.", { command: true });
    expect(out.result.lifecycle).toBe("succeeded");
    // The session names no list, so the profile's own rule decides, as before the run.
    expect(out.seen).toEqual({ mode: "accept-edits", session: TERMINAL, ran: "allow rule" });
    expect(savedProfile(settingsPath)).toEqual({
      permissions: { allow: ["command(npm run build)", GRANT] },
    });
    const policy = out.journal
      .split("\n")
      .find((line) => line.includes('"code":"agy_workspace_write_session_policy"'));
    expect(policy).toContain("on a personal account also outside the sandbox");
  });

  it("refuses a strict profile before the vendor starts where accept-edits might loosen it", async () => {
    fixture.version = "1.5.6";
    const saved = { toolPermission: "strict" };
    const { repo, settingsPath } = sandbox(saved);
    const out = await agent(repo, "Add notes.md.", {});
    expect(fixture.spawns).toHaveLength(0);
    expect(out.result.lifecycle).toBe("failed");
    expect(out.journal).toContain('"code":"agy_workspace_write_strict_unverified"');
    expect(changed(repo)).toEqual([]);
    // Refused before anything is written, the read grant included.
    expect(savedProfile(settingsPath)).toEqual(saved);
  });

  it("runs a short edit-only task on an older agy without session settings", async () => {
    fixture.version = "1.5.7";
    const { repo, settingsPath } = sandbox();
    const out = await agent(repo, "Add notes.md.", {});
    expect(fixture.spawns).toHaveLength(1);
    expect(fixture.spawns[0]!.args).not.toContain("--settings");
    expect(out.result.lifecycle).toBe("succeeded");
    expect(out.seen).toEqual({ mode: "accept-edits", session: null });
    expect(changed(repo)).toEqual(["?? notes.md"]);
    expect(out.journal).toContain('"code":"agy_workspace_write_version_unsupported"');
    expect(savedProfile(settingsPath)).toEqual({ permissions: { allow: [GRANT] } });
  });

  it("reads oversized input whole through the read grant; the session file names no list", async () => {
    const lists = { allow: ["command(git status)"], deny: ["command(sudo)"], ask: ["mcp(*)"] };
    const { repo, settingsPath } = sandbox({ permissions: lists });
    const prompt = `${"Implement the ledger line.\n".repeat(6_000)}TAIL-LEDGER`;
    const out = await agent(repo, prompt, { large: true });
    expect(fixture.spawns).toHaveLength(1);
    const spec = fixture.spawns[0]!.spec;
    expect(out.result.lifecycle).toBe("succeeded");
    expect(out.seen!["session"]).toEqual(TERMINAL);
    expect(out.seen!["task"]).toBe(createHash("sha256").update(spec.prompt).digest("hex"));
    expect(out.journal).toContain('"code":"agy_input_file_delivery"');
    expect(savedProfile(settingsPath)).toEqual({
      permissions: { ...lists, allow: [...lists.allow, GRANT] },
    });
  });
});
