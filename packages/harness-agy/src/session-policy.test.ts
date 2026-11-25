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
import {
  AGY_READONLY_DENY_RULES,
  AGY_WORKSPACE_WRITE_ALLOW_RULES,
  agyReadonlyPolicy,
  agyReadonlyPolicyEvent,
  agyWorkspaceWritePolicy,
  agyWorkspaceWritePolicyEvent,
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
            async function* () {
              started = true;
            },
            { access: "workspace_write" },
          ),
        );
        expect(started).toBe(false);
        expect(wwEvents.map((event) => event.type)).toEqual(["error", "completed"]);
        expect(wwEvents[0]).toMatchObject({
          payload: { code: "agy_workspace_write_session_policy_unwritable" },
          error: expect.stringContaining("nothing was sent"),
        });
      } finally {
        if (previous === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previous;
        chmodSync(blocked, 0o700);
      }
    },
  );
});

describe("agy workspace_write session policy (agy >= 1.5.7)", () => {
  it("keeps profile rules intact and appends command(*) once", () => {
    const { grant } = grantFor(
      JSON.stringify({
        toolPermission: "strict",
        permissions: {
          allow: ["read_file(/repo/**)"],
          deny: ["read_file(/secret/**)", "command(sudo *)"],
          ask: ["mcp(*)"],
        },
      }),
    );
    expect(agyWorkspaceWritePolicy(grant)).toEqual({
      state: "composed",
      settings: {
        permissions: {
          allow: ["read_file(/repo/**)", "read_file(*)", ...AGY_WORKSPACE_WRITE_ALLOW_RULES],
          deny: ["read_file(/secret/**)", "command(sudo *)"],
          ask: ["mcp(*)"],
        },
      },
      addedAllow: ["command(*)"],
      addedDeny: [],
    });

    const again = grantFor(JSON.stringify({ permissions: { allow: ["command(*)"] } }));
    expect(agyWorkspaceWritePolicy(again.grant)).toEqual({
      state: "composed",
      settings: { permissions: { allow: ["command(*)", "read_file(*)"], deny: [], ask: [] } },
      addedAllow: [],
      addedDeny: [],
    });
  });

  it("fails closed when profile permissions are corrupt or non-list", () => {
    const { home, grant } = grantFor(JSON.stringify({ permissions: { ask: "mcp(*)" } }));
    const before = readFileSync(agySettingsPath(home), "utf8");
    expect(agyWorkspaceWritePolicy(grant)).toEqual({
      state: "unavailable",
      reason: expect.stringContaining("ask is not a list of rules"),
    });
    expect(readFileSync(agySettingsPath(home), "utf8")).toBe(before);
  });

  it.each(["command", "command(*)", "run_command", "run_command(*)", "Bash"] as const)(
    "honors caller shell deny %s without granting command(*)",
    (token) => {
      const { grant } = grantFor();
      expect(agyWorkspaceWritePolicy(grant, { deny: [token] })).toEqual({
        state: "composed",
        settings: { permissions: { allow: ["read_file(*)"], deny: ["command(*)"], ask: [] } },
        addedAllow: [],
        addedDeny: ["command(*)"],
      });
    },
  );

  it("forwards specific caller command/run_command/Bash denies cleanly", () => {
    const { grant } = grantFor();
    expect(agyWorkspaceWritePolicy(grant, { deny: ["command(rm -rf *)"] })).toEqual({
      state: "composed",
      settings: {
        permissions: {
          allow: ["read_file(*)", "command(*)"],
          deny: ["command(rm -rf *)"],
          ask: [],
        },
      },
      addedAllow: ["command(*)"],
      addedDeny: ["command(rm -rf *)"],
    });
    expect(agyWorkspaceWritePolicy(grant, { deny: ["run_command(rm -rf *)"] })).toEqual({
      state: "composed",
      settings: {
        permissions: {
          allow: ["read_file(*)", "command(*)"],
          deny: ["command(rm -rf *)"],
          ask: [],
        },
      },
      addedAllow: ["command(*)"],
      addedDeny: ["command(rm -rf *)"],
    });
    expect(agyWorkspaceWritePolicy(grant, { deny: ["Bash(rm -rf *)"] })).toEqual({
      state: "composed",
      settings: {
        permissions: {
          allow: ["read_file(*)"],
          deny: [],
          ask: [],
        },
      },
      addedAllow: [],
      addedDeny: [],
    });
  });

  it("fails closed when profile permissions or rule lists are explicit JSON null", () => {
    const nullPermissions = grantFor(JSON.stringify({ permissions: null }));
    expect(agyWorkspaceWritePolicy(nullPermissions.grant)).toEqual({
      state: "unavailable",
      reason: expect.stringContaining("permissions is not an object"),
    });
    const nullAllow = grantFor(JSON.stringify({ permissions: { allow: null } }));
    expect(agyWorkspaceWritePolicy(nullAllow.grant)).toEqual({
      state: "unavailable",
      reason: expect.stringContaining("permissions.allow is not a list"),
    });
    const nullDeny = grantFor(JSON.stringify({ permissions: { allow: [], deny: null } }));
    expect(agyWorkspaceWritePolicy(nullDeny.grant)).toEqual({
      state: "unavailable",
      reason: expect.stringContaining("deny is not a list of rules"),
    });
  });

  it.each(["command(git *)", "run_command(git *)", "Bash(npm test)"] as const)(
    "honors caller shell narrowing %s without widening to command(*)",
    (allowRule) => {
      const { grant } = grantFor();
      expect(agyWorkspaceWritePolicy(grant, { allow: [allowRule] })).toEqual({
        state: "composed",
        settings: { permissions: { allow: ["read_file(*)"], deny: [], ask: [] } },
        addedAllow: [],
        addedDeny: [],
      });
    },
  );

  it("does not grant command(*) if the profile itself denies all commands", () => {
    const { grant } = grantFor(JSON.stringify({ permissions: { deny: ["command(*)"] } }));
    expect(agyWorkspaceWritePolicy(grant)).toEqual({
      state: "composed",
      settings: { permissions: { allow: ["read_file(*)"], deny: ["command(*)"], ask: [] } },
      addedAllow: [],
      addedDeny: [],
    });
  });

  it("discloses a composed workspace_write policy as one status event", () => {
    expect(agyWorkspaceWritePolicyEvent("s", { allow: ["command(*)"], deny: [] })).toMatchObject({
      type: "status",
      session_id: "s",
      payload: { code: "agy_workspace_write_session_policy", allow: ["command(*)"] },
    });
  });
});
