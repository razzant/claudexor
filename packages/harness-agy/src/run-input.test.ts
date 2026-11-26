import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import { agySettingsPath, ensureAgyReadGrant } from "./read-grant.js";
import { prepareAgyRunInput } from "./run-input.js";
import { agyWorkspaceWriteCliFacts } from "./vendor-cli-version.js";

const between = vi.hoisted(() => ({
  /** Applied once, right after the run's one read of the profile settings. */
  change: null as ((home: string) => void) | null,
}));
vi.mock("./read-grant.js", async (original) => {
  const actual = await original<typeof import("./read-grant.js")>();
  return {
    ...actual,
    readAgyProfileSettings: (home: string) => {
      const snapshot = actual.readAgyProfileSettings(home);
      const change = between.change;
      between.change = null;
      change?.(home);
      return snapshot;
    },
  };
});

const homes: string[] = [];
afterEach(() => {
  between.change = null;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function prepare(access: HarnessRunSpec["access"], saved: string) {
  const home = mkdtempSync(join(tmpdir(), "agy-run-input-"));
  homes.push(home);
  const path = agySettingsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, saved);
  const spec = HarnessRunSpec.parse({
    session_id: "agy-run-input",
    intent: "implement",
    cwd: home,
    prompt: "Fix it.",
    access,
  });
  const events: HarnessEvent[] = [];
  const run = prepareAgyRunInput(spec, home, agyWorkspaceWriteCliFacts("1.5.14"));
  let step = run.next();
  while (!step.done) {
    events.push(step.value);
    step = run.next();
  }
  return { path, events, prepared: step.value };
}

describe("agy run preparation from one settings snapshot", () => {
  it.each(["readonly", "workspace_write", "full"] as const)(
    "refuses a %s run before anything is sent when the settings change before its grant is saved",
    (access) => {
      const newer = JSON.stringify({ theme: "dark", toolPermission: "request-review" });
      between.change = (home) => writeFileSync(agySettingsPath(home), newer);
      const { path, events, prepared } = prepare(access, JSON.stringify({ theme: "dark" }));
      expect(prepared).toBeNull();
      expect(events.map((event) => event.type)).toEqual(["error", "completed"]);
      expect(events[0]).toMatchObject({
        payload: { code: "agy_profile_settings_changed" },
        error:
          "agy did not start, so nothing was sent: settings.json changed after this run read it; the newer file was left as it is; this run's access decisions came from the earlier settings, so start it again",
      });
      // The newer settings stay exactly as saved: no grant is written over them.
      expect(readFileSync(path, "utf8")).toBe(newer);
      expect(readdirSync(dirname(path))).toEqual(["settings.json"]);
    },
  );

  it("takes the same grant saved meanwhile from the same settings as no change", () => {
    // Another run on this profile saves the grant between this run's read and its save.
    between.change = (home) => void ensureAgyReadGrant(home);
    const { path, events, prepared } = prepare(
      "workspace_write",
      JSON.stringify({ theme: "dark" }),
    );
    expect(prepared).toMatchObject({ terminalRequested: true });
    const codes = events.map((event) => event.payload?.["code"]);
    expect(codes).not.toContain("agy_profile_settings_changed");
    expect(codes).not.toContain("agy_read_grant_unavailable");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      theme: "dark",
      permissions: { allow: ["read_file(*)"] },
    });
  });
});
