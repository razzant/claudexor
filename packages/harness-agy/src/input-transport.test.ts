import { createHash } from "node:crypto";
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
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessRunSpec, type CredentialProfile, type HarnessEvent } from "@claudexor/schema";
import type { CliRunLoopOptions, SpawnOptions } from "@claudexor/core";
import { claudexorOwnedRoot } from "@claudexor/util";
import { createAgyAdapter } from "./index.js";
import { agySettingsPath } from "./read-grant.js";

const observed = vi.hoisted(() => ({
  options: [] as CliRunLoopOptions[],
  captures: [] as Array<SpawnOptions | undefined>,
}));
vi.mock("@claudexor/core", async (original) => {
  const actual = await original<typeof import("@claudexor/core")>();
  return {
    ...actual,
    runCapture: async (_bin: string, _args: string[], options?: SpawnOptions) => {
      observed.captures.push(options);
      return { code: 0, signal: null, stdout: "1.1.13\n", stderr: "" };
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
  observed.options.length = 0;
  observed.captures.length = 0;
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

describe("AGY doctor readonly minimum (#653)", () => {
  it("states that readonly runs on the probed 1.1.13 stop for an update", async () => {
    const report = await createAgyAdapter({ prepareProfileKeychain: () => undefined }).doctor(
      {} as Parameters<ReturnType<typeof createAgyAdapter>["doctor"]>[0],
    );
    const check = report.checks.find((c) => c.id === "readonly_min_version");
    expect(check).toMatchObject({ status: "fail" });
    expect(check?.detail).toContain("installed 1.1.13 stops readonly runs before the model");
    expect(report.reasons).toContain(check?.detail);
    // The fixture pin stays its own check.
    expect(report.checks.find((c) => c.id === "version_pin")).toMatchObject({ status: "pass" });
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

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps workspace_write as before when the read grant cannot be saved",
    async () => {
      const run = mkdtempSync(join(claudexorOwnedRoot(), "agy-run-"));
      roots.push(run);
      const small = spec("Fix it.", undefined, "workspace_write", join(run, "context"));
      const settingsPath = agySettingsPath(small.credential_profile!.isolation_locator!);
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: [] } }));
      chmodSync(dirname(settingsPath), 0o500);
      try {
        const events = await collect(small);
        expect(observed.options[0]!.args).not.toContain("--settings");
        const grant = events.find(
          (event) => event.payload?.["code"] === "agy_read_grant_unavailable",
        );
        expect(grant?.text).toMatch(/^agy may refuse reads outside the workspace without asking: /);
        const large = await collect({ ...small, prompt: "p".repeat(128 * 1024 + 1) });
        expect(observed.options).toHaveLength(1);
        expect(large.at(-2)).toMatchObject({
          type: "error",
          payload: { code: "agy_input_file_delivery_unavailable" },
          error: expect.stringContaining("read grant is unavailable"),
        });
      } finally {
        chmodSync(dirname(settingsPath), 0o700);
      }
    },
  );

  it.each(["full", "workspace_write", "inherit_native"] as const)(
    "keeps %s argv and input free of the readonly session policy",
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
      expect(codes).not.toContain("agy_readonly_session_policy_unavailable");
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
