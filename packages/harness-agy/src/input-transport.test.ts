import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessRunSpec, type CredentialProfile, type HarnessEvent } from "@claudexor/schema";
import type { CliRunLoopOptions, SpawnOptions } from "@claudexor/core";
import { claudexorOwnedRoot } from "@claudexor/util";
import { createAgyAdapter } from "./index.js";
import { agySettingsPath } from "./read-grant.js";

const observed = vi.hoisted(() => ({
  version: "1.1.13",
  /** What the next observations answer, one each, before `version` again. */
  sequence: [] as Array<string | null>,
  options: [] as CliRunLoopOptions[],
  captures: [] as Array<SpawnOptions | undefined>,
  gates: [] as Array<{ environment?: NodeJS.ProcessEnv; cwd?: string } | undefined>,
}));
vi.mock("@claudexor/core", async (original) => {
  const actual = await original<typeof import("@claudexor/core")>();
  return {
    ...actual,
    // The run's gate asks the core's observation with the run's own environment and directory.
    observeHarnessProgram: async (
      _program: unknown,
      _patch: unknown,
      _bin: unknown,
      options?: { environment?: NodeJS.ProcessEnv; cwd?: string },
    ) => {
      observed.gates.push(options);
      const version = observed.sequence.length > 0 ? observed.sequence.shift()! : observed.version;
      // The core keys an observation by file identity and version.
      return { selection: { version }, program: null, key: `fixture:${version}` };
    },
    resolveSelectedProgramAsync: async (_program: unknown, options?: SpawnOptions) => {
      observed.captures.push(options);
      return {
        path: "/fixture/agy",
        realPath: "/fixture/agy",
        version: observed.version,
        versionOutput: observed.version,
        overrideEnv: null,
        overrideValue: null,
      };
    },
    runCliHarness: (options: CliRunLoopOptions) => {
      observed.options.push(options);
      return actual.runCliHarness({
        ...options,
        bin: process.execPath,
        args: [
          "-e",
          `
      const fs = require('node:fs'); const crypto = require('node:crypto');
      const input = fs.readFileSync(0); const args = JSON.parse(process.argv[1]);
      // Like the vendor, keep only the first 192,000 bytes of piped input.
      const seen = input.length > 192000 ? input.subarray(0, 192000) : input;
      // Follow the bootstrap like a reader would: the directory, then each range in order.
      const lines = seen.toString('utf8').split('\\n');
      const dirAt = lines.findIndex((line) => line.endsWith('in this directory:'));
      const listed = {};
      if (dirAt >= 0) for (const line of lines.slice(dirAt + 2)) {
        const range = /^\\d+\\. (instructions|task)-(\\d+)\\.txt(?: to (?:instructions|task)-(\\d+)\\.txt)? \\(/.exec(line);
        if (!range) continue;
        const [, role, first, last = first] = range;
        for (let n = Number(first); n <= Number(last); n += 1)
          (listed[role] ??= []).push(require('node:path').join(lines[dirAt + 1], role + '-' + String(n).padStart(first.length, '0') + '.txt'));
      }
      const files = Object.fromEntries(Object.entries(listed).map(([role, paths]) => {
        const bytes = Buffer.concat(paths.map((path) => fs.readFileSync(path)));
        return [role, { bytes: bytes.length, hash: crypto.createHash('sha256').update(bytes).digest('hex') }];
      }));
      // The session settings exist while the child runs.
      const at = args.indexOf('--settings');
      const settings = at < 0 ? null : JSON.parse(fs.readFileSync(args[at + 1], 'utf8'));
      console.log(JSON.stringify({event:'init', conversation_id:'fixture', init:{
        model:'gemini-fixture', cwd:process.cwd(), tools:[], permission_mode:'plan'
      }}));
      console.log(JSON.stringify({event:'result', result:{status:'SUCCESS', response:JSON.stringify({
        bytes:input.length, hash:crypto.createHash('sha256').update(input).digest('hex'), args,
        files, settings
      }), usage:{input_tokens:1, output_tokens:1, cache_read_tokens:0}}}));
    `,
          JSON.stringify(options.args),
        ],
      });
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  observed.version = "1.1.13";
  observed.sequence.length = 0;
  observed.options.length = 0;
  observed.captures.length = 0;
  observed.gates.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)
function spec(
  prompt: string,
  instructions?: string,
  access: HarnessRunSpec["access"] = "full",
  inputFileDir: string | null = null,
): HarnessRunSpec {
  const parent = join(claudexorOwnedRoot(), "profiles");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "agy-input-"));
  roots.push(root);
  const profile: CredentialProfile = {
    profile_id: "fixture",
    harness_id: "agy",
    display_name: "Fixture",
    credential_kind: "config_dir_login",
    isolation_locator: root,
    secret_ref: null,
    enabled: true,
    created_at: null,
  };
  return HarnessRunSpec.parse({
    session_id: "agy-input",
    intent: "implement",
    cwd: root,
    prompt,
    instructions,
    access,
    model_hint: "gemini-fixture",
    resume_session_id: "previous-conversation",
    credential_profile: profile,
    input_file_dir: inputFileDir,
  });
}
const answerOf = (events: HarnessEvent[]) =>
  JSON.parse(events.find((event) => event.type === "message" && event.final)!.text!) as {
    bytes: number;
    hash: string;
    args: string[];
    files: Record<string, { bytes: number; hash: string }>;
    settings: unknown;
  };
async function collect(input: HarnessRunSpec): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of createAgyAdapter({ prepareProfileKeychain: () => undefined }).run(
    input,
  )) {
    events.push(event);
  }
  return events;
}

describe("AGY Windows console policy", () => {
  it("keeps the version probe console-less, like the run", async () => {
    const manifest = await createAgyAdapter({ prepareProfileKeychain: () => undefined }).discover();
    expect(manifest.version).toBe("1.1.13");
    expect(observed.captures).toEqual([expect.objectContaining({ windowsConsole: "none" })]);
  });
});

describe("AGY doctor minimum CLI versions (#653)", () => {
  it("accepts a newer installed program without comparing it with the fixture stamp", async () => {
    observed.version = "1.5.8";
    const report = await createAgyAdapter({ prepareProfileKeychain: () => undefined }).doctor(
      {} as never,
    );
    expect(report.checks.find((check) => check.id === "installed")).toMatchObject({
      status: "pass",
    });
    expect(report.checks.find((check) => check.id === "readonly_min_version")).toMatchObject({
      status: "pass",
    });
    expect(report.checks.find((check) => check.id === "workspace_write_min_version")).toMatchObject(
      {
        status: "pass",
      },
    );
    expect(report.reasons.join(" ")).not.toContain("differs from");
    expect(report.checks.some((check) => check.id === "version_pin")).toBe(false);
  });
  it("reports workspace_write_min_version fail on 1.5.3 while readonly passes", async () => {
    observed.version = "1.5.3";
    const report = await createAgyAdapter({ prepareProfileKeychain: () => undefined }).doctor(
      {} as never,
    );
    expect(report.checks.find((c) => c.id === "readonly_min_version")).toMatchObject({
      status: "pass",
    });
    const ww = report.checks.find((c) => c.id === "workspace_write_min_version");
    expect(ww).toMatchObject({ status: "fail" });
    expect(report.reasons).toContain(ww?.detail);
  });
  it("states that readonly runs on the probed 1.1.13 stop for an update", async () => {
    const report = await createAgyAdapter({ prepareProfileKeychain: () => undefined }).doctor(
      {} as Parameters<ReturnType<typeof createAgyAdapter>["doctor"]>[0],
    );
    const check = report.checks.find((c) => c.id === "readonly_min_version");
    expect(check).toMatchObject({ status: "fail" });
    expect(check?.detail).toContain("installed 1.1.13 stops readonly runs before the model");
    expect(report.reasons).toContain(check?.detail);
    const ww = report.checks.find((c) => c.id === "workspace_write_min_version");
    expect(ww).toMatchObject({ status: "fail" });
    expect(report.reasons).toContain(ww?.detail);
    // Fixture stamps do not restrict installed vendor versions.
    expect(report.checks.some((c) => c.id === "version_pin")).toBe(false);
  });
});

describe("AGY native raw stdin selection", () => {
  it.each(["short", "near-limit", "whitespace"])(
    "delivers %s prompt and instructions without a print flag",
    async (size) => {
      const unit = '  Русский 🙂 "quotes"\nline\t end  ';
      // Near the inline bound: still byte-identical stdin (prompt + instructions ~120 KiB).
      const prompt =
        size === "near-limit" ? unit.repeat(1_500) : size === "whitespace" ? " \n\t " : unit;
      const instructions = size === "whitespace" ? undefined : `instructions\n${prompt}\n`;
      const input = spec(prompt, instructions);
      const expected = instructions?.trim()
        ? `[SYSTEM INSTRUCTIONS]\n${instructions.trim()}\n[END SYSTEM INSTRUCTIONS]\n\n${prompt}`
        : prompt;
      const events = await collect(input);
      expect(observed.options).toHaveLength(1);
      const options = observed.options[0]!;
      expect(options.input).toBe(expected);
      expect(options.session).toBeUndefined();
      // An openable CONIN$ selects agy's interactive mode: runs stay console-less on Windows.
      expect(options.windowsConsole).toBe("none");
      for (const flag of ["-p", "--print", "--prompt"]) expect(options.args).not.toContain(flag);
      expect(options.args).not.toContain(expected);
      expect(options.args[options.args.indexOf("--conversation") + 1]).toBe(
        "previous-conversation",
      );
      expect(options.args).toContain("--dangerously-skip-permissions");
      expect(Buffer.byteLength(expected)).toBeLessThan(128 * 1024);
      expect(answerOf(events)).toEqual({
        bytes: Buffer.byteLength(expected),
        hash: createHash("sha256").update(expected).digest("hex"),
        args: options.args,
        files: {},
        settings: null,
      });
      expect(events.some((event) => event.type === "error")).toBe(false);
    },
  );

  it("delivers oversized input whole through run-owned files the child can read", async () => {
    const run = mkdtempSync(join(claudexorOwnedRoot(), "agy-run-"));
    roots.push(run);
    const dir = join(run, "context");
    const unit = '  Русский 🙂 "quotes"\nline\t end  ';
    const prompt = `${unit.repeat(9_000)}TAIL-NONCE-after-192000-bytes 🙂`;
    const instructions = `instructions\n${unit.repeat(200)}\n`;
    expect(Buffer.byteLength(prompt)).toBeGreaterThan(192_000);
    const events = await collect(spec(prompt, instructions, "readonly", dir));
    expect(observed.options).toHaveLength(1);
    const stdin = observed.options[0]!.input!;
    expect(stdin).not.toContain("TAIL-NONCE");
    expect(Buffer.byteLength(stdin)).toBeLessThan(16_384);
    expect(stdin).toContain("ENGINE NOTE (read-only Antigravity run)");
    const answer = answerOf(events);
    // What the child could read is exactly the caller's bytes, per role.
    expect(answer.files).toEqual({
      instructions: {
        bytes: Buffer.byteLength(instructions.trim()),
        hash: createHash("sha256").update(instructions.trim()).digest("hex"),
      },
      task: {
        bytes: Buffer.byteLength(prompt),
        hash: createHash("sha256").update(prompt).digest("hex"),
      },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "status",
        payload: expect.objectContaining({ code: "agy_input_file_delivery" }),
      }),
    );
    // The files stay with the run after the child ends: a resumed conversation may read them again.
    expect(readdirSync(dir)).toEqual([expect.stringMatching(/^agy-input-[0-9a-f]{64}$/)]);
  });

  it("refuses oversized input before spawning when no run-owned directory exists", async () => {
    const prompt = "p".repeat(128 * 1024 + 1);
    const events = await collect(spec(prompt, undefined, "full", null));
    expect(observed.options).toHaveLength(0);
    expect(events.map((event) => event.type)).toEqual(["error", "completed"]);
    expect(events[0]).toMatchObject({
      payload: { code: "agy_input_file_delivery_unavailable" },
      error: expect.stringContaining("nothing was sent"),
    });
  });

  it("denies commands and writes for a readonly session while keeping profile rules", async () => {
    const input = spec("Review the attached screenshot.", "caller instructions", "readonly");
    const settingsPath = agySettingsPath(input.credential_profile!.isolation_locator!);
    mkdirSync(dirname(settingsPath), { recursive: true });
    const profileSettings = {
      toolPermission: "request-review",
      permissions: {
        allow: ["command(git status)"],
        deny: ["read_file(/secret/**)"],
        ask: ["mcp(*)"],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(profileSettings));
    const events = await collect(input);
    const options = observed.options[0]!;
    expect(
      options.args.slice(options.args.indexOf("--mode"), options.args.indexOf("--mode") + 2),
    ).toEqual(["--mode", "plan"]);
    expect(options.args).not.toContain("--dangerously-skip-permissions");
    const settingsFile = options.args[options.args.indexOf("--settings") + 1]!;
    expect(answerOf(events).settings).toEqual({
      permissions: {
        allow: ["command(git status)", "read_file(*)"],
        deny: ["read_file(/secret/**)", "command(*)", "write_file(*)"],
        ask: ["mcp(*)"],
      },
    });
    // Session only: the profile keeps its own rules (plus the read grant) and the file is gone.
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      ...profileSettings,
      permissions: {
        ...profileSettings.permissions,
        allow: ["command(git status)", "read_file(*)"],
      },
    });
    expect(existsSync(settingsFile)).toBe(false);
    expect(options.input).toMatch(
      /^\[SYSTEM INSTRUCTIONS\]\ncaller instructions\n\nENGINE NOTE \(read-only Antigravity run\): Your file tools may read files and folders outside the workspace as well as inside it, except where the profile's own rules deny or ask about a read or its strict mode prompts for one\. Shell commands and file writes are denied in this run: such a call returns a permission error instead of running, .+\n\[END SYSTEM INSTRUCTIONS\]\n\nReview the attached screenshot\.$/,
    );
    const codes = events.map((event) => event.payload?.["code"]);
    expect(codes).toContain("agy_readonly_access_note");
    expect(codes).toContain("agy_readonly_session_policy");
    expect(codes).not.toContain("agy_read_grant_unavailable");
  });

  it("refuses a readonly run whose settings cannot be read, before spawning", async () => {
    const input = spec("Review.", undefined, "readonly");
    const settingsPath = agySettingsPath(input.credential_profile!.isolation_locator!);
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, "{ not json");
    const events = await collect(input);
    // Unknown is not empty: no overlay that could replace rules agy may still
    // read, and no run without the denial the readonly note promises.
    expect(observed.options).toHaveLength(0);
    expect(events.map((event) => event.type)).toEqual(["error", "completed"]);
    expect(events[0]).toMatchObject({
      payload: { code: "agy_readonly_session_policy_unavailable" },
      error: expect.stringMatching(/nothing was sent: settings\.json is not valid JSON$/),
    });
    expect(readFileSync(settingsPath, "utf8")).toBe("{ not json");
  });

  // Review rl-20261108T203611 (Astra): with valid rules and a grant that
  // cannot be saved (ENOSPC there; here a read-only settings directory), the
  // run used to start without the denials.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps the readonly denial and the file delivery when the read grant cannot be saved",
    async () => {
      const run = mkdtempSync(join(claudexorOwnedRoot(), "agy-run-"));
      roots.push(run);
      const prompt = `${"plain ledger line\n".repeat(9_000)}TAIL-GRANT-UNSAVED`;
      const input = spec(prompt, undefined, "readonly", join(run, "context"));
      const settingsPath = agySettingsPath(input.credential_profile!.isolation_locator!);
      const profileSettings = JSON.stringify({
        permissions: { allow: ["command(git status)"], deny: ["read_file(/secret/**)"] },
      });
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, profileSettings);
      chmodSync(dirname(settingsPath), 0o500);
      try {
        const events = await collect(input);
        expect(observed.options).toHaveLength(1);
        expect(observed.options[0]!.args).toContain("--settings");
        const answer = answerOf(events);
        expect(answer.settings).toEqual({
          permissions: {
            allow: ["command(git status)", "read_file(*)"],
            deny: ["read_file(/secret/**)", "command(*)", "write_file(*)"],
            ask: [],
          },
        });
        expect(answer.files.task).toEqual({
          bytes: Buffer.byteLength(prompt),
          hash: createHash("sha256").update(prompt).digest("hex"),
        });
        const grant = events.find(
          (event) => event.payload?.["code"] === "agy_read_grant_unavailable",
        );
        expect(grant?.text).toContain("only this readonly run's session settings grant reads");
        expect(events.map((event) => event.payload?.["code"])).toContain(
          "agy_readonly_session_policy",
        );
        expect(readFileSync(settingsPath, "utf8")).toBe(profileSettings);
      } finally {
        chmodSync(dirname(settingsPath), 0o700);
      }
    },
  );

  const TERMINAL = { enableTerminalSandbox: true, toolPermission: "proceed-in-sandbox" };
  const GRANT = "read_file(*)";
  function saveProfile(input: HarnessRunSpec, saved: unknown): string {
    const settingsPath = agySettingsPath(input.credential_profile!.isolation_locator!);
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, typeof saved === "string" ? saved : JSON.stringify(saved));
    return settingsPath;
  }
  const codesOf = (events: HarnessEvent[]) => events.map((event) => event.payload?.["code"]);
  const profileOf = (input: HarnessRunSpec): unknown =>
    JSON.parse(readFileSync(agySettingsPath(input.credential_profile!.isolation_locator!), "utf8"));
  const runDir = () => {
    const run = mkdtempSync(join(claudexorOwnedRoot(), "agy-run-"));
    roots.push(run);
    return join(run, "context");
  };
  const oversized = `${"plain ledger line\n".repeat(9_000)}TAIL-WORKSPACE-WRITE`;

  it("requests the terminal sandbox via --settings on agy 1.5.8 or newer, naming no permission list", async () => {
    observed.version = "1.5.14";
    const input = spec("Fix it.", "caller instructions", "workspace_write");
    const saved = JSON.stringify({
      theme: "dark",
      permissions: {
        allow: ["command(git status)"],
        deny: ["command(rm -rf /)"],
        ask: ["mcp(*)"],
      },
    });
    const settingsPath = saveProfile(input, saved);
    const events = await collect(input);
    const options = observed.options[0]!;
    expect(options.input).toBe(
      "[SYSTEM INSTRUCTIONS]\ncaller instructions\n[END SYSTEM INSTRUCTIONS]\n\nFix it.",
    );
    expect(
      options.args.slice(options.args.indexOf("--mode"), options.args.indexOf("--mode") + 2),
    ).toEqual(["--mode", "accept-edits"]);
    expect(options.args).not.toContain("--dangerously-skip-permissions");
    const settingsFile = options.args[options.args.indexOf("--settings") + 1]!;
    // Only the two terminal keys: the profile's lists stay the ones agy reads itself.
    expect(answerOf(events).settings).toEqual(TERMINAL);
    // Like every agy run, the profile keeps its rules and gains only the read grant.
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      theme: "dark",
      permissions: {
        allow: ["command(git status)", GRANT],
        deny: ["command(rm -rf /)"],
        ask: ["mcp(*)"],
      },
    });
    expect(existsSync(settingsFile)).toBe(false);
    const codes = codesOf(events);
    expect(codes).toContain("agy_workspace_write_session_policy");
    expect(codes).not.toContain("agy_read_grant_unavailable");
    expect(codes).not.toContain("agy_readonly_access_note");
    expect(codes).not.toContain("agy_readonly_session_policy");
    expect(
      events.find((event) => event.payload?.["code"] === "agy_workspace_write_session_policy")
        ?.text,
    ).toContain("request agy's terminal sandbox");
  });

  it("keeps the read grant of every agy run, also for a profile without settings", async () => {
    observed.version = "1.5.14";
    const input = spec(oversized, undefined, "workspace_write", runDir());
    const events = await collect(input);
    expect(profileOf(input)).toEqual({ permissions: { allow: [GRANT] } });
    const answer = answerOf(events);
    // The input is read through that grant; the session file names no list.
    expect(answer.files.task?.bytes).toBe(Buffer.byteLength(oversized));
    expect(answer.settings).toEqual(TERMINAL);
    expect(codesOf(events)).not.toContain("agy_read_grant_unavailable");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "carries a read grant it could not save in the session file on agy 1.5.7 or newer",
    async () => {
      const dir = runDir();
      const input = spec("Fix it.", undefined, "workspace_write", dir);
      const lists = { allow: ["command(git status)"], deny: ["command(sudo)"], ask: ["mcp(*)"] };
      const saved = JSON.stringify({ toolPermission: "request-review", permissions: lists });
      const settingsPath = saveProfile(input, saved);
      chmodSync(dirname(settingsPath), 0o500);
      try {
        // The lists as read with the grant; no other rule, and the saved choice kept.
        const carried = { ...lists, allow: [...lists.allow, GRANT] };
        for (const version of ["1.5.7", "1.5.14"]) {
          observed.version = version;
          observed.options.length = 0;
          const small = await collect(input);
          expect(observed.options).toHaveLength(1);
          expect(answerOf(small).settings).toEqual({ permissions: carried });
          expect(
            small.find((event) => event.payload?.["code"] === "agy_read_grant_unavailable")?.text,
          ).toContain("only this workspace_write run's session settings grant reads");
          observed.options.length = 0;
          const large = await collect({ ...input, prompt: oversized });
          expect(observed.options).toHaveLength(1);
          const answer = answerOf(large);
          expect(answer.settings).toEqual({ permissions: carried });
          expect(answer.files.task?.bytes).toBe(Buffer.byteLength(oversized));
          expect(codesOf(large)).not.toContain("agy_workspace_write_session_policy");
        }
        expect(readFileSync(settingsPath, "utf8")).toBe(saved);
      } finally {
        chmodSync(dirname(settingsPath), 0o700);
      }
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "carries the grant beside the terminal request, and refuses only input it must read on an older or undetermined agy",
    async () => {
      const dir = runDir();
      const input = spec("Fix it.", undefined, "workspace_write", dir);
      const saved = JSON.stringify({ permissions: { allow: ["command(git status)"] } });
      const settingsPath = saveProfile(input, saved);
      chmodSync(dirname(settingsPath), 0o500);
      try {
        observed.version = "1.5.14";
        const both = await collect({ ...input, prompt: oversized });
        expect(answerOf(both).settings).toEqual({
          permissions: { allow: ["command(git status)", GRANT], deny: [], ask: [] },
          ...TERMINAL,
        });
        expect(codesOf(both)).toContain("agy_workspace_write_session_policy");
        for (const version of ["1.5.6", null]) {
          observed.version = version as string;
          observed.options.length = 0;
          const small = await collect(input);
          expect(observed.options).toHaveLength(1);
          expect(answerOf(small).settings).toBeNull();
          expect(
            small.find((event) => event.payload?.["code"] === "agy_read_grant_unavailable")?.text,
          ).toContain("agy may refuse reads outside the workspace without asking");
          const large = await collect({ ...input, prompt: oversized });
          expect(observed.options).toHaveLength(1);
          expect(large.slice(-2).map((event) => event.type)).toEqual(["error", "completed"]);
          expect(large.at(-2)).toMatchObject({
            payload: { code: "agy_input_file_delivery_unavailable" },
            error: expect.stringContaining("the profile read grant is unavailable"),
          });
        }
        expect(readFileSync(settingsPath, "utf8")).toBe(saved);
      } finally {
        chmodSync(dirname(settingsPath), 0o700);
      }
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses file input whose only grant is a session file it cannot write, and runs inline input without it",
    async () => {
      observed.version = "1.5.14";
      const input = spec("Fix it.", undefined, "workspace_write", runDir());
      const settingsPath = saveProfile(input, JSON.stringify({}));
      const blocked = mkdtempSync(join(claudexorOwnedRoot(), "agy-tmp-blocked-"));
      roots.push(blocked);
      chmodSync(dirname(settingsPath), 0o500);
      chmodSync(blocked, 0o500);
      const previous = process.env.TMPDIR;
      process.env.TMPDIR = blocked;
      try {
        const large = await collect({ ...input, prompt: oversized });
        expect(observed.options).toHaveLength(0);
        expect(large.slice(-2).map((event) => event.type)).toEqual(["error", "completed"]);
        expect(large.at(-2)).toMatchObject({
          payload: { code: "agy_workspace_write_session_policy_unwritable" },
          error: expect.stringContaining("nothing was sent"),
        });
        // Never announced: the request never reached a launch.
        expect(codesOf(large)).not.toContain("agy_workspace_write_session_policy");
        const small = await collect(input);
        expect(observed.options).toHaveLength(1);
        expect(observed.options[0]!.args).not.toContain("--settings");
        const lacks = small.find(
          (event) => event.payload?.["code"] === "agy_workspace_write_session_policy_unwritable",
        );
        expect(lacks?.type).toBe("status");
        expect(lacks?.text).toContain("it requests no terminal sandbox");
        expect(lacks?.text).toContain("it carries no read grant in place of the one");
        expect(codesOf(small)).not.toContain("agy_workspace_write_session_policy");
      } finally {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
        chmodSync(blocked, 0o700);
        chmodSync(dirname(settingsPath), 0o700);
      }
    },
  );

  it("announces the terminal request only with a launch, never for refused input", async () => {
    observed.version = "1.5.14";
    // No run-owned directory for an input over the inline limit: refused.
    const refused = await collect(spec("p".repeat(128 * 1024 + 1), undefined, "workspace_write"));
    expect(observed.options).toHaveLength(0);
    expect(codesOf(refused)).toContain("agy_input_file_delivery_unavailable");
    expect(codesOf(refused)).not.toContain("agy_workspace_write_session_policy");
  });

  it("checks all three lists before saving the grant or requesting the terminal mode", async () => {
    observed.version = "1.5.14";
    const input = spec("Fix it.", undefined, "workspace_write");
    const saved = JSON.stringify({
      permissions: { allow: ["command(git status)"], deny: "command(sudo)" },
    });
    const settingsPath = saveProfile(input, saved);
    const events = await collect(input);
    // Ordinary inline work still runs, with neither the grant nor the request.
    expect(observed.options).toHaveLength(1);
    expect(observed.options[0]!.args).not.toContain("--settings");
    expect(observed.options[0]!.args).toContain("accept-edits");
    expect(readFileSync(settingsPath, "utf8")).toBe(saved);
    const unavailable = events.find(
      (event) => event.payload?.["code"] === "agy_workspace_write_session_policy_unavailable",
    );
    expect(unavailable?.text).toMatch(/: settings\.json permissions\.deny is not a list of rules$/);
    expect(codesOf(events)).toContain("agy_read_grant_unavailable");
    expect(codesOf(events)).not.toContain("agy_workspace_write_session_policy");
  });

  it.each([
    [{ toolPermission: "request-review" }, 'toolPermission is "request-review"'],
    [{ toolPermission: "strict" }, 'toolPermission is "strict"'],
    [{ toolPermission: "always-proceed" }, 'toolPermission is "always-proceed"'],
    [{ toolPermission: "ask-twice" }, "toolPermission has a value this engine does not recognize"],
    [{ enableTerminalSandbox: false }, "enableTerminalSandbox is false"],
  ])(
    "keeps the profile's own %j and sends a short workspace_write run no settings",
    async (saved, reason) => {
      observed.version = "1.5.14";
      const input = spec("Fix it.", undefined, "workspace_write");
      const settingsPath = saveProfile(input, saved);
      const events = await collect(input);
      expect(observed.options).toHaveLength(1);
      expect(observed.options[0]!.args).not.toContain("--settings");
      expect(observed.options[0]!.args).toContain("accept-edits");
      expect(answerOf(events).settings).toBeNull();
      const kept = events.find(
        (event) => event.payload?.["code"] === "agy_workspace_write_terminal_kept",
      );
      expect(kept).toMatchObject({
        type: "status",
        text: expect.stringContaining("requests no terminal sandbox"),
      });
      expect(kept!.text!.endsWith(`: the profile's ${reason}`)).toBe(true);
      expect(codesOf(events)).not.toContain("agy_workspace_write_session_policy");
      expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
        ...saved,
        permissions: { allow: [GRANT] },
      });
    },
  );

  it("starts a workspace_write run without session settings when the profile settings are unreadable", async () => {
    observed.version = "1.5.14";
    const input = spec("Fix.", undefined, "workspace_write");
    const settingsPath = saveProfile(input, "{ not json");
    const events = await collect(input);
    expect(observed.options).toHaveLength(1);
    expect(observed.options[0]!.args).not.toContain("--settings");
    expect(observed.options[0]!.args).toContain("accept-edits");
    expect(
      events.find(
        (event) => event.payload?.["code"] === "agy_workspace_write_session_policy_unavailable",
      ),
    ).toMatchObject({
      type: "status",
      text: expect.stringMatching(/headless turn: settings\.json is not valid JSON$/),
    });
    expect(codesOf(events)).toContain("agy_read_grant_unavailable");
    expect(readFileSync(settingsPath, "utf8")).toBe("{ not json");
  });

  it.each(["1.1.13", "1.4.10", "1.5.7", "1.5.8-rc.1"] as const)(
    "runs a short workspace_write task on a known older agy %s without session settings",
    async (version) => {
      observed.version = version;
      const events = await collect(spec("Fix it.", undefined, "workspace_write"));
      expect(observed.options).toHaveLength(1);
      expect(observed.options[0]!.args).not.toContain("--settings");
      expect(observed.options[0]!.args).toContain("accept-edits");
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(events.some((event) => event.type === "message" && event.final)).toBe(true);
      expect(
        events.find(
          (event) => event.payload?.["code"] === "agy_workspace_write_version_unsupported",
        ),
      ).toMatchObject({
        type: "status",
        payload: { installed_version: version, min_version: "1.5.8" },
        text: expect.stringContaining("requests no terminal sandbox"),
      });
      expect(codesOf(events)).not.toContain("agy_workspace_write_session_policy");
    },
  );

  it.each([
    ["1.1.13", { toolPermission: "strict" }, 'the profile\'s toolPermission is "strict"'],
    ["1.5.6", { toolPermission: "strict" }, 'the profile\'s toolPermission is "strict"'],
    ["1.5.7-rc.1", { toolPermission: "strict" }, 'the profile\'s toolPermission is "strict"'],
    [null, { toolPermission: "strict" }, 'the profile\'s toolPermission is "strict"'],
    ["1.5.6", "{ not json", "so it is unknown whether they set toolPermission"],
    [null, "{ not json", "so it is unknown whether they set toolPermission"],
    // Saved rules that let commands run without asking do not lift the refusal.
    [
      "1.5.6",
      { toolPermission: "strict", permissions: { allow: ["command(*)", "command(npm test)"] } },
      'the profile\'s toolPermission is "strict"',
    ],
  ] as const)(
    "refuses workspace_write before spawning on agy %s for a profile whose strict accept-edits might loosen (%j)",
    async (version, saved, cause) => {
      observed.version = version as string;
      const input = spec("Fix it.", undefined, "workspace_write");
      const settingsPath = saveProfile(input, saved);
      const before = readFileSync(settingsPath, "utf8");
      const events = await collect(input);
      expect(observed.options).toHaveLength(0);
      expect(events.map((event) => event.type)).toEqual(["error", "completed"]);
      expect(events[0]).toMatchObject({
        payload: {
          code: "agy_workspace_write_strict_unverified",
          installed_version: version,
          min_version: "1.5.7",
        },
        error: expect.stringContaining(cause),
      });
      expect(events[0]!.error).toMatch(/^agy workspace_write did not start, so nothing was sent: /);
      expect(events[0]!.error!.endsWith("; update agy to 1.5.7 or newer")).toBe(true);
      expect(readFileSync(settingsPath, "utf8")).toBe(before);
    },
  );

  it.each([
    ["1.5.7", [{ toolPermission: "strict" }]],
    ["1.5.14", [{ toolPermission: "strict" }, "{ not json"]],
  ] as const)(
    "admits a strict profile on agy %s, where file edits still ask under strict",
    async (version, profiles) => {
      observed.version = version;
      for (const saved of profiles) {
        observed.options.length = 0;
        const input = spec("Fix it.", undefined, "workspace_write");
        saveProfile(input, saved);
        const events = await collect(input);
        expect(observed.options).toHaveLength(1);
        expect(observed.options[0]!.args).toContain("accept-edits");
        expect(observed.options[0]!.args).not.toContain("--settings");
        expect(codesOf(events)).not.toContain("agy_workspace_write_strict_unverified");
        expect(codesOf(events)).not.toContain("agy_workspace_write_admin_controls_unverified");
      }
    },
  );

  it.each([
    ["1.1.13", { permissions: { allow: ["command(*)"] } }, "the profile's allow rule command(*)"],
    ["1.5.7", { permissions: { allow: ["command(*)"] } }, "the profile's allow rule command(*)"],
    [null, { permissions: { allow: ["command(*)"] } }, "the profile's allow rule command(*)"],
    [
      "1.5.7",
      { toolPermission: "always-proceed" },
      'the profile\'s toolPermission "always-proceed"',
    ],
    [
      "1.5.8-rc.1",
      { toolPermission: "always-proceed", permissions: { allow: ["command(*)"] } },
      'the profile\'s toolPermission "always-proceed"',
    ],
    // Strict is admitted from 1.5.7; a saved permission for every command is not.
    [
      "1.5.7",
      { toolPermission: "strict", permissions: { allow: ["command(*)"] } },
      "the profile's allow rule command(*)",
    ],
    ["1.5.7", "{ not json", "so it is unknown whether they let every shell command run"],
    [
      "1.5.7",
      { permissions: { allow: ["command(*)"], ask: "mcp(*)" } },
      "so it is unknown whether they let every shell command run",
    ],
  ] as const)(
    "refuses workspace_write before spawning on agy %s for a saved permission for every command (%j)",
    async (version, saved, cause) => {
      observed.version = version as string;
      const input = spec("Fix it.", undefined, "workspace_write");
      const settingsPath = saveProfile(input, saved);
      const before = readFileSync(settingsPath, "utf8");
      const events = await collect(input);
      expect(observed.options).toHaveLength(0);
      expect(events.map((event) => event.type)).toEqual(["error", "completed"]);
      expect(events[0]).toMatchObject({
        payload: {
          code: "agy_workspace_write_admin_controls_unverified",
          installed_version: version,
          min_version: "1.5.8",
        },
        error: expect.stringContaining(cause),
      });
      expect(events[0]!.error).toMatch(/^agy workspace_write did not start, so nothing was sent: /);
      expect(events[0]!.error).toContain("Gemini Enterprise admin controls");
      expect(events[0]!.error!.endsWith("; update agy to 1.5.8 or newer")).toBe(true);
      // The saved rules stay exactly as they were: no grant, no rewrite.
      expect(readFileSync(settingsPath, "utf8")).toBe(before);
    },
  );

  it("treats a settings file with a byte order mark as unreadable, never as empty", async () => {
    const saved = `\uFEFF${JSON.stringify({ toolPermission: "strict" })}`;
    observed.version = "1.5.14";
    const current = spec("Fix it.", undefined, "workspace_write");
    const currentPath = saveProfile(current, saved);
    const ran = await collect(current);
    expect(observed.options).toHaveLength(1);
    expect(observed.options[0]!.args).not.toContain("--settings");
    expect(codesOf(ran)).toContain("agy_workspace_write_session_policy_unavailable");
    expect(readFileSync(currentPath, "utf8")).toBe(saved);
    observed.options.length = 0;
    observed.version = "1.5.6";
    const older = spec("Fix it.", undefined, "workspace_write");
    saveProfile(older, saved);
    const refused = await collect(older);
    expect(observed.options).toHaveLength(0);
    expect(codesOf(refused)).toContain("agy_workspace_write_strict_unverified");
  });

  it("reads null permissions as no saved rules", async () => {
    observed.version = "1.5.14";
    const input = spec(oversized, undefined, "workspace_write", runDir());
    saveProfile(input, { permissions: null });
    const events = await collect(input);
    expect(profileOf(input)).toEqual({ permissions: { allow: [GRANT] } });
    expect(answerOf(events).settings).toEqual(TERMINAL);
    expect(answerOf(events).files.task?.bytes).toBe(Buffer.byteLength(oversized));
  });

  it("starts workspace_write without the terminal request when the agy version is undetermined", async () => {
    observed.version = null as unknown as string;
    const events = await collect(spec("Fix it.", undefined, "workspace_write"));
    expect(observed.options).toHaveLength(1);
    expect(observed.options[0]!.args).not.toContain("--settings");
    expect(observed.options[0]!.args).toContain("accept-edits");
    const codes = codesOf(events);
    expect(codes).toContain("agy_workspace_write_version_unknown");
    expect(codes).not.toContain("agy_workspace_write_version_unsupported");
    expect(codes).not.toContain("agy_workspace_write_session_policy");
  });

  it("sends the terminal request to a prerelease of a later agy", async () => {
    observed.version = "1.6.0-rc.1";
    const events = await collect(spec("Fix it.", undefined, "workspace_write"));
    expect(observed.options[0]!.args).toContain("--settings");
    expect(answerOf(events).settings).toEqual(TERMINAL);
  });

  it("delivers oversized workspace_write input whole through the read grant, naming no list", async () => {
    observed.version = "1.5.14";
    const dir = runDir();
    const input = spec(oversized, "caller instructions", "workspace_write", dir);
    const lists = {
      allow: ["command(git status)"],
      deny: ["read_file(/secret)", "command(sudo)"],
      ask: ["mcp(*)"],
    };
    saveProfile(input, { permissions: lists });
    const events = await collect(input);
    expect(observed.options).toHaveLength(1);
    expect(observed.options[0]!.input).not.toContain("TAIL-WORKSPACE-WRITE");
    const answer = answerOf(events);
    expect(answer.files.task).toEqual({
      bytes: Buffer.byteLength(oversized),
      hash: createHash("sha256").update(oversized).digest("hex"),
    });
    expect(readdirSync(dir)).toEqual([expect.stringMatching(/^agy-input-[0-9a-f]{64}$/)]);
    expect(answer.settings).toEqual(TERMINAL);
    expect(profileOf(input)).toEqual({ permissions: { ...lists, allow: [...lists.allow, GRANT] } });
    const codes = codesOf(events);
    expect(codes).toContain("agy_input_file_delivery");
    expect(codes).toContain("agy_workspace_write_session_policy");
  });

  it.each(["1.1.13", "1.4.10", "1.5.7", null] as const)(
    "delivers oversized input whole on agy %s through the read grant, without session settings",
    async (version) => {
      observed.version = version as string;
      const input = spec(oversized, undefined, "workspace_write", runDir());
      const events = await collect(input);
      expect(observed.options).toHaveLength(1);
      expect(observed.options[0]!.args).not.toContain("--settings");
      const answer = answerOf(events);
      expect(answer.settings).toBeNull();
      expect(answer.files.task?.bytes).toBe(Buffer.byteLength(oversized));
      expect(profileOf(input)).toEqual({ permissions: { allow: [GRANT] } });
    },
  );

  it.each([
    ["readonly", { toolPermission: "strict" }, 'the profile\'s toolPermission "strict" asks'],
    [
      "workspace_write",
      { toolPermission: "strict" },
      'the profile\'s toolPermission "strict" asks',
    ],
    [
      "inherit_native",
      { permissions: { ask: ["read_file(*)"] } },
      "the profile's ask rule read_file(*) asks",
    ],
    [
      "readonly",
      { permissions: { deny: ["read_file(*)"] } },
      "the profile's deny rule read_file(*) refuses",
    ],
    [
      "full",
      { permissions: { deny: ["read_file(*)"] } },
      "the profile's deny rule read_file(*) refuses",
    ],
  ] as const)(
    "refuses %s input it must deliver as files when the profile's own settings hold every read (%j)",
    async (access, saved, reason) => {
      observed.version = "1.5.14";
      const dir = runDir();
      const input = spec(oversized, undefined, access, dir);
      saveProfile(input, saved);
      const events = await collect(input);
      expect(observed.options).toHaveLength(0);
      expect(events.slice(-2).map((event) => event.type)).toEqual(["error", "completed"]);
      expect(events.at(-2)).toMatchObject({
        payload: { code: "agy_input_file_delivery_unavailable" },
        error: expect.stringContaining(`-byte limit for its standard input, and ${reason}`),
      });
      expect(events.at(-2)!.error).toMatch(
        /so agy could refuse to read the input files; nothing was sent$/,
      );
      expect(existsSync(dir)).toBe(false);
      // Inline input needs no file read and still runs.
      const inline = await collect({ ...input, prompt: "Fix it." });
      expect(observed.options).toHaveLength(1);
      expect(codesOf(inline)).not.toContain("agy_input_file_delivery_unavailable");
    },
  );

  it("delivers files to a full run whose prompts it approves, under strict or an ask rule", async () => {
    const input = spec(oversized, undefined, "full", runDir());
    saveProfile(input, { toolPermission: "strict", permissions: { ask: ["read_file(*)"] } });
    const events = await collect(input);
    expect(observed.options).toHaveLength(1);
    expect(answerOf(events).files.task?.bytes).toBe(Buffer.byteLength(oversized));
  });

  it("refuses oversized workspace_write input before sending when the settings cannot be read", async () => {
    observed.version = "1.5.14";
    const dir = runDir();
    const input = spec(oversized, undefined, "workspace_write", dir);
    saveProfile(input, "{ not json");
    const events = await collect(input);
    expect(observed.options).toHaveLength(0);
    expect(events.slice(-2).map((event) => event.type)).toEqual(["error", "completed"]);
    expect(events.at(-2)).toMatchObject({
      payload: { code: "agy_input_file_delivery_unavailable" },
      error: expect.stringContaining("the profile read grant is unavailable"),
    });
    expect(existsSync(dir)).toBe(false);
  });

  it("gates on the program this run launches and ends cleanly when aborted meanwhile", async () => {
    observed.version = "1.5.14";
    const input = spec("Fix it.", undefined, "workspace_write");
    await collect(input);
    // The decision and the pre-launch confirmation ask the same observation:
    // the profile's own HOME and the run's directory, as at launch.
    expect(observed.gates).toHaveLength(2);
    for (const gate of observed.gates) {
      expect(gate!.cwd).toBe(input.cwd);
      expect(gate!.environment?.["HOME"]).toBe(
        realpathSync(input.credential_profile!.isolation_locator!),
      );
    }

    const controller = new AbortController();
    controller.abort();
    observed.options.length = 0;
    const events = await collect({ ...input, extra: { abortSignal: controller.signal } });
    expect(observed.options).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "completed", aborted: true });
  });

  it.each([
    ["1.5.14", "1.5.6", { toolPermission: "strict" }],
    ["1.5.14", null, {}],
    ["1.5.6", "1.5.14", {}],
  ] as const)(
    "refuses before sending when agy changes from %s to %s between its version read and the launch",
    async (decided, launch, saved) => {
      observed.sequence.push(decided, launch);
      const input = spec("Fix it.", undefined, "workspace_write");
      saveProfile(input, saved);
      const events = await collect(input);
      expect(observed.options).toHaveLength(0);
      expect(events.slice(-2).map((event) => event.type)).toEqual(["error", "completed"]);
      expect(events.at(-2)).toMatchObject({
        payload: {
          code: "agy_workspace_write_program_changed",
          installed_version: decided,
          launch_version: launch,
        },
        error: expect.stringContaining("nothing was sent"),
      });
      expect(codesOf(events)).not.toContain("agy_workspace_write_session_policy");
    },
  );

  it.each(["full", "inherit_native"] as const)(
    "keeps %s argv and input free of session settings policy",
    async (access) => {
      const input = spec("Fix it.", "caller instructions", access);
      const events = await collect(input);
      expect(observed.options[0]!.input).toBe(
        "[SYSTEM INSTRUCTIONS]\ncaller instructions\n[END SYSTEM INSTRUCTIONS]\n\nFix it.",
      );
      expect(observed.options[0]!.args).not.toContain("--settings");
      expect(answerOf(events).settings).toBeNull();
      const codes = events.map((event) => event.payload?.["code"]);
      expect(codes).not.toContain("agy_readonly_access_note");
      expect(codes).not.toContain("agy_readonly_session_policy");
      expect(codes).not.toContain("agy_workspace_write_session_policy");
    },
  );

  it("keeps full-access input and events free of readonly disclosures", async () => {
    const input = spec("Fix it.", "caller instructions", "full");
    const settingsPath = agySettingsPath(input.credential_profile!.isolation_locator!);
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, "{ not json");
    const events = await collect(input);
    expect(observed.options[0]!.input).toBe(
      "[SYSTEM INSTRUCTIONS]\ncaller instructions\n[END SYSTEM INSTRUCTIONS]\n\nFix it.",
    );
    const codes = events.map((event) => event.payload?.["code"]);
    expect(codes).not.toContain("agy_read_grant_unavailable");
    expect(codes).not.toContain("agy_readonly_access_note");
  });

  it("refuses only actual empty input before spawn, while instructions alone remain usable", async () => {
    const empty = await collect(spec(""));
    expect(observed.options).toHaveLength(0);
    expect(empty.map((event) => event.type)).toEqual(["error", "completed"]);
    expect(empty[0]?.error).toContain("nonempty input");
    const instructionsOnly = await collect(spec("", "system input"));
    expect(observed.options).toHaveLength(1);
    expect(instructionsOnly.some((event) => event.type === "message" && event.final)).toBe(true);
  });
});
