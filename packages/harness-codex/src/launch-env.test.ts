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
import { CredentialProfile } from "@claudexor/schema";
import { createCodexAdapter } from "./index.js";
import { clearCodexEffortCache, probeCodexEfforts } from "./effort-probe.js";
import { probeEnv } from "./missing-cli.js";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "codex-launch-env-")));
  vi.stubEnv("HOME", join(root, "host"));
  vi.stubEnv("PATH", ["/usr/bin", "/bin"].join(delimiter));
  vi.stubEnv("CLAUDEXOR_CONFIG_DIR", join(root, "state"));
  vi.stubEnv("OPENAI_API_KEY", "fixture-provider-key");
  clearCodexEffortCache();
});
afterEach(() => {
  clearCodexEffortCache();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

it("keeps explicit environment patches and deletions after host normalization", () => {
  vi.stubEnv("CODEX_TEST_REMOVE_NULL", "inherited");
  vi.stubEnv("CODEX_TEST_REMOVE_UNDEFINED", "inherited");
  const env = probeEnv({
    HOME: join(root, "scoped"),
    PATH: "/explicit/toolchain",
    CODEX_TEST_REMOVE_NULL: null,
    CODEX_TEST_REMOVE_UNDEFINED: undefined,
  });
  expect(env.HOME).toBe(join(root, "scoped"));
  expect(env.PATH).toBe("/explicit/toolchain");
  expect(env.CODEX_TEST_REMOVE_NULL).toBeUndefined();
  expect(env.CODEX_TEST_REMOVE_UNDEFINED).toBeUndefined();
  expect(process.env.CODEX_TEST_REMOVE_NULL).toBe("inherited");
});

// This fixture is a POSIX vendor-style npm launcher. Windows native executable
// resolution remains covered by core/runtime-env.test.ts; no .cmd shell is added.
describe.skipIf(process.platform === "win32")("Codex model/list from a GUI environment", () => {
  it.each([
    ["user-local", [".local", "bin"], false],
    ["managed", [".claudexor", "node", "bin"], false],
    ["absolute override", ["custom", "bin"], true],
  ] as const)("reads each profile using the %s CLI", async (_label, parts, absolute) => {
    const host = process.env.HOME!;
    const binDir = join(host, ...parts);
    const nodeDir = join(host, ".claudexor", "node", "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(nodeDir, { recursive: true });
    symlinkSync(process.execPath, join(nodeDir, "node"));
    const name = "codex-launch-env-fixture";
    const binary = join(binDir, name);
    writeFileSync(
      binary,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.CODEX_HOME;
fs.writeFileSync(path.join(home, "launch.json"), JSON.stringify({
  home: process.env.HOME, codexHome: home, node: process.execPath,
  providerKeyPresent: "OPENAI_API_KEY" in process.env,
}));
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "model/list" ? { data: [{
    id: path.basename(home), displayName: "Fixture account model", isDefault: true,
    defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }],
    serviceTiers: [],
  }] } : {};
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
});
`,
    );
    chmodSync(binary, 0o755);
    const adapter = createCodexAdapter({
      // Only the fixture executable is substituted; production env composition,
      // app-server protocol, model parser and account inventory are exercised.
      probeEfforts: (_bin, env) =>
        probeCodexEfforts(absolute ? binary : name, { env, timeoutMs: 5_000 }),
    });
    for (const id of ["account-one", "account-two"]) {
      const home = join(process.env.CLAUDEXOR_CONFIG_DIR!, id);
      mkdirSync(home, { recursive: true });
      const profile = CredentialProfile.parse({
        profile_id: id,
        harness_id: "codex",
        display_name: id,
        credential_kind: "config_dir_login",
        isolation_locator: home,
      });
      const models = await adapter.models!({
        cwd: root,
        env: { HOME: home },
        credentialProfile: profile,
      });
      expect(models.map((model) => model.id)).toEqual([id]);
      expect(JSON.parse(readFileSync(join(home, "launch.json"), "utf8"))).toEqual({
        home,
        codexHome: home,
        node: realpathSync(process.execPath),
        providerKeyPresent: false,
      });
    }
  });
});
