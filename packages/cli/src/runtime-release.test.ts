import { describe, expect, it } from "vitest";
import {
  checkRuntimeUpdate,
  releaseStats,
  type FetchLike,
  type RuntimeManifest,
} from "./release.js";

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

const MANIFEST: RuntimeManifest = {
  version: "3.4.0",
  sha256: "a".repeat(64),
  minAppVersion: "2.1.0",
  signature: null,
  notes: "shiny new engine",
};

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
    const check = await checkRuntimeUpdate({ fetchImpl, currentVersion: "3.0.0" });
    expect(check.source).toBe("github");
    expect(check.updateAvailable).toBe(true);
    expect(check.latestVersion).toBe("3.4.0");
    expect(check.minAppVersion).toBe("2.1.0");
    expect(check.notes).toBe("shiny new engine");
  });

  it("reports current when the running engine matches the latest manifest", async () => {
    const { fetchImpl } = stubFetch([
      { match: "/releases/latest", respond: latestRelease },
      { match: "runtime-manifest.json", respond: () => jsonResponse(MANIFEST) },
    ]);
    const check = await checkRuntimeUpdate({ fetchImpl, currentVersion: "3.4.0" });
    expect(check.updateAvailable).toBe(false);
    expect(check.source).toBe("github");
  });

  it("never claims an update when the running engine is NEWER than the manifest", async () => {
    const { fetchImpl } = stubFetch([
      { match: "/releases/latest", respond: latestRelease },
      { match: "runtime-manifest.json", respond: () => jsonResponse(MANIFEST) },
    ]);
    const check = await checkRuntimeUpdate({ fetchImpl, currentVersion: "3.9.0" });
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
    const check = await checkRuntimeUpdate({ fetchImpl, currentVersion: "3.0.0" });
    expect(check.source).toBe("unavailable");
    expect(check.detail).toContain("malformed");
  });

  it("survives a network throw and reports it honestly", async () => {
    const fetchImpl = (async () => {
      throw new Error("ENOTFOUND api.github.com");
    }) as FetchLike;
    const check = await checkRuntimeUpdate({ fetchImpl, currentVersion: "3.0.0" });
    expect(check.source).toBe("unavailable");
    expect(check.detail).toContain("ENOTFOUND");
  });
});

describe("releaseStats", () => {
  it("sums GitHub asset downloads and reads the npm last-month point", async () => {
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
    expect(stats.github.totalDownloads).toBe(22);
    expect(stats.github.releases).toBe(2);
    expect(stats.github.perAsset[0]).toEqual({
      name: "claudexor-runtime-3.4.0.tar.gz",
      downloads: 17,
    });
    expect(stats.npm.lastMonth).toBe(123);
  });

  it("reports null per source on failure without fabricating a zero", async () => {
    const { fetchImpl } = stubFetch([
      { match: "/releases?", respond: () => jsonResponse({}, 403) },
      { match: "api.npmjs.org", respond: () => jsonResponse({}, 500) },
    ]);
    const stats = await releaseStats({ fetchImpl });
    expect(stats.github.totalDownloads).toBeNull();
    expect(stats.github.detail).toContain("403");
    expect(stats.npm.lastMonth).toBeNull();
    expect(stats.npm.detail).toContain("500");
  });
});
