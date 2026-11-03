import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  QuotaConstraint,
  harnessHasDefaultCredentialStore,
  quotaSnapshotAvailability,
} from "@claudexor/schema";
import { BudgetLedger } from "../../budget/src/ledger.js";
import { parseAgyQuotaEnvelope, refreshAgyQuota } from "./agy-quota-source.js";

const FIXTURES = fileURLToPath(new URL("./__fixtures__", import.meta.url));
const read = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

describe("parseAgyQuotaEnvelope", () => {
  it("maps tier-1 (4 windows) to model-scoped constraints, both groups tagged", () => {
    const out = parseAgyQuotaEnvelope(read("agy-quota-tier1.json"));
    expect(out.kind).toBe("constraints");
    if (out.kind !== "constraints") return;
    // Every constraint validates against the schema.
    for (const c of out.constraints) expect(() => QuotaConstraint.parse(c)).not.toThrow();
    const byId = Object.fromEntries(out.constraints.map((c) => [c.id, c]));
    // remaining_fraction 1.0 -> used_ratio 0; a partial remaining inverts.
    expect(byId["gemini-weekly"].used_ratio).toBe(0);
    // Gemini windows tag only gemini slugs; the 3p group tags claude/gpt slugs.
    expect(byId["gemini-weekly"].applies_to_models).toContain("gemini-3.1-pro-high");
    expect(byId["gemini-weekly"].applies_to_models).not.toContain("claude-opus-4-6-thinking");
    expect(byId["3p-weekly"].applies_to_models).toContain("claude-opus-4-6-thinking");
    // 5h window carries its second budget.
    expect(byId["gemini-5h"].window_seconds).toBe(5 * 60 * 60);
    expect(byId["gemini-weekly"].window_seconds).toBe(7 * 24 * 60 * 60);
    expect(byId["gemini-weekly"].resets_at).toBeTruthy();
    // Which window governs a run that names NO model is not the parser's
    // call: it belongs to the profile's selected model and is stamped by the
    // refresher (see the bare-route suite below), so the envelope carries no
    // guess of its own.
    expect(byId["gemini-weekly"].applies_to_unspecified_model).toBeUndefined();
    expect(byId["3p-weekly"].applies_to_unspecified_model).toBeUndefined();
  });

  it("tolerates a lower tier with NO 5-hour windows (missing window is normal)", () => {
    const out = parseAgyQuotaEnvelope(read("agy-quota-tier2.json"));
    expect(out.kind).toBe("constraints");
    if (out.kind !== "constraints") return;
    const windows = out.constraints.map((c) => c.id);
    expect(windows).toContain("gemini-weekly");
    expect(windows).not.toContain("gemini-5h"); // tier-2 has no 5h window at all
  });

  it("classifies an auth error envelope as auth_revoked, not a snapshot", () => {
    const out = parseAgyQuotaEnvelope(
      JSON.stringify({ status: "ERROR", error: "authentication required. Run agy to log in" }),
    );
    expect(out).toMatchObject({ kind: "auth_revoked" });
  });

  it("classifies a non-auth error as failed", () => {
    const out = parseAgyQuotaEnvelope(JSON.stringify({ status: "ERROR", error: "network down" }));
    expect(out).toMatchObject({ kind: "failed" });
  });

  it("never throws on garbage input", () => {
    expect(parseAgyQuotaEnvelope("not json").kind).toBe("failed");
    expect(parseAgyQuotaEnvelope("{}").kind).toBe("failed");
    expect(parseAgyQuotaEnvelope('{"command":{"data":{"groups":[]}}}').kind).toBe("failed");
  });
});

/**
 * The REFRESHER — the half the first review found untested, which is exactly
 * why a missing PATH (every spawn ENOENT) and a `close`-instead-of-`exit` wait
 * (a wedged descendant hanging the daemon's whole quota cycle) both shipped
 * unnoticed. Every case here drives the real function against a FAKE `agy`
 * script: no vendor binary is ever spawned, so no test can trigger a login.
 */
describe("refreshAgyQuota", () => {
  const roots: string[] = [];
  const originalConfig = process.env.CLAUDEXOR_CONFIG_DIR;

  afterEach(() => {
    if (originalConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = originalConfig;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

  const refresh = (options: Parameters<typeof refreshAgyQuota>[0] = {}) =>
    refreshAgyQuota({ prepareProfileKeychain: () => undefined, ...options });

  /** A config dir with one enabled agy profile, plus a fake `agy` on disk. */
  function scaffold(options: { token: boolean; script: string }): { bin: string } {
    const root = mkdtempSync(join(tmpdir(), "claudexor-agy-quota-"));
    roots.push(root);
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    const home = join(root, "profiles", "agy-prof-a");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    if (options.token)
      writeFileSync(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "t", {
        mode: 0o600,
      });
    writeFileSync(
      join(root, "config.yaml"),
      [
        "version: 1",
        "credential_profiles:",
        "  - profile_id: prof-a",
        "    harness_id: agy",
        "    display_name: A",
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${home}`,
        "    enabled: true",
        "",
      ].join("\n"),
    );
    const bin = join(root, "fake-agy");
    writeFileSync(bin, options.script);
    chmodSync(bin, 0o755);
    return { bin };
  }

  const MODEL_ENVELOPE = (id: string) =>
    JSON.stringify({ status: "SUCCESS", command: { name: "model", data: { id } } });

  const ENVELOPE = JSON.stringify({
    status: "SUCCESS",
    command: {
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              { id: "gemini-weekly", name: "Weekly", window: "weekly", remaining_fraction: 0.25 },
            ],
          },
        ],
      },
    },
  });

  it("spawns the vendor with a usable PATH and maps its envelope to a snapshot", async () => {
    // The fake resolves `node` itself: proof the child inherited a real PATH.
    const { bin } = scaffold({
      token: true,
      script: `#!/bin/sh\ncommand -v node >/dev/null || { echo '{"status":"ERROR","error":"no PATH"}'; exit 0; }\ncase "$2" in\n"/model") cat <<'JSON'\n${MODEL_ENVELOPE("gemini-3.7-flash-high")}\nJSON\n;;\n*) cat <<'JSON'\n${ENVELOPE}\nJSON\n;;\nesac\n`,
    });
    const out = await refresh({ bin });
    expect(out.absences ?? []).toEqual([]);
    expect(out.snapshots).toHaveLength(1);
    expect(out.snapshots[0]).toMatchObject({
      subject: { harness: "agy", credential_route: "vendor_native", subject_id: "prof-a" },
      source: "agy_command_usage",
    });
    expect(out.snapshots[0].constraints[0]).toMatchObject({
      id: "gemini-weekly",
      used_ratio: 0.75,
    });
  });

  it("keeps an unrecognized group's window as a diagnostic receipt, not a constraint (#394)", async () => {
    const envelope = JSON.stringify({
      status: "SUCCESS",
      command: {
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [{ id: "gemini-weekly", window: "weekly", remaining_fraction: 0.25 }],
            },
            {
              name: "Mystery Models",
              buckets: [{ id: "mystery-weekly", window: "weekly", remaining_fraction: 0 }],
            },
          ],
        },
      },
    });
    const { bin } = scaffold({
      token: true,
      script: `#!/bin/sh
case "$2" in
"/model") printf '%s\n' '${MODEL_ENVELOPE("gemini-3.7-flash-high")}' ;;
*) printf '%s\n' '${envelope}' ;;
esac
`,
    });
    const receipts: Array<{ outcome: string; reason?: string }> = [];
    const out = await refresh({ bin, diagnostic: (record) => receipts.push(record) });
    expect(out.snapshots[0]?.constraints.map((constraint) => constraint.id)).toEqual([
      "gemini-weekly",
    ]);
    expect(receipts.find((record) => record.outcome === "succeeded")?.reason).toBe(
      "unknown_scope=mystery-weekly group=Mystery Models used=100% resets=unknown",
    );
  });

  it("an unknown-only quota envelope is a typed absence with its receipt, never an empty fresh reading", async () => {
    const envelope = JSON.stringify({
      status: "SUCCESS",
      command: {
        data: {
          groups: [
            {
              name: "Mystery Models",
              buckets: [
                {
                  id: "mystery-weekly",
                  window: "weekly",
                  remaining_fraction: 0.1,
                  reset_time: "2026-07-20T00:00:00Z",
                },
              ],
            },
          ],
        },
      },
    });
    const { bin } = scaffold({
      token: true,
      script: `#!/bin/sh
case "$2" in
"/model") printf '%s\n' '${MODEL_ENVELOPE("gemini-3.7-flash-high")}' ;;
*) printf '%s\n' '${envelope}' ;;
esac
`,
    });
    const receipts: Array<{ outcome: string; reason?: string }> = [];
    const out = await refresh({ bin, diagnostic: (record) => receipts.push(record) });
    expect(out.snapshots).toEqual([]);
    expect(out.absences?.[0]).toMatchObject({
      reason: "refresh_failed",
      detail: expect.stringContaining("unknown model scope"),
    });
    const receipt = receipts.find((record) => record.outcome === "failed")?.reason ?? "";
    expect(receipt).toMatch(
      /^refresh_failed; unknown_scope=mystery-weekly group=Mystery Models used=90% resets=/,
    );
  });

  it("prepares the profile before each quota child", async () => {
    const { bin } = scaffold({
      token: true,
      script: `#!/bin/sh
case "$2" in
"/model") printf '%s\n' '${MODEL_ENVELOPE("gemini-3.7-flash-high")}' ;;
*) printf '%s\n' '${ENVELOPE}' ;;
esac
`,
    });
    let preparations = 0;
    const out = await refresh({
      bin,
      prepareProfileKeychain: () => {
        preparations += 1;
      },
    });
    expect(out.absences ?? []).toEqual([]);
    expect(out.snapshots).toHaveLength(1);
    expect(preparations).toBe(2);
  });

  it("uses the vendor as the auth oracle when no token file exists", async () => {
    const { bin } = scaffold({
      token: false,
      script: `#!/bin/sh
touch "$0.spawned"
case "$2" in
"/model") printf '%s\n' '${MODEL_ENVELOPE("gemini-3.7-flash-high")}' ;;
*) cat <<'JSON'
${ENVELOPE}
JSON
;;
esac
`,
    });
    const out = await refresh({ bin });
    expect(out.absences ?? []).toEqual([]);
    expect(out.snapshots).toHaveLength(1);
    expect(readFileSync(`${bin}.spawned`, "utf8")).toBe("");
  });

  it("reports an unspawnable binary as a typed absence instead of throwing", async () => {
    const { bin } = scaffold({ token: true, script: "#!/bin/sh\n" });
    const out = await refresh({ bin: `${bin}-does-not-exist` });
    expect(out.snapshots).toEqual([]);
    expect(out.absences?.[0]).toMatchObject({ reason: "refresh_failed" });
  });

  it("resolves even when a surviving descendant holds the stdout pipe open", async () => {
    // The exact wedge the review reproduced: the child exits, a grandchild
    // keeps the pipe. Waiting on `close` would hang here forever and stall the
    // daemon's whole quota cycle; waiting on `exit` returns.
    const { bin } = scaffold({
      token: true,
      script: `#!/bin/sh\nsleep 30 &\ncat <<'JSON'\n${ENVELOPE}\nJSON\nexit 0\n`,
    });
    const out = await Promise.race([
      refresh({ bin }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("wedged")), 10_000)),
    ]);
    expect((out as { snapshots: unknown[] }).snapshots).toHaveLength(1);
  }, 15_000);

  it("classifies the vendor's auth envelope as auth_revoked, not a failure", async () => {
    const { bin } = scaffold({
      token: true,
      script: `#!/bin/sh\necho '{"status":"ERROR","error":"authentication required. Run agy to log in"}'\n`,
    });
    const out = await refresh({ bin });
    expect(out.absences?.[0]).toMatchObject({ reason: "auth_revoked" });
  });

  it.each(["authentication service network unavailable", "authentication failed or timed out"])(
    "does not classify %s as logout",
    async (error) => {
      const { bin } = scaffold({
        token: false,
        script: `#!/bin/sh\necho '${JSON.stringify({ status: "ERROR", error })}'\nexit 1\n`,
      });
      const out = await refresh({ bin });
      expect(out.absences?.[0]).toMatchObject({ reason: "refresh_failed" });
    },
  );

  it("bounds the profile fan-out to 3 concurrent vendor probes", async () => {
    // Several accounts stay the point of the feature, but a large registry
    // must not turn one refresh cycle into an unthrottled vendor burst: the
    // probe pool holds at most 3 candidates in flight. The fake vendor logs
    // start/end instants; unbounded Promise.all would overlap all 5.
    const root = mkdtempSync(join(tmpdir(), "claudexor-agy-bounded-"));
    roots.push(root);
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    const rows: string[] = [];
    for (const id of ["a", "b", "c", "d", "e"]) {
      const home = join(root, "profiles", `agy-prof-${id}`);
      mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
      rows.push(
        `  - profile_id: prof-${id}`,
        "    harness_id: agy",
        `    display_name: ${id.toUpperCase()}`,
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${home}`,
        "    enabled: true",
      );
    }
    writeFileSync(
      join(root, "config.yaml"),
      ["version: 1", "credential_profiles:", ...rows, ""].join("\n"),
    );
    const log = join(root, "probe-log.txt");
    const probe = join(root, "probe.cjs");
    writeFileSync(
      probe,
      [
        'const fs = require("node:fs");',
        `const log = ${JSON.stringify(log)};`,
        "fs.appendFileSync(log, `S ${Date.now()}\\n`);",
        "setTimeout(() => {",
        "  fs.appendFileSync(log, `E ${Date.now()}\\n`);",
        '  process.stdout.write(JSON.stringify({ status: "ERROR", error: "slow fake vendor" }));',
        "}, 300);",
      ].join("\n"),
    );
    const bin = join(root, "fake-agy");
    writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(probe)}\n`);
    chmodSync(bin, 0o755);

    const out = await refresh({ bin });
    // Every candidate still resolves (typed absences; the ERROR envelope is a
    // refresh failure, and a failed /quota never spawns /model).
    expect(out.snapshots).toEqual([]);
    expect(out.absences?.map((absence) => absence.reason)).toEqual(
      Array.from({ length: 5 }, () => "refresh_failed"),
    );
    const events = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const [kind, at] = line.split(" ");
        return { kind, at: Number(at) };
      })
      .sort((a, b) => a.at - b.at || (a.kind === "E" ? -1 : 1));
    let inFlight = 0;
    let maxInFlight = 0;
    for (const event of events) {
      inFlight += event.kind === "S" ? 1 : -1;
      maxInFlight = Math.max(maxInFlight, inFlight);
    }
    expect(events).toHaveLength(10);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("fails loudly on ambiguous Windows rows with one absence per subject and zero vendor calls", async () => {
    const { bin } = scaffold({
      token: false,
      script: '#!/bin/sh\ntouch "$0.spawned"\n',
    });
    const root = process.env.CLAUDEXOR_CONFIG_DIR!;
    const secondHome = join(root, "profiles", "agy-prof-b");
    mkdirSync(secondHome, { recursive: true });
    writeFileSync(
      join(root, "config.yaml"),
      [
        "version: 1",
        "credential_profiles:",
        "  - profile_id: prof-a",
        "    harness_id: agy",
        "    display_name: A",
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${join(root, "profiles", "agy-prof-a")}`,
        "    enabled: true",
        "  - profile_id: prof-b",
        "    harness_id: agy",
        "    display_name: B",
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${secondHome}`,
        "    enabled: true",
        "",
      ].join("\n"),
    );
    const out = await refresh({ bin, platform: "win32" });
    expect(out.snapshots).toEqual([]);
    expect(out.absences?.map((item) => [item.subject.subject_id, item.reason]).sort()).toEqual([
      ["prof-a", "credential_profile_ambiguous"],
      ["prof-b", "credential_profile_ambiguous"],
    ]);
    expect(existsSync(`${bin}.spawned`)).toBe(false);
  });

  it("never probes a disabled agy row", async () => {
    const { bin } = scaffold({
      token: false,
      script: '#!/bin/sh\ntouch "$0.spawned"\n',
    });
    const root = process.env.CLAUDEXOR_CONFIG_DIR!;
    const yaml = readFileSync(join(root, "config.yaml"), "utf8").replace(
      "    enabled: true",
      "    enabled: false",
    );
    writeFileSync(join(root, "config.yaml"), yaml);
    const out = await refresh({ bin, platform: "win32" });
    expect(out).toEqual({ snapshots: [], absences: [] });
    expect(existsSync(`${bin}.spawned`)).toBe(false);
  });
});

describe("harnessHasDefaultCredentialStore (Л-4: agy has no default store)", () => {
  it("keeps a default subject for the harnesses that have one and denies agy", () => {
    expect(harnessHasDefaultCredentialStore("claude")).toBe(true);
    expect(harnessHasDefaultCredentialStore("codex")).toBe(true);
    expect(harnessHasDefaultCredentialStore("agy")).toBe(false);
  });
});

describe("parseAgyQuotaEnvelope hostile shapes (review Ф2 #3)", () => {
  const envelope = (bucket: unknown) =>
    JSON.stringify({
      status: "SUCCESS",
      command: { data: { groups: [{ name: "Gemini Models", buckets: [bucket] }] } },
    });

  it("drops only the unparseable window, never the whole account batch", () => {
    // A blank id/label and a garbage reset stamp all used to produce a
    // constraint the daemon rejected — taking every other window with it.
    for (const bucket of [
      { id: "", name: "", window: "weekly", remaining_fraction: 0.5 },
      { id: "x", name: "y", window: "weekly", reset_time: "not-a-date" },
      { id: "x", name: "y", window: "__proto__" },
      {},
      null,
    ]) {
      const out = parseAgyQuotaEnvelope(envelope(bucket));
      if (out.kind !== "constraints") continue;
      for (const c of out.constraints) expect(() => QuotaConstraint.parse(c)).not.toThrow();
    }
  });

  it("never resolves a window length from Object.prototype", () => {
    const out = parseAgyQuotaEnvelope(envelope({ id: "x", name: "y", window: "toString" }));
    expect(out.kind).toBe("constraints");
    if (out.kind !== "constraints") return;
    expect(out.constraints[0].window_seconds).toBeNull();
  });

  it("leaves the object prototype untouched for a __proto__ bucket key", () => {
    parseAgyQuotaEnvelope(
      JSON.stringify({
        status: "SUCCESS",
        command: {
          data: {
            groups: [
              { name: "Gemini Models", buckets: [JSON.parse('{"__proto__":{"polluted":1}}')] },
            ],
          },
        },
      }),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

/**
 * Which window governs a run that NAMES NO MODEL. Every agy window is
 * model-scoped, so without this stamp an exhausted account can never refuse a
 * bare run and Л-2 rotation never fires; stamping the wrong group is just as
 * wrong in the other direction, so the source follows the profile's SELECTED
 * model rather than an assumption about it.
 */
describe("refreshAgyQuota bare-route scoping", () => {
  const roots: string[] = [];
  const originalConfig = process.env.CLAUDEXOR_CONFIG_DIR;
  afterEach(() => {
    if (originalConfig === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = originalConfig;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

  const refresh = (options: Parameters<typeof refreshAgyQuota>[0] = {}) =>
    refreshAgyQuota({ prepareProfileKeychain: () => undefined, ...options });

  function scaffoldWithModel(selected: string | null): { bin: string } {
    const root = mkdtempSync(join(tmpdir(), "claudexor-agy-scope-"));
    roots.push(root);
    process.env.CLAUDEXOR_CONFIG_DIR = root;
    const home = join(root, "profiles", "agy-prof-a");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "t", {
      mode: 0o600,
    });
    writeFileSync(
      join(root, "config.yaml"),
      [
        "version: 1",
        "credential_profiles:",
        "  - profile_id: prof-a",
        "    harness_id: agy",
        "    display_name: A",
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${home}`,
        "    enabled: true",
        "",
      ].join("\n"),
    );
    const quota = JSON.stringify({
      status: "SUCCESS",
      command: {
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                { id: "gemini-weekly", name: "W", window: "weekly", remaining_fraction: 0 },
              ],
            },
            {
              name: "Claude and GPT models",
              buckets: [{ id: "3p-weekly", name: "W", window: "weekly", remaining_fraction: 1 }],
            },
          ],
        },
      },
    });
    const model =
      selected === null
        ? '{"status":"ERROR","error":"no model"}'
        : JSON.stringify({ status: "SUCCESS", command: { name: "model", data: { id: selected } } });
    const bin = join(root, "fake-agy");
    writeFileSync(
      bin,
      `#!/bin/sh\ncase "$2" in\n"/model") echo '${model}' ;;\n*) cat <<'JSON'\n${quota}\nJSON\n;;\nesac\n`,
    );
    chmodSync(bin, 0o755);
    return { bin };
  }

  const flags = async (selected: string | null): Promise<Record<string, boolean | undefined>> => {
    const out = await refresh({ bin: scaffoldWithModel(selected).bin });
    return Object.fromEntries(
      out.snapshots[0]!.constraints.map((c) => [c.id, c.applies_to_unspecified_model]),
    );
  };

  it("follows the profile's selected model, in both directions", async () => {
    expect(await flags("gemini-3.7-flash-high")).toEqual({
      "gemini-weekly": true,
      "3p-weekly": false,
    });
    // A user who selected a third-party slug must be refused on THAT budget,
    // and must not rotate accounts because the Gemini budget ran out.
    expect(await flags("claude-opus-4-6-thinking")).toEqual({
      "gemini-weekly": false,
      "3p-weekly": true,
    });
  });

  it("falls back to the Gemini group when the vendor will not say", async () => {
    expect(await flags(null)).toEqual({ "gemini-weekly": true, "3p-weekly": false });
  });

  it("follows known vendor families and leaves a truly unknown model unverified", async () => {
    expect(await flags("gemini-4.0-flash-high")).toEqual({
      "gemini-weekly": true,
      "3p-weekly": false,
    });
    expect(await flags("claude-opus-5-5-high")).toEqual({
      "gemini-weekly": false,
      "3p-weekly": true,
    });
    expect(await flags("claude-new-model-high")).toEqual({
      "gemini-weekly": false,
      "3p-weekly": true,
    });
    // Neither window is evidence about an entirely unknown vendor family.
    expect(await flags("some-future-vendor-model")).toEqual({
      "gemini-weekly": false,
      "3p-weekly": false,
    });
  });
});

describe("AGY group scope across quota consumers", () => {
  it("keeps future Claude IDs bound to their spent group in display and budget", () => {
    const now = new Date("2026-10-04T00:00:00Z");
    const reset = "2026-10-05T00:00:00Z";
    const parsed = parseAgyQuotaEnvelope(
      JSON.stringify({
        status: "SUCCESS",
        command: {
          data: {
            groups: [
              {
                name: "Gemini Models",
                buckets: [
                  {
                    id: "gemini",
                    name: "Weekly",
                    remaining_fraction: 1,
                    window: "weekly",
                    reset_time: reset,
                  },
                ],
              },
              {
                name: "Claude and GPT models",
                buckets: [
                  {
                    id: "third-party",
                    name: "Weekly",
                    remaining_fraction: 0,
                    window: "weekly",
                    reset_time: reset,
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    expect(parsed.kind).toBe("constraints");
    if (parsed.kind !== "constraints") return;
    const snapshot = {
      subject: {
        harness: "agy",
        credential_route: "vendor_native" as const,
        subject_id: "account-a",
        plan_label: null,
      },
      constraints: parsed.constraints,
      source: "agy_command_usage" as const,
      observed_at: now.toISOString(),
      freshness: "fresh" as const,
    };
    const ledger = new BudgetLedger();
    ledger.observeQuotaSnapshot(snapshot);
    for (const model of ["claude-opus-5-5-high", "claude-future-high", "gpt-future"]) {
      expect(quotaSnapshotAvailability(snapshot, { now, model }).state).toBe("exhausted");
      expect(ledger.cooldownActive("agy", "vendor_native", "account-a", +now, model)).toBe(true);
      expect(ledger.cooldownActive("agy", "vendor_native", "account-b", +now, model)).toBe(false);
    }
    for (const model of [
      "gemini-3.8-flash-high",
      "gemini-future-high",
      "some-future-vendor-model",
    ]) {
      expect(quotaSnapshotAvailability(snapshot, { now, model }).state).toBe("available");
      expect(ledger.cooldownActive("agy", "vendor_native", "account-a", +now, model)).toBe(false);
    }
    expect(
      ledger.bindingPaceSlack(
        "agy",
        "vendor_native",
        "account-a",
        +now,
        "some-future-vendor-model",
      ),
    ).toBeNull();
    expect(quotaSnapshotAvailability(snapshot, { now }).model_scoped_exhaustions[0]).toMatchObject({
      applies_to_model_prefixes: ["claude-", "gpt-"],
    });
  });
});
