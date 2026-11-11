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
it("sends the declared switch and preserves rejection without rerunning with updates enabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "cursor-child-control-"));
  roots.push(root);
  const bin = join(root, "cursor"),
    log = join(root, "args"),
    unsafe = join(root, "updates-enabled");
  writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2026.08.11-e8db854; exit 0; fi\nprintf '%s\\n' "$@" >> '${log}'\nif [ "$1" = "--disable-auto-update" ]; then echo "error: unknown option '--disable-auto-update'" >&2; exit 2; fi\ntouch '${unsafe}'\n`,
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
  expect(
    readFileSync(log, "utf8")
      .split("\n")
      .filter((x) => x === "--disable-auto-update"),
  ).toHaveLength(1);
  expect(events.find((e) => e.type === "error")?.error).toContain(
    "unknown option '--disable-auto-update'",
  );
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
