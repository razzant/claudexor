import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HarnessRunSpec } from "@claudexor/schema";
import { defineHarnessProgram } from "./program-registry.js";
import { runCliHarness } from "./runloop.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);
it.each([true, false])(
  "records the launch path and version (vendor start frame: %s)",
  async (streamVersion) => {
    const root = mkdtempSync(join(tmpdir(), "native-evidence-"));
    roots.push(root);
    const bin = join(root, "native");
    writeFileSync(
      bin,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.0; exit 0; fi\nprintf '%s\\n' '${JSON.stringify({ type: "init", ...(streamVersion ? { version: "2.0.0" } : {}) })}'\n`,
      { mode: 0o755 },
    );
    const program = defineHarnessProgram({
      id: "evidence-fixture",
      overrideEnv: "EVIDENCE_FIXTURE_BIN",
      launchers: [{ name: "evidence-fixture" }],
      installationEnv: [],
      platforms: {},
    });
    const spec = HarnessRunSpec.parse({
      session_id: "s",
      intent: "explain",
      prompt: "fixture",
      cwd: root,
    });
    const events = [];
    for await (const event of runCliHarness({
      program,
      bin,
      args: [],
      spec,
      env: { HOME: root },
      programVersion: (frame) => (frame as { version?: string }).version,
      parseEvent: () => [{ type: "started", session_id: "s", ts: new Date().toISOString() }],
    }))
      events.push(event);
    const evidence = {
      path: bin,
      version: streamVersion ? "2.0.0" : "1.0.0",
      versionSource: streamVersion ? "vendor_stream" : "version_probe",
    };
    expect(events.find((e) => e.type === "started")?.program).toEqual(evidence);
    expect(events.at(-1)?.program).toEqual(evidence);
  },
);
