import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTINUITY_PROFILE_LOCATOR_ENV, type HarnessContinuityCapability } from "@claudexor/core";
import type { CredentialProfile, SessionCapsule } from "@claudexor/schema";
import {
  readSessionCapsule,
  registryProfile,
  relocateSessionCapsule,
  sessionCapsulePath,
  storeEnvFor,
  writeSessionCapsule,
} from "./session-capsule.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function capsule(over: Partial<SessionCapsule> = {}): SessionCapsule {
  return {
    harness: "claude",
    nativeSessionId: "sid-1",
    holderProfileId: "a",
    file: null,
    mtimeMs: null,
    sidecars: [],
    cwd: "/work",
    requestedModel: "m",
    ...over,
  };
}

describe("session capsule", () => {
  it("writes one durable record per attempt and reads it back", () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-capsule-"));
    roots.push(dir);
    const attemptDir = join(dir, "attempts", "a01");
    expect(readSessionCapsule(attemptDir)).toBeNull();
    writeSessionCapsule(attemptDir, capsule());
    expect(JSON.parse(readFileSync(sessionCapsulePath(attemptDir), "utf8"))).toMatchObject({
      nativeSessionId: "sid-1",
      holderProfileId: "a",
    });
    expect(readSessionCapsule(attemptDir)).toEqual(capsule());
    // A torn/invalid file reads as "no capsule" rather than throwing.
    writeFileSync(sessionCapsulePath(attemptDir), "{not json");
    expect(readSessionCapsule(attemptDir)).toBeNull();
  });

  it("names the profile store with the one neutral locator key", () => {
    const row = {
      profile_id: "a",
      harness_id: "claude",
      display_name: "a",
      credential_kind: "config_dir_login",
      isolation_locator: "/stores/a",
      secret_ref: null,
      enabled: true,
      created_at: null,
    } satisfies CredentialProfile;
    expect(storeEnvFor({ HOME: "/h" }, row)).toEqual({
      HOME: "/h",
      [CONTINUITY_PROFILE_LOCATOR_ENV]: "/stores/a",
    });
    // The engine default store carries no locator key at all.
    expect(storeEnvFor({ HOME: "/h" }, null)).toEqual({ HOME: "/h" });
    expect(registryProfile([row], "a", "claude")).toBe(row);
    expect(registryProfile([row], "zz", "claude")).toBeNull();
    expect(registryProfile([row], null, "claude")).toBeNull();
  });

  it.each([false, true])(
    "keeps history lookup harness-scoped regardless of registry order (%s)",
    (reverse) => {
      const rows: CredentialProfile[] = ["claude", "codex", "future-harness"].map((harness_id) => ({
        profile_id: "shared",
        harness_id,
        display_name: "shared",
        credential_kind: "config_dir_login",
        isolation_locator: `/stores/${harness_id}-shared`,
        secret_ref: null,
        // A disabled source can still hold the history a healthy account must resume.
        enabled: false,
        created_at: null,
      }));
      const registry = reverse ? [...rows].reverse() : rows;
      for (const row of rows) {
        expect(registryProfile(registry, "shared", row.harness_id)).toBe(row);
      }
      expect(registryProfile([rows[1]!], "shared", "claude")).toBeNull();
      expect(registryProfile(registry, null, "claude")).toBeNull();
    },
  );

  it("relocates the holder through the adapter and keeps the capsule on a miss", async () => {
    const located: HarnessContinuityCapability = {
      async locate(ref, env) {
        expect(ref).toEqual({ nativeSessionId: "sid-1", cwd: "/work" });
        expect(env[CONTINUITY_PROFILE_LOCATOR_ENV]).toBe("/stores/a");
        return {
          found: true,
          file: "/stores/a/projects/x/sid-1.jsonl",
          mtimeMs: 5,
          sidecars: ["/s"],
        };
      },
      async move() {
        return { ok: false, reason: "unused" };
      },
    };
    const hit = await relocateSessionCapsule(capsule(), located, {
      [CONTINUITY_PROFILE_LOCATOR_ENV]: "/stores/a",
    });
    expect(hit.located).toBe(true);
    expect(hit.capsule).toMatchObject({
      file: "/stores/a/projects/x/sid-1.jsonl",
      mtimeMs: 5,
      sidecars: ["/s"],
    });
    const miss = await relocateSessionCapsule(
      capsule({ file: "/old" }),
      {
        ...located,
        async locate() {
          return { found: false };
        },
      },
      {},
    );
    expect(miss).toEqual({ capsule: capsule({ file: "/old" }), located: false });
    const thrown = await relocateSessionCapsule(
      capsule(),
      {
        ...located,
        async locate() {
          throw new Error("boom");
        },
      },
      {},
    );
    expect(thrown.located).toBe(false);
    // No continuity capability: nothing to locate, the id comparison guards the resume.
    expect(await relocateSessionCapsule(capsule(), undefined, {})).toEqual({
      capsule: capsule(),
      located: null,
    });
  });
});
