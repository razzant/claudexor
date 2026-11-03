import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";

const sourceScript = fileURLToPath(
  new URL("../../apps/macos/scripts/build-app.sh", import.meta.url),
);
const fixtureRoots = [];
const shellTest = existsSync("/bin/bash") ? test : test.skip;

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function writeExecutable(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function writeMarker(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return contents;
}

function createFixture({ swiftStatus, withReleaseBinary }) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "claudexor-build-app-cleanup-")));
  fixtureRoots.push(root);

  const repoRoot = join(root, "repo");
  const script = join(repoRoot, "apps", "macos", "scripts", "build-app.sh");
  const appPackage = join(repoRoot, "apps", "macos", "ClaudexorApp");
  const binary = join(appPackage, ".build", "release", "ClaudexorApp");
  const dist = join(repoRoot, "apps", "macos", "dist");
  const legacyApp = join(dist, "Claudexor.app");
  const currentApp = join(dist, "bundle.noindex", "Claudexor.app");
  const legacyMarker = join(legacyApp, "legacy-marker.txt");
  const currentMarker = join(currentApp, "current-marker.txt");
  const unrelatedAppMarker = join(dist, "Other.app", "marker.txt");
  const unrelatedBundleMarker = join(dist, "bundle.noindex", "Other.app", "marker.txt");
  const artifactMarker = join(dist, "existing-artifact.sentinel");
  const fixtureBin = join(root, "bin");
  const fixtureHome = join(root, "home");
  const fixtureLog = join(root, "log");
  const cpLog = join(fixtureLog, "cp.log");
  const swiftLog = join(fixtureLog, "swift.log");

  mkdirSync(dirname(script), { recursive: true });
  mkdirSync(appPackage, { recursive: true });
  mkdirSync(join(repoRoot, "packages", "util", "src"), { recursive: true });
  mkdirSync(fixtureHome, { recursive: true });
  mkdirSync(fixtureLog, { recursive: true });
  copyFileSync(sourceScript, script);
  writeFileSync(join(repoRoot, "package.json"), '{"version": "3.3.15"}\n');
  writeFileSync(
    join(repoRoot, "packages", "util", "src", "version.ts"),
    'export const CLAUDEXOR_VERSION = "3.3.15";\n',
  );

  const markerBytes = {
    legacy: writeMarker(legacyMarker, "legacy-app-marker\n"),
    current: writeMarker(currentMarker, "current-app-marker\n"),
    unrelatedApp: writeMarker(unrelatedAppMarker, "unrelated-app-marker\n"),
    unrelatedBundle: writeMarker(unrelatedBundleMarker, "unrelated-bundle-marker\n"),
    artifact: writeMarker(artifactMarker, "existing-artifact-marker\n"),
  };

  if (withReleaseBinary) {
    writeExecutable(binary, "#!/bin/sh\nexit 0\n");
  }

  writeExecutable(
    join(fixtureBin, "swift"),
    `#!/bin/sh
set -eu
printf '%s\\n' "$@" > "$CLAUDEXOR_TEST_LOG_DIR/swift.log"
exit ${swiftStatus}
`,
  );

  const expectedDestination = join(currentApp, "Contents", "MacOS", "ClaudexorApp");
  writeExecutable(
    join(fixtureBin, "cp"),
    `#!/bin/sh
set -eu
{
  printf '%s\\n' "$#"
  printf '%s\\n' "$@"
} > "$CLAUDEXOR_TEST_LOG_DIR/cp.log"
if [ "$#" -ne 2 ]; then
  echo "ERROR: expected exactly two cp arguments" >&2
  exit 84
fi
if [ "$1" != ${shellQuote(binary)} ] || [ "$2" != ${shellQuote(expectedDestination)} ]; then
  echo "ERROR: unexpected cp source or destination" >&2
  exit 85
fi
exit 86
`,
  );

  function run() {
    return spawnSync("/bin/bash", [script], {
      cwd: repoRoot,
      env: {
        HOME: fixtureHome,
        PATH: `${fixtureBin}:/usr/bin:/bin`,
        LANG: "C",
        LC_ALL: "C",
        CLAUDEXOR_VERSION: "3.3.15",
        CLAUDEXOR_BUILD: "157",
        CLAUDEXOR_BUILD_SHA: "1571571571571571571571571571571571571571",
        CLAUDEXOR_NO_ENGINE_BUNDLE: "1",
        MAKE_ZIP: "0",
        MAKE_DMG: "0",
        CLAUDEXOR_TEST_LOG_DIR: fixtureLog,
      },
      encoding: "utf8",
      timeout: 10_000,
    });
  }

  function expectSpawn(result, status) {
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(status);
  }

  function expectUnrelatedMarkersUnchanged() {
    expect(readFileSync(unrelatedAppMarker, "utf8")).toBe(markerBytes.unrelatedApp);
    expect(readFileSync(unrelatedBundleMarker, "utf8")).toBe(markerBytes.unrelatedBundle);
    expect(readFileSync(artifactMarker, "utf8")).toBe(markerBytes.artifact);
  }

  function expectAllStaleMarkersUnchanged() {
    expect(readFileSync(legacyMarker, "utf8")).toBe(markerBytes.legacy);
    expect(readFileSync(currentMarker, "utf8")).toBe(markerBytes.current);
    expectUnrelatedMarkersUnchanged();
  }

  return {
    artifactMarker,
    binary,
    cpLog,
    currentApp,
    currentMarker,
    expectAllStaleMarkersUnchanged,
    expectSpawn,
    expectUnrelatedMarkersUnchanged,
    expectedDestination,
    legacyApp,
    run,
    swiftLog,
  };
}

shellTest("successful assembly removes both owned app paths and preserves siblings", () => {
  const fixture = createFixture({ swiftStatus: 0, withReleaseBinary: true });
  const result = fixture.run();

  fixture.expectSpawn(result, 86);
  expect(readFileSync(fixture.swiftLog, "utf8")).toBe("build\n-c\nrelease\n");
  expect(readFileSync(fixture.cpLog, "utf8")).toBe(
    `2\n${fixture.binary}\n${fixture.expectedDestination}\n`,
  );
  expect(existsSync(fixture.legacyApp)).toBe(false);
  expect(existsSync(fixture.currentMarker)).toBe(false);
  expect(statSync(join(fixture.currentApp, "Contents", "MacOS")).isDirectory()).toBe(true);
  expect(statSync(join(fixture.currentApp, "Contents", "Resources")).isDirectory()).toBe(true);
  fixture.expectUnrelatedMarkersUnchanged();
});

shellTest("Swift failure preserves both stale app paths even when an executable exists", () => {
  const fixture = createFixture({ swiftStatus: 72, withReleaseBinary: true });
  const result = fixture.run();

  fixture.expectSpawn(result, 72);
  expect(readFileSync(fixture.swiftLog, "utf8")).toBe("build\n-c\nrelease\n");
  expect(existsSync(fixture.cpLog)).toBe(false);
  fixture.expectAllStaleMarkersUnchanged();
});

shellTest("missing release executable preserves both stale app paths", () => {
  const fixture = createFixture({ swiftStatus: 0, withReleaseBinary: false });
  const result = fixture.run();

  fixture.expectSpawn(result, 1);
  expect(readFileSync(fixture.swiftLog, "utf8")).toBe("build\n-c\nrelease\n");
  expect(result.stderr).toContain(`ERROR: release binary not found at ${fixture.binary}`);
  expect(existsSync(fixture.cpLog)).toBe(false);
  fixture.expectAllStaleMarkersUnchanged();
});
