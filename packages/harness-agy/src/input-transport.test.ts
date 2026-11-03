import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      console.log(JSON.stringify({event:'init', conversation_id:'fixture', init:{
        model:'gemini-fixture', cwd:process.cwd(), tools:[], permission_mode:'plan'
      }}));
      console.log(JSON.stringify({event:'result', result:{status:'SUCCESS', response:JSON.stringify({
        bytes:input.length, hash:crypto.createHash('sha256').update(input).digest('hex'), args
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
  });
}
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

describe("AGY native raw stdin selection", () => {
  it.each(["short", "large", "whitespace"])(
    "delivers %s prompt and instructions without a print flag",
    async (size) => {
      const unit = '  Русский 🙂 "quotes"\nline\t end  ';
      const prompt =
        size === "large" ? unit.repeat(90_000) : size === "whitespace" ? " \n\t " : unit;
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
      const final = events.find((event) => event.type === "message" && event.final);
      expect(final?.text).toBeDefined();
      expect(JSON.parse(final!.text!)).toEqual({
        bytes: Buffer.byteLength(expected),
        hash: createHash("sha256").update(expected).digest("hex"),
        args: options.args,
      });
      expect(events.some((event) => event.type === "error")).toBe(false);
    },
  );

  it("grants reads anywhere and tells a readonly child that commands are unavailable", async () => {
    const input = spec("Review the attached screenshot.", "caller instructions", "readonly");
    const events = await collect(input);
    const options = observed.options[0]!;
    expect(
      options.args.slice(options.args.indexOf("--mode"), options.args.indexOf("--mode") + 2),
    ).toEqual(["--mode", "plan"]);
    expect(options.args).not.toContain("--dangerously-skip-permissions");
    const settingsPath = agySettingsPath(input.credential_profile!.isolation_locator!);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      permissions: { allow: ["read_file(*)"] },
    });
    expect(options.input).toMatch(
      /^\[SYSTEM INSTRUCTIONS\]\ncaller instructions\n\nENGINE NOTE \(read-only Antigravity run\): Your file tools may read any file or folder on this machine, inside or outside the workspace\. Shell commands are unavailable in this mode: .+\n\[END SYSTEM INSTRUCTIONS\]\n\nReview the attached screenshot\.$/,
    );
    const codes = events.map((event) => event.payload?.["code"]);
    expect(codes).toContain("agy_readonly_access_note");
    expect(codes).not.toContain("agy_read_grant_unavailable");
  });

  it("discloses a missing read grant instead of rewriting foreign settings", async () => {
    const input = spec("Review.", undefined, "readonly");
    const settingsPath = agySettingsPath(input.credential_profile!.isolation_locator!);
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, "{ not json");
    const events = await collect(input);
    expect(readFileSync(settingsPath, "utf8")).toBe("{ not json");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "status", payload: { code: "agy_read_grant_unavailable" } }),
    );
    expect(observed.options[0]!.input).toContain(
      "A read outside the workspace folder may be refused without asking.",
    );
  });

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
