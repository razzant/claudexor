import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import { runProbeIfRequested } from "./claudexord.js";

describe("claudexord --probe (D-2 install probe)", () => {
  it("handles --probe and ignores a normal argv", () => {
    expect(runProbeIfRequested(["--probe"])).toBe(true);
    expect(runProbeIfRequested([])).toBe(false);
    expect(runProbeIfRequested(["--other"])).toBe(false);
  });

  it("prints one JSON line {version, buildSha} and starts nothing durable", () => {
    const dist = resolve(import.meta.dirname, "../dist/claudexord.js");
    if (!existsSync(dist)) {
      // The integration assertion needs the built daemon; `pnpm build` runs
      // before `pnpm test` in the gate. Skip the exec when run pre-build.
      return;
    }
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    const out = execFileSync("node", [dist, "--probe"], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, CLAUDEXOR_BUILD_SHA: sha },
    });
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as { version: string; buildSha: string };
    expect(parsed.version).toBe(CLAUDEXOR_VERSION);
    expect(parsed.buildSha).toBe(sha);
  });
});
