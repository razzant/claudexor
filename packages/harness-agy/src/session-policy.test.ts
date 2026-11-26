import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessEvent } from "@claudexor/schema";
import { agySettingsPath, ensureAgyReadGrant } from "./read-grant.js";
import { agyWorkspaceWriteCliFacts } from "./vendor-cli-version.js";
import {
  AGY_READONLY_DENY_RULES,
  AGY_WORKSPACE_WRITE_TERMINAL,
  agyReadonlyPolicy,
  agyReadonlyPolicyEvent,
  agyWorkspaceWriteAdminControlsRefusal,
  agyWorkspaceWriteSessionSettings,
  agyWorkspaceWriteStrictRefusal,
  agyWorkspaceWritePolicyEvent,
  agyWorkspaceWriteTerminal,
  agyWorkspaceWriteTerminalPlan,
  withAgySessionSettings,
} from "./session-policy.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function grantFor(settings?: string) {
  const home = mkdtempSync(join(tmpdir(), "agy-session-policy-"));
  homes.push(home);
  if (settings !== undefined) {
    mkdirSync(dirname(agySettingsPath(home)), { recursive: true });
    writeFileSync(agySettingsPath(home), settings);
  }
  return { home, grant: ensureAgyReadGrant(home) };
}

async function drain(stream: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

describe("agy readonly session policy (#653)", () => {
  it("keeps every profile rule and adds the denials once", () => {
    // agy 1.5.0 replaces each list the session object names (probed without
    // credentials), so a deny-only object would drop this read denial.
    const { grant } = grantFor(
      JSON.stringify({
        toolPermission: "strict",
        theme: "dark",
        permissions: {
          allow: ["command(git status)"],
          deny: ["read_file(/secret/**)", "command(*)"],
          ask: ["read_url(example.com)"],
        },
      }),
    );
    expect(agyReadonlyPolicy(grant)).toEqual({
      state: "composed",
      settings: {
        permissions: {
          allow: ["command(git status)", "read_file(*)"],
          deny: ["read_file(/secret/**)", "command(*)", "write_file(*)"],
          ask: ["read_url(example.com)"],
        },
      },
    });
  });

  it("composes from a profile that has only the read grant", () => {
    const { grant } = grantFor();
    expect(agyReadonlyPolicy(grant)).toEqual({
      state: "composed",
      settings: {
        permissions: { allow: ["read_file(*)"], deny: [...AGY_READONLY_DENY_RULES], ask: [] },
      },
    });
  });

  it.each([
    ["unreadable JSON", "{ nope", "not valid JSON"],
    [
      "a deny that is not a list",
      JSON.stringify({ permissions: { deny: "command(*)" } }),
      "deny is not a list",
    ],
    [
      "an ask holding a non-rule",
      JSON.stringify({ permissions: { ask: [{ rule: 1 }] } }),
      "ask is not a list of rules",
    ],
    [
      "an allow holding a non-rule",
      JSON.stringify({ permissions: { allow: [7] } }),
      "allow is not a list of rules",
    ],
  ])("treats %s as unknown, never as empty", (_label, settings, reason) => {
    const { home, grant } = grantFor(settings);
    // The grant owns its own write (an invalid document is never rewritten);
    // composing the policy writes nothing.
    const before = readFileSync(agySettingsPath(home), "utf8");
    if (grant.state === "unavailable") expect(before).toBe(settings);
    const policy = agyReadonlyPolicy(grant);
    expect(policy).toEqual({ state: "unavailable", reason: expect.stringContaining(reason) });
    expect(readFileSync(agySettingsPath(home), "utf8")).toBe(before);
  });

  // Review rl-20261108T203611 (Astra): a grant that cannot be saved must not
  // drop the denials; the rules as read are known, so the policy is composed.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "composes from the rules as read when the read grant cannot be saved",
    () => {
      const home = mkdtempSync(join(tmpdir(), "agy-session-policy-"));
      homes.push(home);
      const settings = JSON.stringify({
        toolPermission: "strict",
        permissions: {
          allow: ["command(git status)"],
          deny: ["read_file(/secret/**)"],
          ask: ["mcp(*)"],
        },
      });
      const dir = dirname(agySettingsPath(home));
      mkdirSync(dir, { recursive: true });
      writeFileSync(agySettingsPath(home), settings);
      chmodSync(dir, 0o500);
      try {
        const grant = ensureAgyReadGrant(home);
        expect(grant).toMatchObject({
          state: "unavailable",
          reason: expect.stringContaining("could not be written"),
        });
        expect(readFileSync(agySettingsPath(home), "utf8")).toBe(settings);
        expect(agyReadonlyPolicy(grant)).toEqual({
          state: "composed",
          settings: {
            permissions: {
              allow: ["command(git status)", "read_file(*)"],
              deny: ["read_file(/secret/**)", "command(*)", "write_file(*)"],
              ask: ["mcp(*)"],
            },
          },
        });
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );

  it("discloses a composed policy as one status event", () => {
    expect(agyReadonlyPolicyEvent("s")).toMatchObject({
      type: "status",
      session_id: "s",
      payload: { code: "agy_readonly_session_policy", deny: [...AGY_READONLY_DENY_RULES] },
    });
  });

  it("hands the child a private settings file and removes it when the run ends", async () => {
    const { grant } = grantFor();
    const policy = agyReadonlyPolicy(grant);
    if (policy.state !== "composed") throw new Error("expected a composed policy");
    let seen: { args: string[]; content: unknown; mode: number } | undefined;
    const events = await drain(
      withAgySessionSettings(policy.settings, "s", async function* (args) {
        const path = args[1]!;
        seen = {
          args,
          content: JSON.parse(readFileSync(path, "utf8")),
          mode: statSync(path).mode & 0o777,
        };
        yield { type: "completed", session_id: "s", ts: "t" };
      }),
    );
    expect(events.map((event) => event.type)).toEqual(["completed"]);
    expect(seen!.args[0]).toBe("--settings");
    expect(seen!.content).toEqual(policy.settings);
    expect(seen!.mode).toBe(0o600);
    expect(existsSync(seen!.args[1]!)).toBe(false);
    expect(existsSync(dirname(seen!.args[1]!))).toBe(false);
  });

  it("announces what the file carries only once it is in place, before the child starts", async () => {
    const order: string[] = [];
    await drain(
      (async function* () {
        for await (const event of withAgySessionSettings(
          { ...AGY_WORKSPACE_WRITE_TERMINAL },
          "s",
          async function* (args) {
            order.push(existsSync(args[1]!) ? "child with file" : "child without file");
          },
          { access: "workspace_write", written: () => [agyWorkspaceWritePolicyEvent("s")] },
        ))
          order.push(String(event.payload?.["code"]));
      })(),
    );
    expect(order).toEqual(["agy_workspace_write_session_policy", "child with file"]);
  });

  it("removes the file when the run throws and passes no flag without a policy", async () => {
    const { grant } = grantFor();
    const policy = agyReadonlyPolicy(grant);
    if (policy.state !== "composed") throw new Error("expected a composed policy");
    let path = "";
    await expect(
      drain(
        withAgySessionSettings(policy.settings, "s", async function* (args) {
          path = args[1]!;
          yield { type: "status", session_id: "s", ts: "t" };
          throw new Error("spawn failed");
        }),
      ),
    ).rejects.toThrow("spawn failed");
    expect(path).not.toBe("");
    expect(existsSync(path)).toBe(false);
    let args: string[] | undefined;
    await drain(
      withAgySessionSettings(null, "s", async function* (given) {
        args = given;
      }),
    );
    expect(args).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses before the child starts when the file cannot be written",
    async () => {
      const { grant } = grantFor();
      const policy = agyReadonlyPolicy(grant);
      if (policy.state !== "composed") throw new Error("expected a composed policy");
      const blocked = mkdtempSync(join(tmpdir(), "agy-session-blocked-"));
      homes.push(blocked);
      chmodSync(blocked, 0o500);
      const previous = process.env.TMPDIR;
      process.env.TMPDIR = blocked;
      let started = false;
      try {
        const events = await drain(
          withAgySessionSettings(policy.settings, "s", async function* () {
            started = true;
          }),
        );
        expect(started).toBe(false);
        expect(events.map((event) => event.type)).toEqual(["error", "completed"]);
        expect(events[0]).toMatchObject({
          payload: { code: "agy_readonly_session_policy_unwritable" },
          error: expect.stringContaining("nothing was sent"),
        });

        const wwEvents = await drain(
          withAgySessionSettings(
            policy.settings,
            "s",
            async function* (args) {
              yield { type: "status", session_id: "s", ts: "t", text: JSON.stringify(args) };
            },
            { access: "workspace_write" },
          ),
        );
        // A workspace_write run starts without the file and says what it lacks.
        expect(wwEvents.map((event) => event.type)).toEqual(["status", "status"]);
        expect(wwEvents[0]).toMatchObject({
          payload: { code: "agy_workspace_write_session_policy_unwritable" },
          text: expect.stringContaining("runs without session settings"),
        });
        expect(wwEvents[0]!.text).toContain("it carries no read grant in place of the one");
        expect(wwEvents[0]!.text).not.toContain("terminal sandbox");
        expect(wwEvents[1]!.text).toBe("[]");

        // Input only the file's grant lets agy read: refused, never sent unreadable.
        // What the file would have carried is never announced without it.
        let announced = false;
        const required = await drain(
          withAgySessionSettings(
            { permissions: policy.settings.permissions, ...AGY_WORKSPACE_WRITE_TERMINAL },
            "s",
            async function* () {
              started = true;
            },
            {
              access: "workspace_write",
              required: true,
              written: () => {
                announced = true;
                return [agyWorkspaceWritePolicyEvent("s")];
              },
            },
          ),
        );
        expect(started).toBe(false);
        expect(announced).toBe(false);
        expect(required.map((event) => event.type)).toEqual(["error", "completed"]);
        expect(required[0]).toMatchObject({
          payload: { code: "agy_workspace_write_session_policy_unwritable" },
          error: expect.stringContaining("nothing was sent"),
        });

        const terminalOnly = await drain(
          withAgySessionSettings({ ...AGY_WORKSPACE_WRITE_TERMINAL }, "s", async function* () {}, {
            access: "workspace_write",
            written: () => [agyWorkspaceWritePolicyEvent("s")],
          }),
        );
        expect(terminalOnly.map((event) => event.payload?.["code"])).toEqual([
          "agy_workspace_write_session_policy_unwritable",
        ]);
        expect(terminalOnly[0]!.text).toContain("it requests no terminal sandbox");
      } finally {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
        chmodSync(blocked, 0o700);
      }
    },
  );
});

describe("agy workspace_write session policy", () => {
  const read = (settings: Record<string, unknown>) => ({
    state: "read" as const,
    settings,
    rules: { state: "valid" as const, lists: { allow: [] as string[], deny: [], ask: [] } },
    text: null,
    mode: 0o600,
  });

  it("requests the vendor's limited terminal mode only where the profile leaves it unset", () => {
    for (const settings of [
      {},
      { theme: "dark", permissions: { allow: ["command(git status)"], deny: ["command(sudo)"] } },
      { toolPermission: "proceed-in-sandbox" },
      { enableTerminalSandbox: true },
      { toolPermission: "proceed-in-sandbox", enableTerminalSandbox: true },
    ])
      expect(agyWorkspaceWriteTerminal(read(settings))).toEqual({ state: "requested" });
  });

  it.each([
    [{ toolPermission: "request-review" }, 'toolPermission is "request-review"'],
    [{ toolPermission: "strict" }, 'toolPermission is "strict"'],
    [{ toolPermission: "always-proceed" }, 'toolPermission is "always-proceed"'],
    [{ toolPermission: "ask-twice" }, "toolPermission has a value this engine does not recognize"],
    [{ toolPermission: null }, "toolPermission has a value this engine does not recognize"],
    [{ enableTerminalSandbox: false }, "enableTerminalSandbox is false"],
    [
      { enableTerminalSandbox: "on" },
      "enableTerminalSandbox has a value this engine does not recognize",
    ],
    [
      { toolPermission: "proceed-in-sandbox", enableTerminalSandbox: false },
      "enableTerminalSandbox is false",
    ],
  ])("keeps a profile's own terminal choice %j instead of loosening it", (settings, reason) => {
    expect(agyWorkspaceWriteTerminal(read(settings))).toEqual({
      state: "kept",
      reason: `the profile's ${reason}`,
    });
  });

  it("requests nothing from settings it could not read or lists that are not rules", () => {
    const unreadable = { state: "unavailable" as const, reason: "settings.json is not valid JSON" };
    expect(agyWorkspaceWriteTerminal(unreadable)).toEqual(unreadable);
    const reason = "settings.json permissions.deny is not a list of rules";
    expect(agyWorkspaceWriteTerminal({ ...read({}), rules: { state: "invalid", reason } })).toEqual(
      { state: "unavailable", reason },
    );
  });

  it("composes a session file from the terminal request and, only when given, the carried lists", () => {
    const carried = {
      allow: ["command(git status)", "read_file(*)"],
      deny: ["command(sudo)"],
      ask: [],
    };
    expect(agyWorkspaceWriteSessionSettings(null, false)).toBeNull();
    expect(agyWorkspaceWriteSessionSettings(null, true)).toEqual(AGY_WORKSPACE_WRITE_TERMINAL);
    expect(agyWorkspaceWriteSessionSettings(carried, false)).toEqual({ permissions: carried });
    // The lists as given, every allow, deny and ask rule kept, and no other rule.
    expect(agyWorkspaceWriteSessionSettings(carried, true)).toEqual({
      permissions: carried,
      ...AGY_WORKSPACE_WRITE_TERMINAL,
    });
  });

  it("names the two terminal settings alone, with no permission list or general rule", () => {
    expect(AGY_WORKSPACE_WRITE_TERMINAL).toEqual({
      enableTerminalSandbox: true,
      toolPermission: "proceed-in-sandbox",
    });
    expect(Object.keys(AGY_WORKSPACE_WRITE_TERMINAL)).not.toContain("permissions");
  });

  it("requests the mode only on agy 1.5.8 or newer and says why it did not", () => {
    const plan = (installed: string | null, settings: Record<string, unknown> = {}) =>
      agyWorkspaceWriteTerminalPlan("s", read(settings), agyWorkspaceWriteCliFacts(installed));
    // A request is announced at launch, not while the run is prepared.
    expect(plan("1.5.8")).toEqual({ requested: true });
    expect(plan("1.5.7")).toMatchObject({
      requested: false,
      status: {
        payload: {
          code: "agy_workspace_write_version_unsupported",
          installed_version: "1.5.7",
          min_version: "1.5.8",
        },
      },
    });
    expect(plan(null)).toMatchObject({
      requested: false,
      status: { payload: { code: "agy_workspace_write_version_unknown", min_version: "1.5.8" } },
    });
    expect(plan("1.5.14", { toolPermission: "request-review" })).toMatchObject({
      requested: false,
      status: {
        payload: { code: "agy_workspace_write_terminal_kept" },
        text: expect.stringContaining('the profile\'s toolPermission is "request-review"'),
      },
    });
    for (const outcome of [
      plan("1.5.7"),
      plan(null),
      plan("1.5.14", { toolPermission: "strict" }),
    ]) {
      if (outcome.requested) throw new Error("expected no request");
      // Edits follow accept-edits within the profile's settings: never promised.
      expect(outcome.status.text).toContain(
        "its file edits follow accept-edits within the profile's own settings",
      );
      expect(outcome.status.text).toContain(
        "a shell command agy would ask about is denied without asking",
      );
      expect(outcome.status.text).not.toContain("this run edits files");
    }
  });

  it("refuses a strict or unreadable profile where accept-edits might loosen strict", () => {
    const strict = read({ toolPermission: "strict" });
    const unreadable = { state: "unavailable" as const, reason: "settings.json is not valid JSON" };
    for (const version of ["1.1.13", "1.5.6", "1.5.7-rc.1"]) {
      const cli = agyWorkspaceWriteCliFacts(version);
      expect(agyWorkspaceWriteStrictRefusal(strict, cli)).toBe(
        `agy workspace_write did not start, so nothing was sent: the profile's toolPermission is "strict", and agy ${version} is older than 1.5.7, the first release in which file edits still ask under strict with accept-edits; update agy to 1.5.7 or newer`,
      );
      expect(agyWorkspaceWriteStrictRefusal(unreadable, cli)).toContain(
        `the profile's settings could not be read (settings.json is not valid JSON), so it is unknown whether they set toolPermission "strict"`,
      );
    }
    const unknown = agyWorkspaceWriteCliFacts(null);
    for (const profile of [strict, unreadable])
      expect(agyWorkspaceWriteStrictRefusal(profile, unknown)).toContain(
        "the agy version could not be determined, so it is unknown whether file edits still ask under its strict setting with accept-edits",
      );
    // Saved rules that let commands run without asking do not lift the refusal.
    const conflicting = {
      ...read({ toolPermission: "strict", permissions: { allow: ["command(*)"] } }),
      rules: { state: "valid" as const, lists: { allow: ["command(*)"], deny: [], ask: [] } },
    };
    expect(agyWorkspaceWriteStrictRefusal(conflicting, unknown)).toContain(
      `the profile's toolPermission is "strict"`,
    );
    // Lists that are not rules leave a readable strict choice decisive either way.
    const strictInvalid = {
      ...read({ toolPermission: "strict" }),
      rules: {
        state: "invalid" as const,
        reason: "settings.json permissions.ask is not a list of rules",
      },
    };
    expect(
      agyWorkspaceWriteStrictRefusal(strictInvalid, agyWorkspaceWriteCliFacts("1.5.6")),
    ).toContain(`the profile's toolPermission is "strict"`);
    expect(
      agyWorkspaceWriteStrictRefusal(
        { ...strictInvalid, settings: {} },
        agyWorkspaceWriteCliFacts("1.5.6"),
      ),
    ).toBeNull();
    // Ordinary edits keep running on any version, and strict itself from 1.5.7.
    for (const version of ["1.1.13", "1.5.6", null])
      for (const settings of [{}, { toolPermission: "request-review" }, { theme: "dark" }])
        expect(
          agyWorkspaceWriteStrictRefusal(read(settings), agyWorkspaceWriteCliFacts(version)),
        ).toBeNull();
    for (const version of ["1.5.7", "1.5.14"])
      for (const profile of [strict, unreadable])
        expect(
          agyWorkspaceWriteStrictRefusal(profile, agyWorkspaceWriteCliFacts(version)),
        ).toBeNull();
  });

  it("refuses a saved permission for every command where admin controls might not apply", () => {
    const lists = (allow: string[], deny: string[] = [], ask: string[] = []) => ({
      state: "valid" as const,
      lists: { allow, deny, ask },
    });
    // Not strict: the permission alone decides.
    const allowAll = {
      ...read({ theme: "dark" }),
      rules: lists(["command(git status)", "command(*)"]),
    };
    const proceed = read({ toolPermission: "always-proceed" });
    const unreadable = { state: "unavailable" as const, reason: "settings.json is not valid JSON" };
    const reason = "settings.json permissions.ask is not a list of rules";
    const invalid = { ...read({}), rules: { state: "invalid" as const, reason } };
    const unknown = "so it is unknown whether they let every shell command run without asking";
    for (const version of ["1.1.13", "1.5.7", "1.5.8-rc.1"]) {
      const cli = agyWorkspaceWriteCliFacts(version);
      expect(agyWorkspaceWriteAdminControlsRefusal(allowAll, cli)).toBe(
        `agy workspace_write did not start, so nothing was sent: the profile's allow rule command(*) runs every shell command without asking, and agy ${version} is older than 1.5.8, the first release whose headless runs apply Gemini Enterprise admin controls, so such a permission could override them; update agy to 1.5.8 or newer`,
      );
      expect(agyWorkspaceWriteAdminControlsRefusal(proceed, cli)).toContain(
        `: the profile's toolPermission "always-proceed" runs every shell command without asking, and agy ${version} is older than 1.5.8`,
      );
      expect(agyWorkspaceWriteAdminControlsRefusal(unreadable, cli)).toContain(
        `the profile's settings could not be read (settings.json is not valid JSON), ${unknown}`,
      );
      expect(agyWorkspaceWriteAdminControlsRefusal(invalid, cli)).toContain(
        `the profile's rules could not be checked (${reason}), ${unknown}`,
      );
    }
    expect(agyWorkspaceWriteAdminControlsRefusal(allowAll, agyWorkspaceWriteCliFacts(null))).toBe(
      "agy workspace_write did not start, so nothing was sent: the profile's allow rule command(*) runs every shell command without asking, and the agy version could not be determined, so it is unknown whether its headless runs apply Gemini Enterprise admin controls over such a permission; update agy to 1.5.8 or newer",
    );
    // Compared as written: narrower or differently written command rules, the
    // rule in deny or ask, and other settings keep ordinary edits on any version.
    for (const version of ["1.1.13", "1.5.7", null])
      for (const profile of [
        read({}),
        read({ toolPermission: "request-review" }),
        {
          ...read({}),
          rules: lists(["command(npm test)", "command(**)"], ["command(*)"], ["command(*)"]),
        },
      ])
        expect(
          agyWorkspaceWriteAdminControlsRefusal(profile, agyWorkspaceWriteCliFacts(version)),
        ).toBeNull();
    // From 1.5.8 such a permission stays the profile's own choice under admin controls.
    for (const version of ["1.5.8", "1.5.14", "1.6.0-rc.1"])
      for (const profile of [allowAll, proceed, unreadable, invalid])
        expect(
          agyWorkspaceWriteAdminControlsRefusal(profile, agyWorkspaceWriteCliFacts(version)),
        ).toBeNull();
  });

  it("discloses the request as requested, not as proven isolation", () => {
    const event = agyWorkspaceWritePolicyEvent("s");
    expect(event).toMatchObject({
      type: "status",
      session_id: "s",
      payload: {
        code: "agy_workspace_write_session_policy",
        requested: { enableTerminalSandbox: true, toolPermission: "proceed-in-sandbox" },
      },
    });
    expect(event.text).toContain("request agy's terminal sandbox");
    expect(event.text).toContain("Requested, not observed");
    expect(event.text).toContain("it is no isolation for untrusted code");
    expect(event.text).toContain("on a personal account also outside the sandbox");
  });
});
