import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const helper = fileURLToPath(
  new URL("../../apps/macos/scripts/sign-local-app.sh", import.meta.url),
);
const entitlements = fileURLToPath(
  new URL("../../apps/macos/packaging/NodeRuntime.entitlements", import.meta.url),
);
const fixtures = [];
const macTest = process.platform === "darwin" ? test : test.skip;
const shellTest = existsSync("/bin/bash") ? test : test.skip;

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function fixtureRoot() {
  const root = mkdtempSync(join(process.env.CLAUDEXOR_TEST_TMPDIR ?? tmpdir(), "app-sign-"));
  fixtures.push(root);
  const env = {
    HOME: join(root, "home"),
    CLAUDEXOR_CONFIG_DIR: join(root, "config"),
    TMPDIR: root,
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
  };
  mkdirSync(env.HOME);
  mkdirSync(env.CLAUDEXOR_CONFIG_DIR);
  return { root, env };
}

function run(f, command, args) {
  const result = spawnSync(command, args, {
    cwd: f.root,
    env: f.env,
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

function expectSuccess(result) {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

function fixture() {
  const f = fixtureRoot();
  const { root } = f;
  const app = join(root, "Claudexor.app");
  const macos = join(app, "Contents", "MacOS");
  const resources = join(app, "Contents", "Resources");
  mkdirSync(macos, { recursive: true });
  mkdirSync(resources, { recursive: true });
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.claudexor.test</string>
<key>CFBundleExecutable</key><string>ClaudexorApp</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`,
  );
  const binary = join(macos, "ClaudexorApp");
  const source = join(root, "main.c");
  writeFileSync(source, "int main(void) { return 0; }\n");
  // Like the SwiftPM executable, this starts linker-signed with no bundle seal.
  // Request linker signing explicitly rather than relying on architecture defaults.
  expectSuccess(run(f, "/usr/bin/xcrun", ["clang", source, "-Wl,-adhoc_codesign", "-o", binary]));
  const mainSignature = run(f, "codesign", ["--display", "--verbose=4", binary]);
  expectSuccess(mainSignature);
  expect(mainSignature.stderr).toContain("linker-signed");

  // A synthetic executable at Node's resource path, not a Node/V8 execution test.
  const node = join(resources, "node");
  copyFileSync(binary, node);
  expectSuccess(
    run(f, "codesign", [
      "--force",
      "--sign",
      "-",
      "--options",
      "runtime",
      "--entitlements",
      entitlements,
      node,
    ]),
  );

  // SwiftPM emits a flat, codeless BNDL in Resources, without CFBundleExecutable.
  const bundle = join(resources, "ClaudexorApp_ClaudexorApp.bundle");
  mkdirSync(bundle);
  writeFileSync(
    join(bundle, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleIdentifier</key><string>ClaudexorApp.ClaudexorApp.resources</string>
<key>CFBundlePackageType</key><string>BNDL</string>
</dict></plist>`,
  );
  const resource = join(bundle, "data.txt");
  writeFileSync(resource, "sealed resource\n");
  return { ...f, app, node, resource };
}

// Bracket each argument so the log keeps argv boundaries; the app path contains a space.
const recordArgv = `for arg in "$@"; do printf '[%s]' "$arg" >> "$HOME/calls"; done\nprintf '\\n' >> "$HOME/calls"\n`;

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function observeNested(f) {
  const signature = run(f, "codesign", ["--display", "--verbose=4", f.node]);
  const entitlementDump = run(f, "codesign", ["--display", "--entitlements", "-", f.node]);
  const verify = run(f, "codesign", ["--verify", "--strict", "--verbose=2", f.node]);
  for (const result of [signature, entitlementDump, verify]) expectSuccess(result);
  return {
    sha256: digest(f.node),
    signature: signature.stderr,
    entitlements: entitlementDump.stdout,
    verification: verify.stderr,
  };
}

macTest(
  "local signing seals resources, preserves nested code, and detects resource tampering",
  () => {
    const f = fixture();
    const seal = join(f.app, "Contents", "_CodeSignature", "CodeResources");
    const verifyArgs = ["--verify", "--deep", "--strict", "--verbose=2", f.app];
    expect(existsSync(seal)).toBe(false);
    const baseline = run(f, "codesign", verifyArgs);
    expect(baseline.status, baseline.stderr).toBe(1);
    expect(baseline.stderr).toContain(
      "code has no resources but signature indicates they must be present",
    );

    const nestedBefore = observeNested(f);
    expect(nestedBefore.signature).toContain("Signature=adhoc");
    expect(nestedBefore.signature).toContain("runtime");
    expect(nestedBefore.entitlements).toContain("com.apple.security.cs.allow-jit");
    expectSuccess(run(f, "/bin/bash", [helper, f.app]));
    expect(existsSync(seal)).toBe(true);
    expectSuccess(run(f, "codesign", verifyArgs));
    expect(observeNested(f)).toEqual(nestedBefore);

    writeFileSync(f.resource, "tampered resource\n");
    const tampered = run(f, "codesign", verifyArgs);
    expect(tampered.status, tampered.stderr).toBe(1);
    expect(tampered.stderr).toContain("a sealed resource is missing or invalid");
  },
);

shellTest("injected signing failure propagates without reaching verification", () => {
  const f = fixtureRoot();
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const fakeCodesign = join(bin, "codesign");
  writeFileSync(fakeCodesign, `#!/bin/sh\n${recordArgv}echo signing-failed >&2\nexit 71\n`, {
    mode: 0o755,
  });
  f.env.PATH = `${bin}:/usr/bin:/bin`;
  const app = join(f.root, "Local Build", "Claudexor.app");
  const result = run(f, "/bin/bash", [helper, app]);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(71);
  expect(result.stderr).toContain("signing-failed");
  expect(readFileSync(join(f.env.HOME, "calls"), "utf8")).toBe(`[--force][--sign][-][${app}]\n`);
});

shellTest("injected verification failure propagates after signing succeeds", () => {
  const f = fixtureRoot();
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const fakeCodesign = join(bin, "codesign");
  writeFileSync(
    fakeCodesign,
    `#!/bin/sh\n${recordArgv}if [ "$1" = "--verify" ]; then echo verification-failed >&2; exit 72; fi\nexit 0\n`,
    { mode: 0o755 },
  );
  f.env.PATH = `${bin}:/usr/bin:/bin`;
  const app = join(f.root, "Local Build", "Claudexor.app");
  const result = run(f, "/bin/bash", [helper, app]);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(72);
  expect(result.stderr).toContain("verification-failed");
  // Exact argv pins the promised strict deep verification, not only its first flag.
  expect(readFileSync(join(f.env.HOME, "calls"), "utf8")).toBe(
    `[--force][--sign][-][${app}]\n[--verify][--deep][--strict][--verbose=2][${app}]\n`,
  );
});
