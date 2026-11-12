import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { credentialProfileUnpinned, runCapture } from "@claudexor/core";
import {
  ConformanceReport,
  HarnessManifest,
  type CredentialProfileStatus,
} from "@claudexor/schema";
import { Orchestrator } from "./orchestrator.js";

// #363: when a harness's registered rows are not ready, the lane refusal names
// each row with what its probe observed. The default login's doctor advice
// ("run `claudexor auth login …`") never speaks for registered rows, and login
// advice appears only for a row whose probe positively reported logged-out.

const reapDirs: string[] = [];
function reapMk(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  reapDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of reapDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

async function initRepo(): Promise<string> {
  const repo = reapMk("claudexor-row-admission-");
  await runCapture("git", ["-C", repo, "init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  await runCapture("git", ["-C", repo, "add", "-A"]);
  await runCapture("git", [
    "-C",
    repo,
    ...["-c", "user.email=t@t.dev", "-c", "user.name=t"],
    ...["commit", "-m", "init"],
  ]);
  return repo;
}

const DEFAULT_LOGIN_ADVICE =
  "Cursor subscription route is not ready (run `claudexor auth login cursor`)";
const TIMED_OUT = "cursor-agent status did not answer within 10s (SIGKILL); login state unknown";
const LOGGED_OUT = "no Cursor login in the profile HOME (run the profile login)";

const STALE_POSITIVE = `${TIMED_OUT}; the last positive status answer (2026-09-28T19:52:00.000Z, 95000ms old) stands in for unpinned routing only`;
const STALE_LKG = "auth-status probe is stale; using last-known-good login (42ms old)";

type RowState = "ready" | "unknown" | "logged_out" | "stale_positive" | "stale_lkg";

function status(profileId: string, state: RowState): CredentialProfileStatus {
  const base = { profile_id: profileId, harness_id: "stub", verification_source: "local_store" };
  if (state === "ready")
    return {
      ...base,
      availability: "available",
      verification: "passed",
      detail: "login verified",
      last_verified_at: new Date().toISOString(),
    } as CredentialProfileStatus;
  if (state === "stale_positive" || state === "stale_lkg")
    return {
      ...base,
      availability: "unknown",
      verification: "not_run",
      stale: true,
      stale_age_ms: state === "stale_positive" ? 95_000 : 42,
      ...(state === "stale_positive" ? { stale_basis: "last_positive_after_timeout" } : {}),
      detail: state === "stale_positive" ? STALE_POSITIVE : STALE_LKG,
      last_verified_at: null,
    } as CredentialProfileStatus;
  return {
    ...base,
    availability: state === "unknown" ? "unknown" : "unavailable",
    verification: "not_run",
    detail: state === "unknown" ? TIMED_OUT : LOGGED_OUT,
    last_verified_at: null,
  } as CredentialProfileStatus;
}

/** A harness whose DEFAULT route is never ready (Cursor: no host login is
 * used), so only its account rows can admit the lane. */
type ProbeCall = { profileId: string; signal: AbortSignal | undefined; options: unknown };

function stubAdapter(
  rows: Record<string, RowState>,
  spawns: string[],
  unpinned: boolean[],
  probes: ProbeCall[] = [],
): HarnessAdapter {
  const id = "stub";
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "local",
        capabilities: { plan: true, review: true, read_files: true },
        access_profiles_supported: ["readonly"],
      });
    },
    async doctor() {
      return ConformanceReport.parse({
        harness_id: id,
        status: "unavailable",
        reasons: [DEFAULT_LOGIN_ADVICE],
      });
    },
    async probeCredentialProfile(profile, signal, options) {
      probes.push({ profileId: profile.profile_id, signal, options });
      return status(profile.profile_id, rows[profile.profile_id] ?? "unknown");
    },
    async *run(spec) {
      spawns.push(spec.credential_profile?.profile_id ?? "default");
      // The engine's pin fact the adapter's spawn-time route check reads.
      unpinned.push(credentialProfileUnpinned(spec));
      const ts = new Date().toISOString();
      yield { type: "started", session_id: spec.session_id, ts };
      yield { type: "message", session_id: spec.session_id, ts, text: "4" };
      yield { type: "completed", session_id: spec.session_id, ts, payload: { exit_code: 0 } };
    },
  };
}

async function ask(
  rows: Record<string, RowState>,
  registered: string[],
  pin?: string,
  signal?: AbortSignal,
) {
  const configDir = reapMk("claudexor-row-admission-config-");
  const previous = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = configDir;
  writeFileSync(
    join(configDir, "config.yaml"),
    [
      ...(registered.length > 0 ? ["credential_profiles:"] : []),
      ...registered.flatMap((profileId) => [
        `  - profile_id: ${profileId}`,
        "    harness_id: stub",
        `    display_name: ${profileId}`,
        "    credential_kind: config_dir_login",
        `    isolation_locator: ${JSON.stringify(join(configDir, "profiles", `stub-${profileId}`))}`,
      ]),
      "",
    ].join("\n"),
  );
  try {
    const spawns: string[] = [];
    const unpinned: boolean[] = [];
    const probes: ProbeCall[] = [];
    const res = await new Orchestrator({
      registry: new Map([["stub", stubAdapter(rows, spawns, unpinned, probes)]]),
      reviewers: [],
    }).run({
      repoRoot: await initRepo(),
      prompt: "2+2?",
      mode: "ask",
      harnesses: ["stub"],
      ...(pin ? { credentialProfileId: pin } : {}),
      ...(signal ? { signal } : {}),
    });
    return { spawns, unpinned, probes, lifecycle: res.lifecycle, summary: res.summary ?? "" };
  } finally {
    if (previous === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = previous;
  }
}

describe("row admission refusal names observed row states (#363)", () => {
  it("unanswered probes are named unknown, with no login advice from the default route", async () => {
    const res = await ask({ a: "unknown", b: "unknown" }, ["a", "b"]);
    expect(res.lifecycle).toBe("failed");
    expect(res.spawns).toEqual([]);
    expect(res.summary).toContain(`stub has no ready account (a: ${TIMED_OUT}; b: ${TIMED_OUT})`);
    expect(res.summary).not.toContain("auth login");
    expect(res.summary).not.toMatch(/logged out|not signed in/i);
  });

  it("login advice appears only for the row whose probe positively reported logged-out", async () => {
    const res = await ask({ a: "logged_out", b: "unknown" }, ["a", "b"]);
    expect(res.summary).toContain(`a: ${LOGGED_OUT}; b: ${TIMED_OUT}`);
    expect(res.summary).not.toContain("auth login");
  });

  it("a ready row still admits the lane and serves the run", async () => {
    const res = await ask({ a: "unknown", b: "ready" }, ["a", "b"]);
    expect(res.lifecycle).toBe("succeeded");
    expect(res.spawns).toEqual(["b"]);
  });

  it("an explicit pin keeps its strict refusal text", async () => {
    const res = await ask({ a: "unknown", b: "ready" }, ["a", "b"], "a");
    expect(res.lifecycle).toBe("failed");
    expect(res.spawns).toEqual([]);
    expect(res.summary).toContain(`stub credential profile is not ready: ${TIMED_OUT}`);
  });

  it("an unpinned lane is admitted on a timeout's bounded last positive, and the pool picks it (#363)", async () => {
    // `a` sorts first and holds only the generic last-known-good grace, which
    // no unpinned pool consumes; `b` holds the Cursor last positive.
    const res = await ask({ a: "stale_lkg", b: "stale_positive" }, ["a", "b"]);
    expect(res.lifecycle).toBe("succeeded");
    expect(res.spawns).toEqual(["b"]);
    // The spawn is told the pool chose it, so it may start on that answer.
    expect(res.unpinned).toEqual([true]);
  });

  it("the generic last-known-good grace alone still admits no unpinned row", async () => {
    const res = await ask({ a: "stale_lkg", b: "unknown" }, ["a", "b"]);
    expect(res.lifecycle).toBe("failed");
    expect(res.spawns).toEqual([]);
    expect(res.summary).toContain(`stub has no ready account (a: ${STALE_LKG}; b: ${TIMED_OUT})`);
  });

  it("an explicit pin is never admitted on a last positive after a timeout (#363)", async () => {
    const res = await ask({ a: "stale_positive", b: "ready" }, ["a", "b"], "a");
    expect(res.lifecycle).toBe("failed");
    expect(res.spawns).toEqual([]);
    expect(res.summary).toContain(`stub credential profile is not ready: ${STALE_POSITIVE}`);
    // The pin's existing bounded last-known-good grace is untouched.
    const lkg = await ask({ a: "stale_lkg", b: "ready" }, ["a", "b"], "a");
    expect(lkg.lifecycle).toBe("succeeded");
    expect(lkg.spawns).toEqual(["a"]);
  });

  it("each spawn learns whether its row was an explicit pin, never from the profile (#363)", async () => {
    // Identical ready rows: only the run's pin tells the two spawns apart.
    const pinned = await ask({ a: "ready", b: "ready" }, ["a", "b"], "a");
    expect(pinned.spawns).toEqual(["a"]);
    expect(pinned.unpinned).toEqual([false]);
    const pooled = await ask({ a: "ready", b: "ready" }, ["a", "b"]);
    expect(pooled.spawns).toEqual(["a"]);
    expect(pooled.unpinned).toEqual([true]);
  });

  it("the pin's admission probe carries the pin fact and the run's signal; pool probes keep the ordinary wait (#532)", async () => {
    const run = new AbortController();
    const pinned = await ask({ a: "ready", b: "ready" }, ["a", "b"], "a", run.signal);
    expect(pinned.spawns).toEqual(["a"]);
    // Admission asks with the pin fact; a later read reuses that answer.
    expect(pinned.probes[0]?.profileId).toBe("a");
    expect(pinned.probes[0]?.options).toEqual({ pinned: true });
    expect(pinned.probes[0]?.signal).toBe(run.signal);
    const pooled = await ask({ a: "unknown", b: "ready" }, ["a", "b"], undefined, run.signal);
    expect(pooled.spawns).toEqual(["b"]);
    const admission = pooled.probes.filter((call) => call.signal === run.signal);
    expect(admission.map((call) => call.profileId)).toEqual(["a", "b"]);
    expect(admission.every((call) => call.options === undefined)).toBe(true);
  });

  it("a run cancelled during the pin's admission ends cancelled and dispatches nothing (#532)", async () => {
    const run = new AbortController();
    run.abort();
    const res = await ask({ a: "ready" }, ["a"], "a", run.signal);
    expect(res.lifecycle).toBe("cancelled");
    expect(res.spawns).toEqual([]);
  });

  it("with no registered row, the default route's doctor verdict still speaks", async () => {
    const res = await ask({}, []);
    expect(res.lifecycle).toBe("failed");
    expect(res.summary).toContain(DEFAULT_LOGIN_ADVICE);
  });
});
