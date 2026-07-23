import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeUpdateAuthority } from "@claudexor/util";
import { checkRuntimeUpdate, releaseStats, type FetchLike } from "./release.js";

const fixtureDir = resolve(
  import.meta.dirname,
  "../../../apps/macos/ClaudexorKit/Tests/ClaudexorKitTests/Fixtures/runtime-update",
);
// The signed test vector (TS-signed with the fixed TEST key) and its authority.
const TEST_AUTHORITY = JSON.parse(
  readFileSync(resolve(fixtureDir, "authority.json"), "utf8"),
) as RuntimeUpdateAuthority;
const SIGNED_MANIFEST = JSON.parse(
  readFileSync(resolve(fixtureDir, "valid-manifest.json"), "utf8"),
);

/** A minimal Response-like stub for the injected fetch. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Route stub: map a URL substring to a Response (or a thrown error). */
function stubFetch(routes: { match: string; respond: () => Response }[]): {
  fetchImpl: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (input: Parameters<FetchLike>[0]) => {
    const url = String(input);
    calls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return route.respond();
  }) as FetchLike;
  return { fetchImpl, calls };
}

// The signed fixture is the trusted manifest; tests inject its TEST authority.
const MANIFEST = SIGNED_MANIFEST;

const latestRelease = (assetName = "runtime-manifest.json") =>
  jsonResponse({
    assets: [
      { name: assetName, browser_download_url: "https://example/download/runtime-manifest.json" },
      { name: "claudexor-runtime-3.4.0.tar.gz", browser_download_url: "https://example/tar" },
    ],
  });

describe("checkRuntimeUpdate", () => {
  it("reports an available update when the manifest is newer than the running engine", async () => {
    const { fetchImpl } = stubFetch([
      { match: "/releases/latest", respond: latestRelease },
      { match: "runtime-manifest.json", respond: () => jsonResponse(MANIFEST) },
    ]);
    const check = await checkRuntimeUpdate({
      fetchImpl,
      currentVersion: "3.0.0",
      authority: TEST_AUTHORITY,
    });
    expect(check.source).toBe("github");
    expect(check.updateAvailable).toBe(true);
    expect(check.latestVersion).toBe("3.4.0");
    expect(check.minAppVersion).toBe("2.1.0");
    expect(check.notes).toBe(SIGNED_MANIFEST.notes);
  });

  it("reports current when the running engine matches the latest manifest", async () => {
    const { fetchImpl } = stubFetch([
      { match: "/releases/latest", respond: latestRelease },
      { match: "runtime-manifest.json", respond: () => jsonResponse(MANIFEST) },
    ]);
    const check = await checkRuntimeUpdate({
      fetchImpl,
      currentVersion: "3.4.0",
      authority: TEST_AUTHORITY,
    });
    expect(check.updateAvailable).toBe(false);
    expect(check.source).toBe("github");
  });

  it("never claims an update when the running engine is NEWER than the manifest", async () => {
    const { fetchImpl } = stubFetch([
      { match: "/releases/latest", respond: latestRelease },
      { match: "runtime-manifest.json", respond: () => jsonResponse(MANIFEST) },
    ]);
    const check = await checkRuntimeUpdate({
      fetchImpl,
      currentVersion: "3.9.0",
      authority: TEST_AUTHORITY,
    });
    expect(check.updateAvailable).toBe(false);
  });

  it("degrades to unavailable (not a false verdict) when GitHub errors", async () => {
    const { fetchImpl } = stubFetch([
      { match: "/releases/latest", respond: () => jsonResponse({}, 503) },
    ]);
    const check = await checkRuntimeUpdate({ fetchImpl, currentVersion: "3.0.0" });
    expect(check.source).toBe("unavailable");
    expect(check.updateAvailable).toBe(false);
    expect(check.latestVersion).toBeNull();
    expect(check.detail).toContain("503");
  });

  it("degrades to unavailable when the release has no runtime-manifest asset yet", async () => {
    const { fetchImpl } = stubFetch([
      { match: "/releases/latest", respond: () => latestRelease("some-other-asset.txt") },
    ]);
    const check = await checkRuntimeUpdate({ fetchImpl, currentVersion: "3.0.0" });
    expect(check.source).toBe("unavailable");
    expect(check.detail).toContain("no runtime-manifest.json");
  });

  it("rejects a malformed manifest (bad sha256) as unavailable", async () => {
    const { fetchImpl } = stubFetch([
      { match: "/releases/latest", respond: latestRelease },
      {
        match: "runtime-manifest.json",
        respond: () => jsonResponse({ ...MANIFEST, sha256: "not-a-digest" }),
      },
    ]);
    const check = await checkRuntimeUpdate({
      fetchImpl,
      currentVersion: "3.0.0",
      authority: TEST_AUTHORITY,
    });
    expect(check.source).toBe("unavailable");
    // Fail-closed: a mutated field breaks both the shape and the signature.
    expect(check.detail.toLowerCase()).toContain("check failed");
  });

  it("REFUSES a tampered manifest whose signature no longer matches (D-2 fail-closed)", async () => {
    const tampered = { ...MANIFEST, notes: "attacker-swapped release notes" };
    const { fetchImpl } = stubFetch([
      { match: "/releases/latest", respond: latestRelease },
      { match: "runtime-manifest.json", respond: () => jsonResponse(tampered) },
    ]);
    const check = await checkRuntimeUpdate({
      fetchImpl,
      currentVersion: "3.0.0",
      authority: TEST_AUTHORITY,
    });
    expect(check.source).toBe("unavailable");
    expect(check.updateAvailable).toBe(false);
    expect(check.detail).toContain("signature is invalid");
  });

  it("REFUSES a manifest signed by an unknown key (D-2 fail-closed)", async () => {
    const { fetchImpl } = stubFetch([
      { match: "/releases/latest", respond: latestRelease },
      { match: "runtime-manifest.json", respond: () => jsonResponse(MANIFEST) },
    ]);
    // Verify against the PRODUCTION authority (default) — the fixture is signed
    // by the TEST key, so the keyId does not match the pinned authority.
    const check = await checkRuntimeUpdate({ fetchImpl, currentVersion: "3.0.0" });
    expect(check.source).toBe("unavailable");
    expect(check.updateAvailable).toBe(false);
    expect(check.detail).toContain("pinned runtime-update authority");
  });

  it("survives a network throw and reports it honestly", async () => {
    const fetchImpl = (async () => {
      throw new Error("ENOTFOUND api.github.com");
    }) as FetchLike;
    const check = await checkRuntimeUpdate({ fetchImpl, currentVersion: "3.0.0" });
    expect(check.source).toBe("unavailable");
    expect(check.detail).toContain("ENOTFOUND");
  });

  // QA-033a: the update decision must compare the RUNNING engine (handshake),
  // never relabel the executing CLI package as the running engine.
  it("uses the handshake running-engine version, not the CLI package (QA-033a)", async () => {
    const { fetchImpl } = stubFetch([
      { match: "/releases/latest", respond: latestRelease },
      { match: "runtime-manifest.json", respond: () => jsonResponse(MANIFEST) },
    ]);
    const check = await checkRuntimeUpdate({
      fetchImpl,
      runningEngineVersion: "3.0.3",
      authority: TEST_AUTHORITY,
    });
    expect(check.runningEngineVersion).toBe("3.0.3");
    expect(check.runningEngineSource).toBe("handshake");
    expect(check.updateAvailable).toBe(true);
    expect(check.detail).toContain("running 3.0.3");
  });

  // QA-033a/#3: an unreachable daemon leaves the running engine UNKNOWN — the
  // check must not silently substitute the CLI version nor say "running ... is
  // current".
  it("reports an unknown running engine and honest copy when no daemon is reachable", async () => {
    const { fetchImpl } = stubFetch([
      { match: "/releases/latest", respond: latestRelease },
      { match: "runtime-manifest.json", respond: () => jsonResponse(MANIFEST) },
    ]);
    const check = await checkRuntimeUpdate({
      fetchImpl,
      runningEngineVersion: null,
      authority: TEST_AUTHORITY,
    });
    expect(check.runningEngineVersion).toBeNull();
    expect(check.runningEngineSource).toBe("unavailable");
    // Never the false-negative "running <v> is current" the CLI-version relabel produced.
    expect(check.detail).not.toContain("is current");
    expect(check.detail.toLowerCase()).toContain("engine not running");
    // cliVersion is always the executing package constant, never relabelled.
    expect(typeof check.cliVersion).toBe("string");
  });
});

describe("releaseStats", () => {
  it("reports the app-installer allowlist sum plus the raw all-asset total", async () => {
    const { fetchImpl } = stubFetch([
      {
        match: "/releases?",
        respond: () =>
          jsonResponse([
            {
              assets: [
                { name: "claudexor-runtime-3.4.0.tar.gz", download_count: 10 },
                { name: "Claudexor-3.4.0.dmg", download_count: 5 },
              ],
            },
            { assets: [{ name: "claudexor-runtime-3.4.0.tar.gz", download_count: 7 }] },
          ]),
      },
      { match: "api.npmjs.org", respond: () => jsonResponse({ downloads: 123 }) },
    ]);
    const stats = await releaseStats({ fetchImpl });
    // The honest install count is the DMG/ZIP allowlist only (5), while the raw
    // all-asset total (17 runtime tarball + 5 dmg = 22) stays as a diagnostic.
    expect(stats.github.appInstallerDownloads).toBe(5);
    expect(stats.github.totalDownloads).toBe(22);
    expect(stats.github.releases).toBe(2);
    // perAsset is the raw all-asset breakdown, each row tagged by policy.
    expect(stats.github.perAsset[0]).toEqual({
      name: "claudexor-runtime-3.4.0.tar.gz",
      downloads: 17,
      appInstaller: false,
    });
    expect(stats.github.perAsset).toContainEqual({
      name: "Claudexor-3.4.0.dmg",
      downloads: 5,
      appInstaller: true,
    });
    expect(stats.npm.lastMonth).toBe(123);
  });

  it("reports null per source on failure without fabricating a zero", async () => {
    const { fetchImpl } = stubFetch([
      { match: "/releases?", respond: () => jsonResponse({}, 403) },
      { match: "api.npmjs.org", respond: () => jsonResponse({}, 500) },
    ]);
    const stats = await releaseStats({ fetchImpl });
    expect(stats.github.appInstallerDownloads).toBeNull();
    expect(stats.github.totalDownloads).toBeNull();
    expect(stats.github.detail).toContain("403");
    expect(stats.npm.lastMonth).toBeNull();
    expect(stats.npm.detail).toContain("500");
  });
});
