import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PROVIDER_SECRET_ENV } from "@claudexor/core";
import { makeSandbox, type Sandbox } from "./support.js";

let sandbox: Sandbox | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  sandbox?.dispose();
  sandbox = undefined;
});

it("[INV-067:canary-isolation] ambient credentials and route overrides never reach offline CLI children", () => {
  const forbidden = [
    ...PROVIDER_SECRET_ENV,
    "CLAUDEXOR_CLAUDE_NATIVE_DIR",
    "CLAUDEXOR_CODEX_NATIVE_HOME",
    "CLAUDEXOR_CLAUDE_BIN",
    "NODE_OPTIONS",
  ];
  for (const key of forbidden) vi.stubEnv(key, "canary-sentinel-not-a-credential");
  sandbox = makeSandbox();
  for (const key of forbidden) expect(sandbox.env[key], key).toBeUndefined();
  expect(sandbox.env.HOME).toBe(sandbox.home);
  expect(sandbox.env.USERPROFILE).toBe(sandbox.home);
  expect(sandbox.env.XDG_CONFIG_HOME).toBe(join(sandbox.home, ".config"));
  expect(sandbox.env.APPDATA).toBe(join(sandbox.home, "AppData", "Roaming"));
  expect(sandbox.env.CLAUDEXOR_CONFIG_DIR).toBe(sandbox.configDir);
  expect(sandbox.env.CLAUDEXOR_DISABLE_STORED_SECRETS).toBe("1");
  expect(sandbox.env.PATH).toBe(process.env.PATH);
  // Exercise Node's real child env serialization: null is not a deletion.
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `process.stdout.write(JSON.stringify(${JSON.stringify(forbidden)}.filter(k => process.env[k] !== undefined)))`,
    ],
    { env: sandbox.env, encoding: "utf8" },
  );
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual([]);
  expect(process.env.ANTHROPIC_API_KEY).toBe("canary-sentinel-not-a-credential");
});
