import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@claudexor/config";
import { DaemonControlApiServer } from "@claudexor/control-api";
import { noProjectRepoRoot } from "@claudexor/util";
import { parseArgs } from "./args.js";
import {
  accountsCommandWithDeps,
  profilesCommand,
  profilesCommandWithDeps,
} from "./credential-commands.js";
import { removeProfileFromRegistry } from "./profile-registration.js";

// `profiles add` is the ONLY subcommand that does not talk to the daemon —
// it writes the durable registry through the locked global-config owner. The
// test drives it against a scoped CLAUDEXOR_CONFIG_DIR (the hermetic root).
describe("claudexor profiles add (INV-135)", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-profiles-add-"));
    prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  }, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

  it("registers a config_dir_login profile through the locked global-config owner", async () => {
    const code = await profilesCommand(parseArgs(["profiles", "add", "claude", "work"]), true);
    expect(code).toBe(0);
    const config = loadConfig(noProjectRepoRoot()).global.credential_profiles;
    expect(config).toHaveLength(1);
    expect(config[0]).toMatchObject({
      profile_id: "work",
      harness_id: "claude",
      credential_kind: "config_dir_login",
      enabled: true,
    });
    // The locator lives under the confinement root (the scoped config dir).
    expect(config[0]?.isolation_locator).toContain(dir);
    expect(config[0]?.isolation_locator).toContain("claude-work");
  });

  it("appends without clobbering an existing registry entry", async () => {
    await profilesCommand(parseArgs(["profiles", "add", "claude", "a"]), true);
    await profilesCommand(parseArgs(["profiles", "add", "codex", "b"]), true);
    await profilesCommand(parseArgs(["profiles", "add", "cursor", "c"]), true);
    const ids = loadConfig(noProjectRepoRoot()).global.credential_profiles.map(
      (p) => `${p.harness_id}/${p.profile_id}`,
    );
    expect(ids).toEqual(["claude/a", "codex/b", "cursor/c"]);
  });

  it("refuses a duplicate (harness, profile) id loudly, leaving the registry intact", async () => {
    await profilesCommand(parseArgs(["profiles", "add", "claude", "work"]), true);
    const code = await profilesCommand(parseArgs(["profiles", "add", "claude", "work"]), true);
    expect(code).not.toBe(0);
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toHaveLength(1);
  });

  it("refuses a harness without config-dir profiles and a malformed id", async () => {
    expect(await profilesCommand(parseArgs(["profiles", "add", "opencode", "x"]), true)).not.toBe(
      0,
    );
    expect(
      await profilesCommand(parseArgs(["profiles", "add", "claude", "Bad Id"]), true),
    ).not.toBe(0);
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toHaveLength(0);
  });

  it("labels the new profile with --display-name, on either side of the operands (#570)", async () => {
    expect(
      await profilesCommand(
        parseArgs(["profiles", "add", "claude", "work", "--display-name", "Work laptop"]),
        true,
      ),
    ).toBe(0);
    expect(
      await profilesCommand(
        parseArgs(["profiles", "add", "--display-name", "Spare", "codex", "spare"]),
        true,
      ),
    ).toBe(0);
    const rows = loadConfig(noProjectRepoRoot()).global.credential_profiles;
    expect(rows.map((row) => [row.harness_id, row.profile_id, row.display_name])).toEqual([
      ["claude", "work", "Work laptop"],
      ["codex", "spare", "Spare"],
    ]);
  });
});

/** The real rollback route and request schema on a loopback server (#570): it
 * records what each command actually asks the daemon to reverse. Ephemeral
 * port, never a real daemon or migration. */
async function withRollbackDaemon<T>(
  fn: (
    ensureDaemon: () => Promise<{ addr: { baseUrl: string; token: string } }>,
    bodies: unknown[],
  ) => Promise<T>,
): Promise<T> {
  const bodies: unknown[] = [];
  const token = "profile-rollback-fixture";
  const server = new DaemonControlApiServer({
    token,
    daemon: {
      enqueue: async () => ({ id: "unused", state: "queued" }),
      status: async (id: string) => ({ id, state: "failed" }),
      list: async () => [],
      cancel: async () => ({ cancelled: true }),
    } as never,
    services: {
      rollbackAccountsMigration: async (input: unknown) => {
        bodies.push(input);
        return { rolledBack: [] };
      },
    },
  });
  const { host, port } = await server.start();
  try {
    return await fn(async () => ({ addr: { baseUrl: `http://${host}:${port}`, token } }), bodies);
  } finally {
    await server.stop();
  }
}

describe("claudexor profiles verb flags and the rollback operand (#570)", () => {
  // A regression must fail here and never start a daemon: external ownership
  // makes the real ensureDaemon attach-only, and this hermetic root has none.
  beforeEach(() => vi.stubEnv("CLAUDEXOR_DAEMON_OWNER", "external"));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const captureStreams = () => {
    const output = { stdout: "", stderr: "" };
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      output.stdout += String(chunk);
      return true;
    }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      output.stderr += String(chunk);
      return true;
    }) as never);
    return output;
  };

  it.each<[string, string[], object]>([
    ["one harness", ["codex"], { harnessId: "codex" }],
    ["every migrated harness when the operand is absent", [], {}],
  ])("asks the daemon to reverse %s", async (_scope, operands, body) => {
    const output = captureStreams();
    await withRollbackDaemon(async (ensureDaemon, bodies) => {
      const code = await profilesCommandWithDeps(
        parseArgs(["profiles", "rollback-migration", ...operands, "--json"]),
        true,
        { ensureDaemon },
      );
      expect(code).toBe(0);
      expect(bodies).toEqual([body]);
    });
    expect(JSON.parse(output.stdout)).toEqual({ rolledBack: [] });
  });

  it.each([
    ["empty", ""],
    ["spaces", "   "],
    ["tab", "\t"],
    ["newline", "\n"],
  ])("refuses an explicit operand of %s before reaching the daemon", async (_kind, operand) => {
    const output = captureStreams();
    const ensureDaemon = vi.fn();
    const code = await profilesCommandWithDeps(
      parseArgs(["profiles", "rollback-migration", operand, "--json"]),
      true,
      { ensureDaemon },
    );
    expect(code).toBe(2);
    expect(ensureDaemon).not.toHaveBeenCalled();
    expect(JSON.parse(output.stdout)).toMatchObject({
      ok: false,
      exitCode: 2,
      code: "invalid_argument",
    });
    expect(output.stdout).toContain("rollback-migration [harness]");
  });

  it("keeps the refusal of an empty operand on stderr in human mode", async () => {
    const output = captureStreams();
    const ensureDaemon = vi.fn();
    const code = await profilesCommandWithDeps(
      parseArgs(["profiles", "rollback-migration", ""]),
      false,
      { ensureDaemon },
    );
    expect(code).toBe(2);
    expect(ensureDaemon).not.toHaveBeenCalled();
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain("rollback-migration [harness]");
  });

  it.each<[string, string[]]>([
    // The value flag would eat the harness and leave an all-harness request.
    ["rollback-migration", ["rollback-migration", "--display-name", "codex"]],
    ["rollback-migration", ["rollback-migration", "codex", "--display-name", "x"]],
    // A bare `profiles` means `list`.
    ["list", ["--display-name", "x"]],
    ["list", ["list", "--display-name", "x"]],
    ["login", ["login", "claude", "work", "--display-name", "x"]],
    ["enable", ["enable", "claude", "work", "--display-name", "x"]],
    ["disable", ["disable", "claude", "work", "--display-name", "x"]],
    ["remove", ["remove", "claude", "work", "--display-name", "x"]],
    ["rm", ["rm", "claude", "work", "--display-name", "x"]],
  ])("refuses --display-name where `%s` would ignore it: %j", async (verb, rest) => {
    const output = captureStreams();
    const deps = { daemonGet: vi.fn(), ensureDaemon: vi.fn(), spawnSync: vi.fn() };
    const code = await profilesCommandWithDeps(
      parseArgs(["profiles", ...rest, "--json"]),
      true,
      deps,
    );
    expect(code).toBe(2);
    expect(JSON.parse(output.stdout).message).toContain(
      `\`claudexor profiles ${verb}\`: --display-name`,
    );
    for (const dep of Object.values(deps)) expect(dep).not.toHaveBeenCalled();
  });
});

type ScriptedJobState = "waiting_for_input" | "running" | "succeeded" | "failed" | "cancelled";

/** A loopback control server whose setup-job services follow a scripted
 * job (#363): create answers the sealed client_pty job, every status read
 * advances the script, cancel terminalizes it. Ephemeral port, never a real
 * daemon, no runner or vendor. */
async function withScriptedSetupDaemon<T>(
  script: {
    afterCreate: ScriptedJobState[];
    onCancel?: ScriptedJobState;
    harness?: "cursor" | "grok";
  },
  fn: (
    ensureDaemon: () => Promise<{ addr: { baseUrl: string; token: string } }>,
    calls: string[],
    requests: unknown[],
  ) => Promise<T>,
): Promise<T> {
  const calls: string[] = [];
  const harness = script.harness ?? "cursor";
  const requests: unknown[] = [];
  const steps = [...script.afterCreate];
  let state: ScriptedJobState = "waiting_for_input";
  const job = () => {
    const terminal = !["waiting_for_input", "running"].includes(state);
    return {
      jobId: "setup-scripted-1",
      harness,
      action: "login",
      transport: "client_pty",
      state,
      phase: terminal ? "completed" : state === "running" ? "verifying" : "launching",
      command: "cursor-agent login",
      guideUrl: "https://docs.cursor.com/en/cli/reference/authentication",
      message: `scripted ${state}`,
      createdAt: "2026-09-30T00:00:00.000Z",
      startedAt: "2026-09-30T00:00:00.000Z",
      finishedAt: terminal ? "2026-09-30T00:00:01.000Z" : null,
      profileId: "work",
      authCapability: {
        attemptId: "attempt-scripted",
        challengeDigest: "d".repeat(64),
        requestDigest: "e".repeat(64),
        disclosure: {
          schemaVersion: 1,
          protocolVersion: 1,
          harness,
          requested: "subscription",
          requiredRoute: "vendor_native",
          requiredSource: "native_session",
          networkScope: "selected_harness_only",
          billingKnowledge: "unknown",
          incrementalCostKnowledge: "unknown",
          mayConsumeQuota: true,
          generatedAt: "2026-09-30T00:00:00.000Z",
        },
        state: "disclosed",
      },
      ...(terminal
        ? {
            outcome: {
              reason:
                state === "succeeded"
                  ? "completed"
                  : state === "cancelled"
                    ? "cancelled_by_user"
                    : "command_failed",
            },
          }
        : {}),
    };
  };
  const token = "profile-login-setup-fixture";
  const server = new DaemonControlApiServer({
    token,
    daemon: {
      enqueue: async () => ({ id: "unused", state: "queued" }),
      status: async (id: string) => ({ id, state: "failed" }),
      list: async () => [],
      cancel: async () => ({ cancelled: true }),
    } as never,
    services: {
      createSetupJob: async (input: { request: unknown }) => {
        calls.push("create");
        requests.push(input.request);
        return job();
      },
      setupJobStatus: async () => {
        calls.push("status");
        state = steps.shift() ?? state;
        return job();
      },
      cancelSetupJob: async () => {
        calls.push("cancel");
        state = script.onCancel ?? "cancelled";
        return job();
      },
    },
  });
  const { host, port } = await server.start();
  try {
    return await fn(
      async () => ({ addr: { baseUrl: `http://${host}:${port}`, token } }),
      calls,
      requests,
    );
  } finally {
    await server.stop();
  }
}

describe("claudexor profiles login machine output", () => {
  afterEach(() => vi.restoreAllMocks());

  const row = (harness: string, id: string) => ({
    profile: {
      profile_id: id,
      harness_id: harness,
      display_name: id,
      credential_kind: "config_dir_login",
      isolation_locator: `/tmp/${harness}-${id}`,
      secret_ref: null,
      enabled: true,
      created_at: null,
    },
    status: {
      profile_id: id,
      harness_id: harness,
      availability: "unknown",
      verification: "not_run",
    },
    identity: null,
  });

  it.each(["cursor", "claude", "agy"])(
    "preserves %s --json refusal without creating or attaching a login job",
    async (harness) => {
      let stdout = "";
      const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
        stdout += String(chunk);
        return true;
      }) as never);
      const ensureDaemon = vi.fn();
      const attach = vi.fn();
      const spawnSync = vi.fn();
      const code = await profilesCommandWithDeps(
        parseArgs(["profiles", "login", harness, "work", "--json"]),
        true,
        {
          daemonGet: async () => ({
            profiles: [row(harness, "work")],
            harnessAccounts: [],
            accountPools: [],
          }),
          ensureDaemon,
          attach,
          spawnSync,
        },
      );
      expect(code).toBe(2);
      expect(ensureDaemon).not.toHaveBeenCalled();
      expect(attach).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledOnce();
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, exitCode: 2 });
      expect(JSON.parse(stdout).message).toContain("does not support --json");
      expect(JSON.parse(stdout)).not.toHaveProperty("job");
    },
  );

  it.each([true, false])(
    "returns the typed ambiguous policy before output/spawn (json=%s)",
    async (json) => {
      let stdout = "";
      let stderr = "";
      vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
        stdout += String(chunk);
        return true;
      }) as never);
      vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
        stderr += String(chunk);
        return true;
      }) as never);
      const ensureDaemon = vi.fn();
      const listing = {
        profiles: [row("agy", "one"), row("agy", "two")],
        harnessAccounts: [],
        accountPools: [],
      };
      const code = await profilesCommandWithDeps(
        parseArgs(["profiles", "login", "agy", "one", ...(json ? ["--json"] : [])]),
        json,
        { daemonGet: async () => listing, ensureDaemon, platform: "win32" },
      );

      expect(code).toBe(1);
      // Refused before any daemon job, attachment or vendor process.
      expect(ensureDaemon).not.toHaveBeenCalled();
      if (json) {
        expect(stderr).toBe("");
        expect(JSON.parse(stdout)).toMatchObject({
          ok: false,
          code: "credential_profile_ambiguous",
          requiredActions: ["disable_extra_profiles"],
          context: {
            harnessId: "agy",
            platform: "win32",
            maxEnabledProfiles: 1,
            enabledProfileCount: 2,
          },
        });
      } else {
        expect(stdout).toBe("");
        expect(stderr).toContain("disable extra profiles before continuing");
      }
    },
  );

  it("prepares an agy profile before the direct vendor login spawn", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-agy-login-"));
    const previous = process.env.CLAUDEXOR_CONFIG_DIR;
    const previousBin = process.env.CLAUDEXOR_AGY_BIN;
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    const fakeAgy = join(root, "agy");
    writeFileSync(fakeAgy, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeAgy, 0o755);
    process.env.CLAUDEXOR_AGY_BIN = fakeAgy;
    const locator = join(root, "profiles", "agy-work");
    mkdirSync(locator, { recursive: true, mode: 0o700 });
    const agyRow = row("agy", "work");
    const listing = {
      profiles: [{ ...agyRow, profile: { ...agyRow.profile, isolation_locator: locator } }],
      harnessAccounts: [],
      accountPools: [],
    };
    const order: string[] = [];
    const spawnSync = vi.fn(() => {
      order.push("spawn");
      return { status: 0, signal: null, stdout: "", stderr: "" } as never;
    });
    const prepare = vi.fn((home: string) => {
      expect(home).toBe(realpathSync(locator));
      expect(order).toEqual([]);
      order.push("prepare");
    });
    let gets = 0;
    try {
      const code = await profilesCommandWithDeps(
        parseArgs(["profiles", "login", "agy", "work"]),
        false,
        {
          daemonGet: async () => {
            gets += 1;
            return gets === 1
              ? listing
              : {
                  ...listing,
                  profiles: [
                    {
                      ...listing.profiles[0],
                      status: {
                        profile_id: "work",
                        harness_id: "agy",
                        availability: "available",
                        verification: "passed",
                      },
                    },
                  ],
                };
          },
          spawnSync,
          prepareAgyProfileKeychain: prepare,
        },
      );
      expect(code).toBe(0);
      expect(order).toEqual(["prepare", "spawn"]);
      expect(prepare).toHaveBeenCalledOnce();
      expect(spawnSync).toHaveBeenCalledOnce();
      // Interactive sign-in stays visible in THIS terminal; only background
      // helpers hide their Windows console.
      const [, , loginOptions] = spawnSync.mock.calls[0] as unknown as [string, string[], object];
      expect(loginOptions).toMatchObject({ stdio: "inherit" });
      expect(loginOptions).not.toHaveProperty("windowsHide");
    } finally {
      if (previous === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = previous;
      if (previousBin === undefined) delete process.env.CLAUDEXOR_AGY_BIN;
      else process.env.CLAUDEXOR_AGY_BIN = previousBin;
      rmSync(root, { recursive: true, force: true });
    }
  });

  const loginDeps = (
    ensureDaemon: () => Promise<{ addr: { baseUrl: string; token: string } }>,
    order: string[],
    options: { receipt: boolean; interruptDuringAttach?: boolean; harness?: "cursor" | "grok" },
  ) => {
    let interrupt: (() => void) | null = null;
    return {
      daemonGet: async () => {
        order.push("get");
        return {
          profiles: [row(options.harness ?? "cursor", "work")],
          harnessAccounts: [],
          accountPools: [],
        };
      },
      ensureDaemon,
      attach: async (_addr: unknown, jobId: string) => {
        order.push(`attach ${jobId}`);
        // The terminal's Ctrl-C reaches this client (and the attached runner).
        if (options.interruptDuringAttach) interrupt?.();
        return 0;
      },
      receiptExists: () => options.receipt,
      onInterrupt: (handler: () => void) => {
        interrupt = handler;
        return () => {
          order.push("unsubscribe");
          interrupt = null;
        };
      },
      pollMs: 1,
    };
  };

  it("Grok profile login uses managed completion and re-reads fresh account status", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const order: string[] = [];
    await withScriptedSetupDaemon(
      { harness: "grok", afterCreate: ["running", "succeeded"] },
      async (ensureDaemon, calls, requests) => {
        expect(
          await profilesCommandWithDeps(
            parseArgs(["profiles", "login", "grok", "work"]),
            false,
            loginDeps(ensureDaemon, order, { receipt: true, harness: "grok" }),
          ),
        ).toBe(0);
        expect(calls).toEqual(["create", "status", "status"]);
        expect(requests).toEqual([
          {
            harness: "grok",
            action: "login",
            authRequest: "subscription",
            profileId: "work",
            transport: "client_pty",
          },
        ]);
        expect(order).toEqual(["get", "attach setup-scripted-1", "unsubscribe", "get"]);
      },
    );
  });

  it.each([
    ["succeeded", 0],
    ["failed", 1],
  ] as const)(
    "attaches this terminal, then reports the daemon's durable %s outcome (#363)",
    async (outcome, exitCode) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const order: string[] = [];
      await withScriptedSetupDaemon(
        { afterCreate: ["running", outcome] },
        async (ensureDaemon, calls, requests) => {
          const code = await profilesCommandWithDeps(
            parseArgs(["profiles", "login", "cursor", "work"]),
            false,
            loginDeps(ensureDaemon, order, { receipt: true }),
          );
          expect(code).toBe(exitCode);
          // The vendor's own receipt exists: nothing is cancelled, the durable
          // job is followed to its end and only then is the row re-read.
          expect(calls).toEqual(["create", "status", "status"]);
          expect(requests).toEqual([
            {
              harness: "cursor",
              action: "login",
              authRequest: "subscription",
              profileId: "work",
              transport: "client_pty",
            },
          ]);
        },
      );
      expect(order).toEqual(["get", "attach setup-scripted-1", "unsubscribe", "get"]);
    },
  );

  it("turns Ctrl-C into a daemon-side cancel and exits 130 after the job's proven end (#363)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const order: string[] = [];
    await withScriptedSetupDaemon({ afterCreate: [] }, async (ensureDaemon, calls) => {
      const code = await profilesCommandWithDeps(
        parseArgs(["profiles", "login", "cursor", "work"]),
        false,
        loginDeps(ensureDaemon, order, { receipt: false, interruptDuringAttach: true }),
      );
      expect(code).toBe(130);
      expect(calls).toEqual(["create", "cancel", "status"]);
    });
  });

  it("cancels a job whose terminal attachment ended without the vendor's receipt (#363)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const order: string[] = [];
    await withScriptedSetupDaemon({ afterCreate: [] }, async (ensureDaemon, calls) => {
      const code = await profilesCommandWithDeps(
        parseArgs(["profiles", "login", "cursor", "work"]),
        false,
        loginDeps(ensureDaemon, order, { receipt: false }),
      );
      expect(code).toBe(1);
      expect(calls).toEqual(["create", "cancel", "status"]);
    });
  });

  it("leaves the job to the daemon when this terminal could not attach (#363)", async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await withScriptedSetupDaemon({ afterCreate: [] }, async (ensureDaemon, calls) => {
      const code = await profilesCommandWithDeps(
        parseArgs(["profiles", "login", "cursor", "work"]),
        false,
        {
          ...loginDeps(ensureDaemon, [], { receipt: false }),
          attach: async () => {
            throw new Error("setup job already has a client_pty attachment");
          },
        },
      );
      expect(code).toBe(1);
      // Another terminal owns the attachment: no cancel from here.
      expect(calls).toEqual(["create"]);
    });
    expect(stderr.join("")).toContain("setup job already has a client_pty attachment");
  });
});

describe("claudexor accounts snapshot (read-only agent doorway)", () => {
  afterEach(() => vi.restoreAllMocks());

  const snapshot = {
    profiles: [
      {
        profile: {
          profile_id: "work",
          harness_id: "claude",
          display_name: "work",
          credential_kind: "config_dir_login",
          isolation_locator: "/tmp/claudexor-review-profile",
        },
        status: {
          profile_id: "work",
          harness_id: "claude",
          availability: "available",
          verification: "passed",
        },
        identity: null,
      },
    ],
    harnesses: [{ id: "claude", status: "ok" }],
    git: { status: "available", version: null, detail: null, remediation: null },
    quota: { snapshots: [], refreshed_at: null },
    quotaEventCursor: "q-1",
    accountPools: [{ harness_id: "claude", next_up: { kind: "profile", profileId: "work" } }],
  };

  it("prints the daemon-owned snapshot in JSON without probing or mutating", async () => {
    let stdout = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as never);
    const evidence = { refusals: [], lastService: [] };
    const get = vi.fn(async (path: string) =>
      path === "/accounts/routing-evidence?includeCapabilities=true&includeCredentialUnusable=true"
        ? evidence
        : snapshot,
    );

    const code = await accountsCommandWithDeps(
      parseArgs(["accounts", "snapshot", "--json"]),
      true,
      { daemonGet: get },
    );

    expect(code).toBe(0);
    // Two reads, no probe or mutation: the snapshot and the additive evidence.
    expect(get.mock.calls.map(([path]) => path)).toEqual([
      "/credential-profiles?snapshot=true",
      "/accounts/routing-evidence?includeCapabilities=true&includeCredentialUnusable=true",
    ]);
    expect(JSON.parse(stdout)).toMatchObject({
      quotaEventCursor: "q-1",
      routingEvidence: evidence,
    });
    expect(write).toHaveBeenCalledOnce();
  });

  it("rejects an unknown positional without contacting the daemon", async () => {
    const get = vi.fn(async () => snapshot);
    const code = await accountsCommandWithDeps(parseArgs(["accounts", "other", "--json"]), true, {
      daemonGet: get,
    });
    expect(code).toBe(2);
    expect(get).not.toHaveBeenCalled();
  });

  it("names only the paused account while preserving a healthy next-up account", async () => {
    let stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    }) as never);
    const code = await accountsCommandWithDeps(parseArgs(["accounts"]), false, {
      daemonGet: async (path: string) =>
        path ===
        "/accounts/routing-evidence?includeCapabilities=true&includeCredentialUnusable=true"
          ? { refusals: [], lastService: [] }
          : {
              ...snapshot,
              quota: {
                ...snapshot.quota,
                refresh_skipped: [
                  {
                    vendor: "claude",
                    not_before: "2026-10-04T15:00:00Z",
                    subject: {
                      harness: "claude",
                      subject_id: "limited",
                      credential_route: "vendor_native",
                      plan_label: null,
                    },
                  },
                ],
              },
            },
    });
    expect(code).toBe(0);
    expect(stdout).toContain("quota refresh skipped for claude/limited (vendor_native):");
    expect(stdout).toContain("next up (default model) claude: work");
    expect(stdout).not.toContain("quota refresh skipped for claude/work");
    expect(stdout).not.toContain("routing evidence unavailable");
  });
});

describe("removeProfileFromRegistry (INV-135 removal owner)", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-profiles-remove-"));
    prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  }, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

  it("removes exactly the named entry and returns it", async () => {
    await profilesCommand(parseArgs(["profiles", "add", "claude", "work"]), true);
    await profilesCommand(parseArgs(["profiles", "add", "codex", "work"]), true);
    const removed = removeProfileFromRegistry("claude", "work");
    expect(removed).toMatchObject({ harness_id: "claude", profile_id: "work" });
    const left = loadConfig(noProjectRepoRoot()).global.credential_profiles;
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ harness_id: "codex", profile_id: "work" });
  });

  it("refuses an unknown id with a typed 404, leaving the registry intact", async () => {
    await profilesCommand(parseArgs(["profiles", "add", "claude", "work"]), true);
    expect(() => removeProfileFromRegistry("claude", "ghost")).toThrow(/no credential profile/);
    try {
      removeProfileFromRegistry("codex", "work");
      expect.unreachable("cross-harness removal must refuse");
    } catch (err) {
      expect((err as { status?: number }).status).toBe(404);
    }
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toHaveLength(1);
  });
});
