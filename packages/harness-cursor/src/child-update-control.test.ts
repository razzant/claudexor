import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCliHarness } from "@claudexor/core";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { createCursorAdapter } from "./index.js";
import { CURSOR_PROGRAM } from "./program.js";
import { queryCursorModels } from "./models.js";
import { smokeIsolatedApiKey } from "./smoke.js";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);

it.each(["refused", "empty"] as const)(
  "a found CLI with a %s protected version answer is not reported as proven missing",
  async (answer) => {
    const root = mkdtempSync(join(tmpdir(), "cursor-version-control-"));
    roots.push(root);
    const bin = join(root, "cursor");
    const log = join(root, "args");
    writeFileSync(
      bin,
      `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
if [ "$*" = "--version" ]; then echo 2026.08.11-e8db854; exit 0; fi
${answer === "refused" ? "echo 'unsupported update switch' >&2; exit 2" : "exit 0"}
`,
      { mode: 0o755 },
    );
    vi.stubEnv("CLAUDEXOR_CURSOR_BIN", bin);
    const nativeAuthOk = vi.fn(async () => ({ kind: "loggedOut" as const }));
    const cursorApiKey = vi.fn(() => null);
    const adapter = createCursorAdapter({ nativeAuthOk, cursorApiKey });
    await expect(adapter.discover()).rejects.toThrow("Cursor CLI is missing or did not answer");
    const receipt = await adapter.doctorForAccounts!({ cwd: root });
    expect(receipt).toMatchObject({ identity: null, report: { status: "unavailable" } });
    const detail = receipt.report.checks.find((check) => check.id === "installed")?.detail;
    expect(detail).toContain("is missing or did not answer");
    expect(detail).toContain("--disable-auto-update --version");
    expect(receipt.report.reasons).toEqual([detail]);
    expect(detail).not.toContain("not found on PATH");
    // One probe per explicit operation; no retry, no fallback without the
    // switch, and no credential probe after version readiness failed.
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "--disable-auto-update --version",
      "--disable-auto-update --version",
    ]);
    expect(nativeAuthOk).not.toHaveBeenCalled();
    expect(cursorApiKey).not.toHaveBeenCalled();
  },
);

it("sends the declared switch and preserves rejection without rerunning with updates enabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "cursor-child-control-"));
  roots.push(root);
  const bin = join(root, "cursor"),
    log = join(root, "args"),
    unsafe = join(root, "updates-enabled");
  // Logs every invocation; a plain --version would still answer, so only an
  // unswitched retry could produce a version.
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nif [ "$*" = "--version" ]; then echo 2026.08.11-e8db854; exit 0; fi\nif [ "$1" = "--disable-auto-update" ]; then echo "error: unknown option '--disable-auto-update'" >&2; exit 2; fi\ntouch '${unsafe}'\n`,
    { mode: 0o755 },
  );
  vi.stubEnv("CLAUDEXOR_CURSOR_BIN", bin);
  const adapter = createCursorAdapter({
    detectVersion: async () => "fixture",
    nativeAuthOk: async () => ({ kind: "loggedOut" }),
    cursorApiKey: () => "fixture-key",
    smokeIsolatedApiKey: async () => ({ ok: true, detail: "fixture" }),
    listCursorModels: async () => [],
    runCliHarness,
  });
  const events: HarnessEvent[] = [];
  for await (const e of adapter.run(
    HarnessRunSpec.parse({
      session_id: "s",
      intent: "explain",
      prompt: "fixture",
      cwd: root,
      auth_preference: "api_key",
      env: { HOME: root },
    }),
  ))
    events.push(e);
  // The run's first version question and the work call both carry the switch.
  const calls = readFileSync(log, "utf8").trim().split("\n");
  expect(calls).toHaveLength(2);
  expect(calls[0]).toBe("--disable-auto-update --version");
  expect(calls[1]).toMatch(/^--disable-auto-update -p /);
  expect(calls.filter((call) => call.split(" ").includes("-p"))).toHaveLength(1);
  const failure = events.find((e) => e.type === "error");
  expect(failure?.error).toContain("unknown option '--disable-auto-update'");
  expect(failure?.program).toEqual({ path: bin, version: null, versionSource: "unknown" });
  expect(existsSync(unsafe)).toBe(false);
  expect(CURSOR_PROGRAM.childUpdateArgs).toEqual(["--disable-auto-update"]);
});

it("keeps model enumeration and isolated smoke functional with child updates disabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "cursor-probe-control-"));
  roots.push(root);
  const bin = join(root, "cursor");
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" != "--disable-auto-update" ]; then echo "updates must be disabled" >&2; exit 2; fi
shift
case "$1" in
  --list-models) echo "fixture-model - Fixture Model" ;;
  -p) echo '{"type":"system","apiKeySource":"env"}'; echo '{"type":"result","result":"OK"}' ;;
  *) exit 3 ;;
esac
`,
    { mode: 0o755 },
  );
  vi.stubEnv("CLAUDEXOR_CURSOR_BIN", bin);
  expect((await queryCursorModels(bin, { HOME: root }, root)).map((model) => model.id)).toEqual([
    "fixture-model",
  ]);
  expect(
    await smokeIsolatedApiKey("fixture-key", { makeBaseDir: () => join(root, "smoke") }),
  ).toMatchObject({ ok: true });
});
