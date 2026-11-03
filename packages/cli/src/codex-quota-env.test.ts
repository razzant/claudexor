import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateGlobalConfig } from "@claudexor/config";
import { refreshCodexQuota } from "./codex-quota-source.js";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "codex-quota-env-")));
  vi.stubEnv("CLAUDEXOR_CONFIG_DIR", join(root, "state"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

describe.skipIf(process.platform === "win32")("Codex quota from a GUI environment", () => {
  it.each([
    ["user-local", [".local", "bin"], false],
    ["managed", [".claudexor", "node", "bin"], false],
    ["absolute override", ["custom", "bin"], true],
  ] as const)("reads the named profile using the %s CLI", async (_label, parts, absolute) => {
    const host = join(root, "host");
    const binDir = join(host, ...parts);
    const nodeDir = join(host, ".claudexor", "node", "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(nodeDir, { recursive: true });
    symlinkSync(process.execPath, join(nodeDir, "node"));
    const name = "codex-quota-env-fixture";
    const binary = join(binDir, name);
    writeFileSync(
      binary,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(process.env.CODEX_HOME, "launch.json"), JSON.stringify({
  home: process.env.HOME, codexHome: process.env.CODEX_HOME,
  providerKeyPresent: "OPENAI_API_KEY" in process.env,
  args: process.argv.slice(2),
}));
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "account/rateLimits/read" ? {
    rateLimits: { limitId: "codex", planType: "plus",
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 } },
  } : {};
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
});
`,
    );
    chmodSync(binary, 0o755);
    const home = join(process.env.CLAUDEXOR_CONFIG_DIR!, "quota-profile");
    mkdirSync(home, { recursive: true });
    // Presence admits the local fixture; these are not vendor credentials.
    writeFileSync(join(home, "auth.json"), "{}\n");
    updateGlobalConfig((config) => ({
      ...config,
      credential_profiles: [
        {
          profile_id: "quota-profile",
          harness_id: "codex",
          display_name: "Quota fixture",
          credential_kind: "config_dir_login",
          isolation_locator: home,
          secret_ref: null,
          enabled: true,
          created_at: null,
        },
      ],
    }));
    const result = await refreshCodexQuota({
      bin: absolute ? binary : name,
      baseEnv: {
        HOME: host,
        PATH: ["/usr/bin", "/bin"].join(delimiter),
        CODEX_HOME: join(root, "wrong-account"),
        OPENAI_API_KEY: "fixture-provider-key",
      },
    });
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]).toMatchObject({
      subject: { subject_id: "quota-profile", plan_label: "plus" },
      constraints: [{ used_ratio: 0.25, window_seconds: 18000 }],
    });
    expect(result.absences?.map((absence) => absence.reason)).toEqual(["not_logged_in"]);
    expect(JSON.parse(readFileSync(join(home, "launch.json"), "utf8"))).toEqual({
      home: host,
      codexHome: home,
      providerKeyPresent: false,
      args: ["-c", 'cli_auth_credentials_store="file"', "app-server", "--stdio"],
    });
  });
});
