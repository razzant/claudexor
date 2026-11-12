import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HarnessRunSpec } from "@claudexor/schema";
import { defineHarnessProgram } from "./program-registry.js";
import { observeHarnessProgram, invalidateProgramObservations } from "./program-observation.js";
import { runCliHarness } from "./runloop.js";
const roots: string[] = [];
afterEach(() => {
  invalidateProgramObservations();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0);
it.each([true, false])(
  "records the launch path and version (vendor start frame: %s)",
  async (streamVersion) => {
    const root = mkdtempSync(join(tmpdir(), "native-evidence-"));
    roots.push(root);
    const bin = join(root, "native");
    const count = join(root, "probes");
    writeFileSync(
      bin,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo x >> '${count}'; echo 1.0.0; exit 0; fi\nprintf '%s\\n' '${JSON.stringify({ type: "init", ...(streamVersion ? { version: "2.0.0" } : {}) })}'\n`,
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
      ...(streamVersion
        ? { programVersion: (frame: unknown) => (frame as { version?: string }).version }
        : {}),
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
    expect(existsSync(count) ? readFileSync(count, "utf8").trim().split("\n").length : 0).toBe(
      streamVersion ? 0 : 1,
    );
    expect((await observeHarnessProgram(program, undefined, bin)).program?.version).toBe(
      evidence.version,
    );
    const { prepareNativeProgram } = await import("./native-program.js");
    const remembered = await prepareNativeProgram(program, bin, spec);
    expect(remembered.evidence()).toEqual({
      path: bin,
      version: evidence.version,
      versionSource: "remembered",
    });
    remembered.observeVersion("3.0.0");
    expect(remembered.evidence().versionSource).toBe("vendor_stream");
    expect(existsSync(count) ? readFileSync(count, "utf8").trim().split("\n").length : 0).toBe(
      streamVersion ? 0 : 1,
    );
  },
);
