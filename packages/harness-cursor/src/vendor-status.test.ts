import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialProfile } from "@claudexor/schema";
import { probeCursorNativeAuth, type CursorStatusObservation } from "./auth.js";
import { clearCursorStatusCache, createCursorAdapter } from "./index.js";
import { createCursorStatusCoordinator, CURSOR_STATUS_REUSE_MS } from "./status-cache.js";

const roots: string[] = [];
afterEach(() => {
  clearCursorStatusCache();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

function profileRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cursor-proof-")));
  roots.push(root);
  vi.stubEnv("CLAUDEXOR_CONFIG_DIR", root);
  vi.stubEnv("CLAUDEXOR_CURSOR_BIN", process.execPath);
  const profile = (id: string): CredentialProfile => {
    const home = join(root, "profiles", id);
    mkdirSync(home, { recursive: true });
    return {
      profile_id: id,
      harness_id: "cursor",
      display_name: id,
      credential_kind: "config_dir_login",
      isolation_locator: home,
      secret_ref: null,
      enabled: true,
      created_at: "2026-10-01T00:00:00Z",
    };
  };
  return { root, profile };
}

// Native gatherStatusInfo catches ANY getMe failure and still reports the true
// token booleans. Only its successful server branch includes typed userInfo.
const localFallback = {
  status: "authenticated",
  isAuthenticated: true,
  hasAccessToken: true,
  hasRefreshToken: true,
};
const vendor = { ...localFallback, userInfo: { userId: 123, email: "fixture@example.test" } };

describe("Cursor status preserves server proof independently of local login", () => {
  it.each([
    { userInfo: { userId: 123 }, verified: true },
    { userInfo: { userId: 0 }, verified: true },
    { userInfo: { email: "fixture@example.test" }, verified: true },
    { userInfo: null, verified: false },
    { userInfo: [], verified: false },
    { userInfo: {}, verified: false },
    { userInfo: { userId: "123" }, verified: false },
    { userInfo: { unrelated: true }, verified: false },
  ])("only recognized server fields establish proof: $userInfo", async ({ userInfo, verified }) => {
    const { root } = profileRoot();
    const result = await probeCursorNativeAuth(
      { HOME: root, AGENT_CLI_CREDENTIAL_STORE: "file" },
      undefined,
      async () => ({
        code: 0,
        signal: null,
        stdout: JSON.stringify({ ...localFallback, userInfo }),
        stderr: "",
      }),
    );
    expect(result.kind).toBe("authenticated");
    expect(result).toMatchObject(
      verified ? { vendorAuthenticated: true } : { kind: "authenticated" },
    );
    if (!verified) expect(result).not.toHaveProperty("vendorAuthenticated");
    expect(result).not.toHaveProperty("userInfo");
  });

  it("never upgrades boolean fallback, logout or an unsuccessful process", async () => {
    const { root } = profileRoot();
    for (const [body, code, kind] of [
      [localFallback, 0, "authenticated"],
      [{ ...vendor, isAuthenticated: false }, 0, "loggedOut"],
      [vendor, 1, "unknown"],
    ] as const) {
      const result = await probeCursorNativeAuth(
        { HOME: root, AGENT_CLI_CREDENTIAL_STORE: "file" },
        undefined,
        async () => ({ code, signal: null, stdout: JSON.stringify(body), stderr: "" }),
      );
      expect(result.kind).toBe(kind);
      expect(result).not.toHaveProperty("vendorAuthenticated");
    }
  });

  it.skipIf(process.platform === "win32")(
    "the real profile-scoped adapter reads server proof and token fallback from separate fake CLI stores",
    async () => {
      const { root, profile } = profileRoot();
      const a = profile("a"),
        b = profile("b");
      writeFileSync(join(a.isolation_locator!, "status-fixture.json"), JSON.stringify(vendor));
      writeFileSync(
        join(b.isolation_locator!, "status-fixture.json"),
        JSON.stringify(localFallback),
      );
      const bin = join(root, "cursor-agent");
      writeFileSync(
        bin,
        `#!/usr/bin/env node\nif (process.argv.includes("--version")) { console.log("2026.11.10-abc123"); process.exit(0); }\nconst fs = require('node:fs'); const path = require('node:path');
const home = process.env.HOME;
fs.appendFileSync(path.join(home,'status-calls.jsonl'), JSON.stringify({argv:process.argv.slice(2),HOME:home,USERPROFILE:process.env.USERPROFILE,XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME,APPDATA:process.env.APPDATA,store:process.env.AGENT_CLI_CREDENTIAL_STORE,hasKey:Boolean(process.env.CURSOR_API_KEY)})+'\\n');
process.stdout.write(fs.readFileSync(path.join(home,'status-fixture.json'),'utf8'));
`,
      );
      chmodSync(bin, 0o755);
      vi.stubEnv("CLAUDEXOR_CURSOR_BIN", bin);
      vi.stubEnv("CURSOR_API_KEY", "synthetic-unused-key");
      clearCursorStatusCache();
      const adapter = createCursorAdapter(); // default probe and default coordinator
      const first = await adapter.probeCredentialAccount!(a);
      const cached = await adapter.probeCredentialAccount!(a);
      const fallback = await adapter.probeCredentialAccount!(b);
      expect(first.status).toMatchObject({
        profile_id: "a",
        availability: "available",
        verification: "passed",
        verification_source: "vendor",
      });
      expect(first.identity).toMatchObject({ email: "fixture@example.test" });
      expect(cached.status).toEqual(first.status);
      expect(fallback.status).toMatchObject({
        profile_id: "b",
        availability: "available",
        verification: "passed",
        verification_source: "local_store",
      });
      expect(fallback.identity).toBeNull();
      for (const row of [a, b]) {
        const calls = readFileSync(join(row.isolation_locator!, "status-calls.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          argv: ["--disable-auto-update", "status", "--format", "json"],
          store: "file",
          hasKey: false,
        });
        for (const field of ["HOME", "USERPROFILE"])
          expect(resolve(calls[0][field])).toBe(resolve(row.isolation_locator!));
        expect(resolve(calls[0].XDG_CONFIG_HOME)).toBe(resolve(row.isolation_locator!, ".config"));
        expect(resolve(calls[0].APPDATA)).toBe(
          resolve(row.isolation_locator!, "AppData", "Roaming"),
        );
      }
      // Feed the actual producer into ordinary account routing. Only the server
      // proof admits this Cursor row at finite zero; token-only fallback does not.
      const { Orchestrator } = await import("../../orchestrator/src/orchestrator.js");
      const { HarnessManifest, ConformanceReport } = await import("@claudexor/schema");
      writeFileSync(
        join(root, "config.yaml"),
        JSON.stringify({ routing: { paid_fallback: "never" }, credential_profiles: [a, b] }),
      );
      const sent: string[] = [];
      adapter.discover = async () =>
        HarnessManifest.parse({
          id: "cursor",
          display_name: "Fixture",
          kind: "local_cli",
          provider_family: "cursor",
          capabilities: { read_files: true },
          access_profiles_supported: ["readonly"],
        });
      adapter.doctor = async () =>
        ConformanceReport.parse({
          harness_id: "cursor",
          status: "ok",
          enabled_intents: ["explain"],
          auth_sources: [],
        });
      adapter.run = async function* (spec) {
        sent.push(spec.credential_profile!.profile_id);
        const common = { session_id: spec.session_id, ts: new Date().toISOString() };
        yield { ...common, type: "started", credential_route: "vendor_native" };
        yield {
          ...common,
          type: "usage",
          usage: { cost_usd: 0, cost_basis: { kind: "cash", source: "fixture" } },
        };
        yield { ...common, type: "message", text: "OK", final: true };
        yield { ...common, type: "completed" };
      };
      for (const row of [a, b]) {
        const result = await new Orchestrator({
          registry: new Map([["cursor", adapter]]),
          reviewers: [],
        }).run({
          repoRoot: root,
          prompt: "hello",
          mode: "ask",
          harnesses: ["cursor"],
          credentialProfileId: row.profile_id,
          paidBudget: { kind: "finite", maxUsd: 0 },
          web: "auto",
        });
        expect(result.lifecycle, result.summary).toBe(
          row.profile_id === "a" ? "succeeded" : "failed",
        );
      }
      expect(sent).toEqual(["a"]);
    },
  );

  it("cached server proof keeps its timestamp, but stale readiness never becomes current vendor proof", async () => {
    const { profile } = profileRoot();
    const a = profile("a"),
      b = profile("b");
    let now = Date.parse("2026-10-01T00:00:00Z");
    let next: CursorStatusObservation = {
      kind: "authenticated",
      vendorAuthenticated: true,
      email: "a@example.test",
    };
    const coordinator = createCursorStatusCoordinator({
      probe: async () => next,
      monotonicMs: () => now,
      wallMs: () => now,
      mutating: () => false,
    });
    const adapter = createCursorAdapter({ nativeAuthOk: coordinator.status });
    const first = await adapter.probeCredentialAccount!(a);
    now += 1;
    expect((await adapter.probeCredentialAccount!(a)).status).toEqual(first.status);
    next = { kind: "unknown", error: "fixture timeout", timedOut: true };
    now += CURSOR_STATUS_REUSE_MS;
    const stale = await adapter.probeCredentialAccount!(a);
    expect(stale.status).toMatchObject({
      availability: "unknown",
      verification: "not_run",
      verification_source: "local_store",
      stale: true,
    });
    expect(stale.identity).toBeNull();
    expect((await adapter.probeCredentialAccount!(b)).status.stale).not.toBe(true);
    coordinator.clear();
    expect((await adapter.probeCredentialAccount!(a)).status.stale).not.toBe(true);
  });

  it("a server answer from an invalidated credential generation cannot restore vendor proof", async () => {
    const { profile } = profileRoot();
    const a = profile("a");
    let finish!: (value: CursorStatusObservation) => void;
    let calls = 0;
    const coordinator = createCursorStatusCoordinator({
      probe: () =>
        ++calls === 1
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : Promise.resolve({ kind: "authenticated" }),
      mutating: () => false,
    });
    const adapter = createCursorAdapter({ nativeAuthOk: coordinator.status });
    const pending = adapter.probeCredentialAccount!(a);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    coordinator.clear();
    finish({ kind: "authenticated", vendorAuthenticated: true, email: "old@example.test" });
    expect((await pending).status).toMatchObject({
      availability: "unknown",
      verification: "not_run",
      verification_source: "local_store",
    });
    const fresh = await adapter.probeCredentialAccount!(a);
    expect(fresh.status).toMatchObject({
      availability: "available",
      verification: "passed",
      verification_source: "local_store",
    });
    expect(fresh.identity).toBeNull();
    expect(calls).toBe(2);
  });
});
