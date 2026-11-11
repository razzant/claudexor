import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { checkHarnessPrograms } from "./harness-program-freshness.mjs";
import {
  defineHarnessProgram,
  resolveHarnessBinary,
  resolveSelectedProgramAsync,
  runCapture,
} from "../../packages/core/dist/index.js";
import {
  newestSource,
  pickNewest,
  readVendorBytes,
} from "../../packages/cli/src/harness-newest.js";
const roots = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const program = {
  id: "fixture",
  majorVersion: 1,
  platforms: {
    linux: {
      newest: { url: "https://vendor.example/latest", pick: { kind: "text" } },
      update: { kind: "exec", command: "{program}", args: ["upgrade"] },
      exactVersion: { kind: "exec", command: "{program}", args: ["upgrade", "{version}"] },
      install: { kind: "script", url: "https://vendor.example/install" },
    },
  },
};
function deps() {
  return {
    platform: "linux",
    arch: "x64",
    newestSource,
    pickNewest,
    readVendorBytes: vi.fn(async () => Buffer.from("1.2.3")),
    resolveSelectedProgramAsync: vi.fn(async () => ({ path: "/fixture/vendor" })),
    resolveHarnessBinary: vi.fn(() => null),
    runCapture: vi.fn(async () => ({ code: 0, stdout: "Usage: upgrade", stderr: "" })),
  };
}
it.each([true, false])(
  "authenticates only the exact GitHub API origin (token present: %s)",
  async (present) => {
    const token = "fixture-only-token";
    vi.stubEnv("GITHUB_TOKEN", present ? token : undefined);
    const sources = [
      "https://api.github.com/repos/fixture/tool/releases/latest",
      "https://vendor.example/latest",
      "https://api.github.com.vendor.example/latest",
      "https://api.github.com:8443/latest",
    ];
    const observed = [];
    vi.stubGlobal("fetch", async (url, init) => {
      const headers = new Headers(init.headers);
      // Record booleans only: failed assertions cannot print the token.
      observed.push({
        url,
        authorized: headers.get("Authorization") === `Bearer ${token}`,
        hasAuthorization: headers.has("Authorization"),
        userAgent: headers.get("User-Agent"),
      });
      return new Response("1.2.3");
    });
    const programs = sources.map((url) => ({
      ...program,
      platforms: { linux: { newest: { url, pick: { kind: "text" } } } },
    }));
    const d = { ...deps(), readVendorBytes };
    const checks = await checkHarnessPrograms(programs, d, { sourcesOnly: true });
    expect(observed).toEqual(
      sources.map((url, index) => ({
        url,
        authorized: present && index === 0,
        hasAuthorization: present && index === 0,
        userAgent: "Claudexor",
      })),
    );
    expect(
      checks.filter((check) => check.kind === "newest").every((check) => check.status === "passed"),
    ).toBe(true);
    expect(JSON.stringify(checks).includes(token)).toBe(false);
    await readVendorBytes(sources[0]);
    expect(observed.at(-1).hasAuthorization).toBe(false);
    expect(d.resolveSelectedProgramAsync).not.toHaveBeenCalled();
    expect(d.runCapture).not.toHaveBeenCalled();
  },
);
it("keeps an authenticated HTTP refusal as a failed source without retrying or exposing the token", async () => {
  const token = "fixture-only-token";
  vi.stubEnv("GITHUB_TOKEN", token);
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls++;
    return new Response("API rate limit exceeded", { status: 403 });
  });
  const source = {
    url: "https://api.github.com/repos/fixture/tool/releases/latest",
    pick: { kind: "text" },
  };
  const checks = await checkHarnessPrograms(
    [{ ...program, platforms: { linux: { newest: source } } }],
    { ...deps(), readVendorBytes },
    { sourcesOnly: true },
  );
  expect(calls).toBe(1);
  expect(checks[0]).toMatchObject({
    status: "failed",
    detail: "Error: Vendor source returned HTTP 403",
  });
  expect(JSON.stringify(checks).includes(token)).toBe(false);
});
it.each([true, false])(
  "keeps the release token out of real version and help children (token present: %s)",
  async (present) => {
    const root = mkdtempSync(join(tmpdir(), "freshness-"));
    roots.push(root);
    const binary = join(root, "vendor.cjs"),
      log = join(root, "children.jsonl");
    writeFileSync(
      binary,
      `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  args: process.argv.slice(2),
  hasToken: Object.hasOwn(process.env, 'GITHUB_TOKEN'),
  input: process.env.FRESHNESS_FIXTURE_INPUT,
  updateInput: process.env.FRESHNESS_FIXTURE_UPDATE ?? null
}) + '\\n');
console.log(process.argv.includes('--version') ? '1.2.3' : 'Usage: upgrade');
`,
      { mode: 0o755 },
    );
    const token = "fixture-only-token";
    vi.stubEnv("GITHUB_TOKEN", present ? token : undefined);
    vi.stubEnv("FRESHNESS_FIXTURE_BIN", binary);
    vi.stubEnv("FRESHNESS_FIXTURE_INPUT", "preserved");
    vi.stubEnv("FRESHNESS_FIXTURE_UPDATE", undefined);
    const installed = defineHarnessProgram({
      ...program,
      overrideEnv: "FRESHNESS_FIXTURE_BIN",
      launchers: [{ name: "freshness-fixture" }],
      installationEnv: [],
      childUpdateEnv: { FRESHNESS_FIXTURE_UPDATE: "declared" },
      platforms: {
        [process.platform]: {
          launcherDirs: [],
          newest: program.platforms.linux.newest,
          update: program.platforms.linux.update,
        },
      },
    });
    const checks = await checkHarnessPrograms([installed], {
      ...deps(),
      platform: process.platform,
      resolveSelectedProgramAsync,
      resolveHarnessBinary,
      runCapture,
    });
    expect(checks.filter((check) => check.status === "passed")).toHaveLength(2);
    expect(
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { args: ["--version"], hasToken: false, input: "preserved", updateInput: null },
      { args: ["upgrade", "--help"], hasToken: false, input: "preserved", updateInput: "declared" },
    ]);
    // The parent's token is retained for source fetches, never printed or passed to programs.
    expect(Boolean(process.env.GITHUB_TOKEN)).toBe(present);
    expect(JSON.stringify(checks).includes(token)).toBe(false);
  },
);
it("checks declared source and each distinct verb without running installation operands", async () => {
  const d = deps(),
    checks = await checkHarnessPrograms([program], d);
  expect(checks.filter((c) => c.status === "passed")).toHaveLength(2);
  expect(d.runCapture).toHaveBeenCalledExactlyOnceWith(
    "/fixture/vendor",
    ["upgrade", "--help"],
    expect.anything(),
  );
  expect(checks.find((c) => c.action === "install")?.status).toBe("skipped");
});
it("reports an absent program as skipped and never executes a fallback", async () => {
  const d = deps();
  d.resolveSelectedProgramAsync.mockResolvedValue({ path: null });
  const checks = await checkHarnessPrograms([program], d);
  expect(checks.find((c) => c.action === "update")?.status).toBe("skipped");
  expect(d.runCapture).not.toHaveBeenCalled();
});
it("fails unavailable or wrong-line sources and rejected help", async () => {
  const d = deps();
  d.readVendorBytes.mockResolvedValue(Buffer.from("2.0.0"));
  d.runCapture.mockResolvedValue({ code: 2, stdout: "", stderr: "unknown command" });
  expect(
    (await checkHarnessPrograms([program], d)).filter((c) => c.status === "failed"),
  ).toHaveLength(2);
  d.readVendorBytes.mockRejectedValue(new Error("offline"));
  expect((await checkHarnessPrograms([program], d))[0].status).toBe("failed");
});
it("sources-only never probes installed programs", async () => {
  const d = deps();
  await checkHarnessPrograms([program], d, { sourcesOnly: true });
  expect(d.resolveSelectedProgramAsync).not.toHaveBeenCalled();
  expect(d.runCapture).not.toHaveBeenCalled();
});
