#!/usr/bin/env bash
#
# Assemble a distributable Claudexor.app from the SwiftPM release build, and optionally
# codesign (Developer ID + hardened runtime), notarize, staple, and package a DMG.
#
# Dev builds run the executable directly (`swift run ClaudexorApp`); this script is only for
# producing a shippable, notarized bundle. Signing/notarization are OPT-IN via env vars so
# the script also works for an unsigned local .app:
#
#   # unsigned local bundle + ZIP:
#   apps/macos/scripts/build-app.sh
#
#   # unsigned local bundle with four signed development SSH runtimes:
#   CLAUDEXOR_DEV_REMOTE_RUNTIME=1 apps/macos/scripts/build-app.sh
#
#   # unsigned local bundle + ZIP + DMG:
#   MAKE_DMG=1 apps/macos/scripts/build-app.sh
#
#   # signed + notarized + DMG (requires your Apple Developer ID):
#   SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
#   NOTARY_PROFILE="claudexor-notary" \   # a stored `notarytool store-credentials` profile
#   MAKE_DMG=1 \
#   apps/macos/scripts/build-app.sh
#
# Notarization prerequisites (one-time, needs YOUR Apple ID — cannot be done for you):
#   xcrun notarytool store-credentials "claudexor-notary" \
#     --apple-id "you@example.com" --team-id TEAMID --password <app-specific-password>
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MACOS_DIR="$(cd "$HERE/.." && pwd)"
APP_PKG="$MACOS_DIR/ClaudexorApp"
PACKAGING="$MACOS_DIR/packaging"
DIST="$MACOS_DIR/dist"
# The assembled .app (and the transient dmg-stage) live under a .noindex
# subdirectory so Spotlight never indexes dev-built bundles as launchable
# apps. Final artifacts (DMG/ZIP/sha256/SBOM) stay directly in $DIST.
BUNDLES="$DIST/bundle.noindex"
APP="$BUNDLES/Claudexor.app"

# Version SSOT is the generated CLAUDEXOR_VERSION constant (scripts/gen-version.mjs
# from the root package.json). Read it so the bundle / DMG version can't silently
# drift from the release (the old hardcoded "0.10.0" default mis-named a 0.10.1
# build). The CLAUDEXOR_VERSION env still overrides for ad-hoc builds.
REPO_ROOT="$(cd "$MACOS_DIR/../.." && pwd)"
DERIVED_VERSION="$(sed -nE 's/.*CLAUDEXOR_VERSION = "([^"]+)".*/\1/p' "$REPO_ROOT/packages/util/src/version.ts" 2>/dev/null | head -1)"
ROOT_VERSION="$(sed -nE 's/.*"version": "([^"]+)".*/\1/p' "$REPO_ROOT/package.json" 2>/dev/null | head -1)"
VERSION="${CLAUDEXOR_VERSION:-${DERIVED_VERSION:-${ROOT_VERSION:-}}}"
[ -n "$VERSION" ] || { echo "ERROR: unable to derive Claudexor version" >&2; exit 1; }
BUILD="${CLAUDEXOR_BUILD:-$(date +%Y%m%d%H%M)}"
# Deterministic engine build sha (QA-002): stamped into the esbuild bundle below
# so the daemon handshake discloses a real engine.sha in packaged builds instead
# of "unknown". CI sets CLAUDEXOR_BUILD_SHA; local builds derive it from git. The
# SAME value must reach build-runtime-closure.mjs so the bundled and downloaded
# closures carry an identical stamp — export it for any child closure build.
BUILD_SHA="${CLAUDEXOR_BUILD_SHA:-$(cd "$REPO_ROOT" && git rev-parse HEAD 2>/dev/null || echo unknown)}"
export CLAUDEXOR_BUILD_SHA="$BUILD_SHA"
DEV_REMOTE_RUNTIME="${CLAUDEXOR_DEV_REMOTE_RUNTIME:-0}"
if [ "$DEV_REMOTE_RUNTIME" = "1" ] && [ -n "${SIGN_IDENTITY:-}" ]; then
  echo "ERROR: CLAUDEXOR_DEV_REMOTE_RUNTIME is for unsigned local bundles only" >&2
  exit 1
fi

# On macOS, Homebrew's ad-hoc-signed Node can be killed by the OS code-signing
# monitor during bundling. Prefer a notarized Node under ~/.claudexor/node/bin
# when present (override with CLAUDEXOR_NODE_BIN); otherwise fall back to the
# system node on PATH.
if [ -d "$HOME/.claudexor/node/bin" ]; then
  export PATH="$HOME/.claudexor/node/bin:$PATH"
fi

echo "==> Building release binary (Swift)"
SWIFT_BUILD_ARGS=(-c release)
if [ "$DEV_REMOTE_RUNTIME" = "1" ]; then
  SWIFT_BUILD_ARGS+=(-Xswiftc -DCLAUDEXOR_DEV_REMOTE_RUNTIME)
fi
( cd "$APP_PKG" && swift build "${SWIFT_BUILD_ARGS[@]}" )
BIN="$APP_PKG/.build/release/ClaudexorApp"
[ -x "$BIN" ] || { echo "ERROR: release binary not found at $BIN" >&2; exit 1; }

echo "==> Assembling $APP"
mkdir -p "$BUNDLES"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/ClaudexorApp"

# SwiftPM resource bundles are not embedded automatically when we manually wrap
# the executable in a macOS .app. The bundle must live under Contents/Resources:
# codesign refuses an app with "unsealed contents present in the bundle root"
# (files outside Contents/), which is exactly what a root-level copy produced on
# the first signed build. Note that SwiftPM's generated Bundle.module accessor
# does NOT look here — for an executable target it only checks
# Bundle.main.bundleURL (the .app root) and the absolute build directory, then
# traps. AppDelegate.devIconURL resolves the icon by plain file path instead
# (no Bundle API on the launch path); keep the two in step if this path ever
# moves.
SPM_BUNDLE_NAME="ClaudexorApp_ClaudexorApp.bundle"
# The same literal is hardcoded in AppDelegate.devIconURL (Bundle.module is
# banned on the launch path since the 3.0.0 quarantine crash). A SwiftPM
# target rename would fail here loudly but only silently drop the dev icon
# in Swift — tie the two constants together at build time.
grep -q "$SPM_BUNDLE_NAME" "$APP_PKG/Sources/ClaudexorApp/ClaudexorApp.swift" \
  || { echo "ERROR: $SPM_BUNDLE_NAME not referenced by ClaudexorApp.swift devIconURL — the two hardcoded bundle names diverged" >&2; exit 1; }
SPM_BUNDLE="$APP_PKG/.build/release/$SPM_BUNDLE_NAME"
[ -d "$SPM_BUNDLE" ] || { echo "ERROR: SwiftPM resource bundle missing at $SPM_BUNDLE" >&2; exit 1; }
/usr/bin/ditto "$SPM_BUNDLE" "$APP/Contents/Resources/$SPM_BUNDLE_NAME"
[ -f "$APP/Contents/Resources/$SPM_BUNDLE_NAME/AppIcon.png" ] || { echo "ERROR: SwiftPM resource bundle is missing AppIcon.png" >&2; exit 1; }

# swift build emits the resource bundle WITHOUT an Info.plist, and CFBundle
# refuses to load a plist-less bundle once quarantine is attached — which made
# every browser-downloaded 3.0.0 crash at launch via the Bundle.module
# fatalError. Give the bundle a minimal Info.plist so it loads everywhere.
cat > "$APP/Contents/Resources/$SPM_BUNDLE_NAME/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.claudexor.ClaudexorApp.resources</string>
  <key>CFBundleName</key><string>ClaudexorApp_ClaudexorApp</string>
  <key>CFBundlePackageType</key><string>BNDL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
</dict>
</plist>
PLIST
# Deterministic packaging assertion: the plist must parse and carry the
# identifier — a malformed or dropped plist would silently reopen the
# quarantined-launch crash surface this file exists to close.
/usr/bin/plutil -lint -s "$APP/Contents/Resources/$SPM_BUNDLE_NAME/Info.plist" \
  || { echo "ERROR: resource bundle Info.plist failed plutil lint" >&2; exit 1; }
/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" \
  "$APP/Contents/Resources/$SPM_BUNDLE_NAME/Info.plist" >/dev/null \
  || { echo "ERROR: resource bundle Info.plist missing CFBundleIdentifier" >&2; exit 1; }

# Info.plist with version substitution.
sed -e "s/__CLAUDEXOR_VERSION__/$VERSION/" -e "s/__CLAUDEXOR_BUILD__/$BUILD/" \
    "$PACKAGING/Info.plist" > "$APP/Contents/Info.plist"

# App icon: derived at build time from the single tracked source PNG (the SPM
# resource the dev executable also uses), so no multi-MB .icns lives in git.
# CONTRACT: the source PNG must already sit on the Apple icon grid — 1024x1024
# canvas whose opaque squircle spans ONLY the centered 824x824 (~80.5%, corner
# radius ~185) with transparent margins around it. The Dock renders the bitmap
# as-is: full-bleed artwork ships an icon that looms ~20% LARGER than every
# neighbor (shipped bug, fixed in the asset). Verify after replacing the art:
# the alpha bounding box must be (100, 100, 924, 924).
ICON_SRC="$APP_PKG/Sources/ClaudexorApp/Resources/AppIcon.png"
[ -f "$ICON_SRC" ] || { echo "ERROR: icon source missing at $ICON_SRC" >&2; exit 1; }
ICONSET_DIR="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ICONSET_DIR"
for size in 16 32 64 128 256 512; do
  /usr/bin/sips -z "$size" "$size" "$ICON_SRC" --out "$ICONSET_DIR/icon_${size}x${size}.png" >/dev/null
  retina=$((size * 2))
  /usr/bin/sips -z "$retina" "$retina" "$ICON_SRC" --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" >/dev/null
done
/usr/bin/iconutil -c icns "$ICONSET_DIR" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$(dirname "$ICONSET_DIR")"
echo "    AppIcon.icns derived from $(basename "$ICON_SRC")"

printf 'APPL????' > "$APP/Contents/PkgInfo"

# --- Bundle the engine-service so the .app is self-contained (one-click) ---
# A single-file esbuild bundle of claudexord + the notarized Node go into Resources; the app
# auto-starts them (DaemonLauncher) when nothing is serving the control-api. Skip with
# CLAUDEXOR_NO_ENGINE_BUNDLE=1 for a small app-only build.
if [ "${CLAUDEXOR_NO_ENGINE_BUNDLE:-0}" != "1" ]; then
  REPO_ROOT="$(cd "$MACOS_DIR/../.." && pwd)"
  ENGINE_JS="$APP/Contents/Resources/claudexord.bundle.cjs"
  CLI_JS="$APP/Contents/Resources/claudexor.bundle.cjs"
  # esbuild emits CommonJS for the self-contained helper. Keep the .cjs
  # suffix explicit so Node does not inherit the repository's type=module
  # package scope during local/package smoke runs.
  SETUP_RUNNER_JS="$APP/Contents/Resources/setup-login-runner.cjs"
  BROWSER_MCP_DIR="$APP/Contents/Resources/browser-mcp-runtime"
  BROWSER_MCP_JS="$BROWSER_MCP_DIR/dist/browser-mcp-launcher.js"
  echo "==> Building engine workspace (pnpm -w build)"
  ( cd "$REPO_ROOT" && pnpm -w build >/dev/null )
  echo "==> Bundling claudexord (esbuild single-file)"
  # ESM->CJS shim: esbuild rewrites `import.meta.url` to undefined in CJS
  # output, which crashes createRequire(import.meta.url) at load (the v1.0.0
  # DMG shipped that crash). Define it to a banner-computed file URL so the
  # bundle behaves like the real ESM module.
  # `--define:process.env.CLAUDEXOR_BUILD_SHA` inlines the build sha as a string
  # literal so engineBuildIdentity() reports a real sha in the packaged daemon
  # (QA-002). build-runtime-closure.mjs re-tars THIS stamped bundle and asserts
  # the same sha, so the bundled and downloaded closures are stamped identically.
  if ( cd "$REPO_ROOT" && pnpm exec esbuild packages/cli/dist/claudexord.js \
        --bundle --platform=node --format=cjs --target=node22 \
        --banner:js="const CLAUDEXOR_BUNDLE_URL = require('node:url').pathToFileURL(__filename).href;" \
        --define:import.meta.url=CLAUDEXOR_BUNDLE_URL \
        --define:process.env.CLAUDEXOR_BUILD_SHA="\"$BUILD_SHA\"" \
        --outfile="$ENGINE_JS" >/dev/null ); then
    echo "    claudexord.bundle.cjs $(wc -c < "$ENGINE_JS" | tr -d ' ') bytes"
  else
    echo "ERROR: esbuild bundle failed; cannot build self-contained app" >&2
    exit 1
  fi
  echo "==> Bundling claudexor CLI for remote runtimes"
  if ( cd "$REPO_ROOT" && pnpm exec esbuild packages/cli/dist/cli.js \
        --bundle --platform=node --format=cjs --target=node22 \
        --banner:js="const CLAUDEXOR_BUNDLE_URL = require('node:url').pathToFileURL(__filename).href;" \
        --define:import.meta.url=CLAUDEXOR_BUNDLE_URL \
        --define:process.env.CLAUDEXOR_BUILD_SHA="\"$BUILD_SHA\"" \
        --outfile="$CLI_JS" >/dev/null ); then
    echo "    claudexor.bundle.cjs $(wc -c < "$CLI_JS" | tr -d ' ') bytes"
  else
    echo "ERROR: CLI bundle failed; remote runtimes would be incomplete" >&2
    exit 1
  fi
  echo "==> Bundling native-login runner"
  if ( cd "$REPO_ROOT" && pnpm exec esbuild packages/cli/dist/setup-login-runner.js \
        --bundle --platform=node --format=cjs --target=node22 \
        --banner:js="const CLAUDEXOR_BUNDLE_URL = require('node:url').pathToFileURL(__filename).href;" \
        --define:import.meta.url=CLAUDEXOR_BUNDLE_URL \
        --outfile="$SETUP_RUNNER_JS" >/dev/null ); then
    echo "    setup-login-runner.cjs $(wc -c < "$SETUP_RUNNER_JS" | tr -d ' ') bytes"
  else
    echo "ERROR: setup-login runner bundle failed; native subscription login would be broken" >&2
    exit 1
  fi
  echo "==> Deploying pinned Browser MCP runtime"
  rm -rf "$BROWSER_MCP_DIR"
  if ( cd "$REPO_ROOT" && pnpm --filter @claudexor/core deploy --legacy --prod "$BROWSER_MCP_DIR" >/dev/null ); then
    # pnpm's legacy deploy creates a virtual-store self-link back to the source
    # workspace. The deployed package already is @claudexor/core, so the link is
    # redundant and makes codesign reject the bundle as an external destination.
    DEPLOY_SELF_LINK="$BROWSER_MCP_DIR/node_modules/.pnpm/node_modules/@claudexor/core"
    if [ -L "$DEPLOY_SELF_LINK" ]; then rm "$DEPLOY_SELF_LINK"; fi
    if [ -e "$DEPLOY_SELF_LINK" ] || [ -L "$DEPLOY_SELF_LINK" ]; then
      echo "ERROR: Browser MCP deploy retained an external @claudexor/core self-link" >&2
      exit 1
    fi
    # D-2: the runtime-update closure re-tars this directory and its
    # assertNoNativeAddons guard forbids ANY .node file (the bundled Node's
    # disable-library-validation would load them unsigned on user machines).
    # fsevents is playwright's OPTIONAL fs-watch accelerator — chokidar falls
    # back to polling without it — so prune every native addon here and fail
    # loudly if one survives; the app layout stays closure-compatible by
    # construction.
    find "$BROWSER_MCP_DIR" -name "fsevents*" -type d -prune -exec rm -rf {} + 2>/dev/null || true
    find "$BROWSER_MCP_DIR" -name "*.node" -type f -delete 2>/dev/null || true
    # Pruning the fsevents dir leaves pnpm's SYMLINKS to it dangling — a
    # signed-bundle codesign --verify walks the bundle and dies on a broken
    # link ("No such file"), which killed the CI candidate while the local
    # unsigned build never entered the signing branch. Remove every dangling
    # symlink the prune orphaned.
    find "$BROWSER_MCP_DIR" -type l ! -exec test -e {} \; -delete 2>/dev/null || true
    LEFTOVER_NODE_ADDON="$(find "$BROWSER_MCP_DIR" -name '*.node' -type f | head -1)"
    if [ -n "$LEFTOVER_NODE_ADDON" ]; then
      echo "ERROR: Browser MCP runtime still carries a native addon: $LEFTOVER_NODE_ADDON" >&2
      exit 1
    fi
    echo "    browser-mcp-runtime $(du -sh "$BROWSER_MCP_DIR" | cut -f1 | tr -d ' ')"
  else
    echo "ERROR: Browser MCP deploy failed; packaged browser requests would be unavailable" >&2
    exit 1
  fi
  PROCESS_IDENTITY_HELPER="$APP/Contents/Resources/native/claudexor-process-identity"
  mkdir -p "$(dirname "$PROCESS_IDENTITY_HELPER")"
  cp "$REPO_ROOT/packages/core/dist/native/claudexor-process-identity" "$PROCESS_IDENTITY_HELPER"
  chmod 755 "$PROCESS_IDENTITY_HELPER"
  # macOS can briefly reject the first launch of a freshly copied ad-hoc-signed
  # Mach-O while its code-signing monitor registers the new file. Keep the
  # probe strict, but tolerate that bounded local race.
  PROCESS_IDENTITY_PROBE_OK=0
  for _ in 1 2 3; do
    if "$PROCESS_IDENTITY_HELPER" --pid $$ | grep -Eq '^claudexor-process-identity-v2[[:space:]]'; then
      PROCESS_IDENTITY_PROBE_OK=1
      break
    fi
    sleep 0.2
  done
  if [ "$PROCESS_IDENTITY_PROBE_OK" -ne 1 ]; then
    echo "ERROR: bundled process-identity helper failed its offline probe" >&2
    exit 1
  fi
  echo "    bundled universal process-identity helper"
  # Prefer an explicit/notarized Node for the bundled engine. CI release builds
  # always set CLAUDEXOR_NODE_BIN (release.yml captures process.execPath from
  # actions/setup-node), so the PATH fallback below only ever applies to LOCAL
  # smoke builds — and it warns, because a distributable must not silently ship
  # an ad-hoc-signed/non-portable system Node.
  NODE_BIN="${CLAUDEXOR_NODE_BIN:-$HOME/.claudexor/node/bin/node}"
  if [ ! -x "$NODE_BIN" ] && command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
    echo "    WARNING: bundling the system node ($NODE_BIN) — set CLAUDEXOR_NODE_BIN to a notarized Node for a distributable build" >&2
  fi
  # Self-containment guard (v3.0.3, GH #14): a Homebrew/managed Node links
  # libnode from its Cellar — the copied binary dies at dyld three smoke
  # stages later with a misleading error. Fail HERE, at the selection point.
  if [ -x "$NODE_BIN" ] && command -v otool >/dev/null 2>&1 && otool -L "$NODE_BIN" | grep -q 'libnode\.'; then
    echo "ERROR: $NODE_BIN links an external libnode dylib (not self-contained); set CLAUDEXOR_NODE_BIN to an official nodejs.org build (or the notarized ~/.claudexor/node/bin/node)" >&2
    exit 1
  fi
  if [ -x "$NODE_BIN" ]; then
    cp "$NODE_BIN" "$APP/Contents/Resources/node"; chmod +x "$APP/Contents/Resources/node"
    echo "    bundled node ($(du -h "$APP/Contents/Resources/node" | cut -f1 | tr -d ' '))"
  else
    echo "ERROR: no node found (looked at CLAUDEXOR_NODE_BIN, ~/.claudexor/node/bin/node, and PATH); set CLAUDEXOR_NODE_BIN or CLAUDEXOR_NO_ENGINE_BUNDLE=1" >&2
    exit 1
  fi

  # Prove the adjacent runner executes under the exact Node shipped in the app.
  set +e
  "$APP/Contents/Resources/node" "$SETUP_RUNNER_JS" >"$APP/Contents/Resources/setup-runner-smoke.out" 2>&1
  SETUP_RUNNER_STATUS=$?
  set -e
  if [ "$SETUP_RUNNER_STATUS" -ne 2 ] || ! grep -q "usage: setup-login-runner" "$APP/Contents/Resources/setup-runner-smoke.out"; then
    echo "ERROR: bundled setup-login runner did not execute its direct entrypoint" >&2
    cat "$APP/Contents/Resources/setup-runner-smoke.out" >&2
    rm -f "$APP/Contents/Resources/setup-runner-smoke.out"
    exit 1
  fi
  rm -f "$APP/Contents/Resources/setup-runner-smoke.out"
  echo "    bundled setup-login runner launches"

  # No network/package-manager access participates in the packaged Browser MCP.
  BROWSER_SMOKE_HOME="$(mktemp -d)"
  env -i HOME="$BROWSER_SMOKE_HOME" PATH="/usr/bin:/bin" \
    "$APP/Contents/Resources/node" "$BROWSER_MCP_JS" --help \
    >"$APP/Contents/Resources/browser-mcp-smoke.out" 2>&1
  if ! grep -q "Playwright MCP" "$APP/Contents/Resources/browser-mcp-smoke.out"; then
    echo "ERROR: bundled Browser MCP did not execute its offline help entrypoint" >&2
    cat "$APP/Contents/Resources/browser-mcp-smoke.out" >&2
    rm -f "$APP/Contents/Resources/browser-mcp-smoke.out"
    rm -rf "$BROWSER_SMOKE_HOME"
    exit 1
  fi
  rm -f "$APP/Contents/Resources/browser-mcp-smoke.out"
  rm -rf "$BROWSER_SMOKE_HOME"
  echo "    bundled Browser MCP launches offline"

  # Exact-artifact delegation smoke: the SAME single-file daemon entry shipped
  # in the app must self-dispatch `mcp serve-belt`. Closing stdin terminates the
  # stdio server; it must exit cleanly without creating daemon runtime state.
  BELT_SMOKE_HOME="$(cd "$(mktemp -d /tmp/claudexor-belt-smoke.XXXXXX)" && pwd -P)"
  set +e
  env -i HOME="$BELT_SMOKE_HOME" PATH="/usr/bin:/bin" \
    CLAUDEXOR_CONFIG_DIR="$BELT_SMOKE_HOME/config" \
    CLAUDEXOR_ROOT_MODE=explicit \
    CLAUDEXOR_PLUGIN_VERSION="$VERSION" \
    CLAUDEXOR_DELEGATION_DEPTH=0 \
    CLAUDEXOR_DELEGATION_MAX_SUBRUNS=8 \
    CLAUDEXOR_DELEGATION_BUDGET='{"kind":"unlimited"}' \
    "$APP/Contents/Resources/node" "$ENGINE_JS" mcp serve-belt </dev/null \
    >"$BELT_SMOKE_HOME/belt.out" 2>"$BELT_SMOKE_HOME/belt.err"
  BELT_SMOKE_STATUS=$?
  set -e
  if [ "$BELT_SMOKE_STATUS" -ne 0 ] || [ -e "$BELT_SMOKE_HOME/config" ]; then
    echo "ERROR: bundled claudexord did not serve the belt side-effect-free" >&2
    cat "$BELT_SMOKE_HOME/belt.err" >&2
    rm -rf "$BELT_SMOKE_HOME"
    exit 1
  fi
  rm -rf "$BELT_SMOKE_HOME"
  echo "    bundled delegation belt launches without daemon state"

  # Positive protocol proof over the exact packaged bytes: assert the scoped
  # six-tool allowlist, then start the same entry as a scratch daemon and require
  # a daemon-origin typed missing-run response through the belt.
  BELT_PROTOCOL_HOME="$(cd "$(mktemp -d /tmp/claudexor-belt-proto.XXXXXX)" && pwd -P)"
  if HOME="$BELT_PROTOCOL_HOME" PATH="/usr/bin:/bin" \
    CLAUDEXOR_ROOT_MODE=explicit CLAUDEXOR_PLUGIN_VERSION="$VERSION" \
    "$APP/Contents/Resources/node" "$REPO_ROOT/scripts/smoke-delegation-belt-entry.mjs" \
      --node "$APP/Contents/Resources/node" \
      --entry "$ENGINE_JS" \
      --config-root "$BELT_PROTOCOL_HOME/config" >/dev/null; then
    echo "    bundled delegation belt negotiates MCP and roundtrips its packaged daemon"
    rm -rf "$BELT_PROTOCOL_HOME"
  else
    echo "ERROR: bundled claudexord delegation belt protocol smoke failed" >&2
    rm -rf "$BELT_PROTOCOL_HOME"
    exit 1
  fi

  # Boot smoke: the bundled daemon must actually START (a load-time crash in
  # the bundle shipped in v1.0.0 and survived every gate because nothing
  # executed the bundle). Scratch HOME so the smoke never touches real state.
  echo "==> Bundle boot smoke"
  # Darwin limits Unix-domain socket paths to roughly 100 bytes. Keep the
  # disposable HOME short so this smoke tests daemon boot, not mktemp's long
  # /private/var/folders spelling.
  SMOKE_HOME="$(cd "$(mktemp -d /tmp/claudexor-smoke.XXXXXX)" && pwd -P)"
  ( HOME="$SMOKE_HOME" "$APP/Contents/Resources/node" "$ENGINE_JS" >/dev/null 2>"$SMOKE_HOME/smoke.err" & echo $! > "$SMOKE_HOME/pid" )
  SMOKE_OK=0
  for _ in $(seq 1 20); do
    if [ -f "$SMOKE_HOME/.claudexor/v3/daemon/control-api.json" ]; then SMOKE_OK=1; break; fi
    if ! kill -0 "$(cat "$SMOKE_HOME/pid")" 2>/dev/null; then break; fi
    sleep 0.5
  done
  kill "$(cat "$SMOKE_HOME/pid")" 2>/dev/null || true
  if [ "$SMOKE_OK" != "1" ]; then
    echo "ERROR: bundled claudexord failed to boot; stderr:" >&2
    cat "$SMOKE_HOME/smoke.err" >&2
    rm -rf "$SMOKE_HOME"
    exit 1
  fi
  rm -rf "$SMOKE_HOME"
  echo "    bundled daemon boots (control-api discovery written)"
  # D-2 integration proof (release-wave critical): the runtime-update closure
  # must be producible from THIS exact packaged app layout — the CI candidate
  # previously discovered a forbidden native addon only at release time.
  echo "==> Closure-buildability smoke (build-runtime-closure against the packaged app)"
  CLOSURE_SMOKE_DIR="$(mktemp -d)"
  if node "$REPO_ROOT/scripts/build-runtime-closure.mjs"       --app-bundle "$APP"       --version "$VERSION"       --out "$CLOSURE_SMOKE_DIR" >/dev/null; then
    echo "    runtime closure builds from the packaged app"
    rm -rf "$CLOSURE_SMOKE_DIR"
  else
    echo "ERROR: runtime closure cannot be built from the packaged app layout (D-2)" >&2
    exit 1
  fi

  if [ "$DEV_REMOTE_RUNTIME" = "1" ]; then
    echo "==> Building signed development SSH runtimes (four targets)"
    DEV_REMOTE_DIR="$APP/Contents/Resources/remote-runtime-dev"
    node "$REPO_ROOT/scripts/build-dev-remote-runtime-bundle.mjs" \
      --version "$VERSION" \
      --build-sha "$BUILD_SHA" \
      --resources "$APP/Contents/Resources" \
      --out "$DEV_REMOTE_DIR"
    [ -f "$DEV_REMOTE_DIR/authority.json" ] \
      || { echo "ERROR: development remote runtime authority is missing" >&2; exit 1; }
    [ -f "$DEV_REMOTE_DIR/remote-runtime-manifest.json" ] \
      || { echo "ERROR: development remote runtime manifest is missing" >&2; exit 1; }
    echo "    bundled development SSH runtimes ($(du -sh "$DEV_REMOTE_DIR" | cut -f1 | tr -d ' '))"
  fi
fi

if [ -n "${SIGN_IDENTITY:-}" ]; then
  echo "==> Codesigning with hardened runtime: $SIGN_IDENTITY"
  # Inside-out signing (NOT --deep: --deep re-signs nested code with the
  # APP's entitlements, which strips the JIT entitlements the bundled Node
  # needs under hardened runtime — V8 would be killed at startup).
  # fsevents is PRUNED from the deployed runtime (D-2 closure forbids native
  # addons); the process-identity helper is the only nested Browser MCP code.
  DEPLOYED_PROCESS_HELPER="$APP/Contents/Resources/browser-mcp-runtime/dist/native/claudexor-process-identity"
  for NESTED_CODE in "$DEPLOYED_PROCESS_HELPER"; do
    [ -f "$NESTED_CODE" ] || { echo "ERROR: expected nested Browser MCP code is missing: $NESTED_CODE" >&2; exit 1; }
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$NESTED_CODE"
    codesign --verify --strict --verbose=2 "$NESTED_CODE"
  done
  if [ -x "$APP/Contents/Resources/node" ]; then
    codesign --force --options runtime --timestamp \
      --entitlements "$PACKAGING/NodeRuntime.entitlements" \
      --sign "$SIGN_IDENTITY" "$APP/Contents/Resources/node"
  fi
  if [ -x "$APP/Contents/Resources/native/claudexor-process-identity" ]; then
    codesign --force --options runtime --timestamp \
      --sign "$SIGN_IDENTITY" "$APP/Contents/Resources/native/claudexor-process-identity"
    codesign --verify --strict --verbose=2 "$APP/Contents/Resources/native/claudexor-process-identity"
  fi
  codesign --force --options runtime --timestamp \
    --entitlements "$PACKAGING/Claudexor.entitlements" \
    --sign "$SIGN_IDENTITY" "$APP"
  codesign --verify --strict --verbose=2 "$APP"

  # Execute the signed nested Node + exact packaged daemon entry before paying
  # the notarization round trip. Canonical direct-entry comparison makes this
  # work through macOS /tmp -> /private/tmp and /var -> /private/var aliases.
  SIGNED_PROBE="$("$APP/Contents/Resources/node" "$ENGINE_JS" --probe)"
  "$APP/Contents/Resources/node" -e '
    const probe = JSON.parse(process.argv[1]);
    if (probe.version !== process.argv[2] || probe.buildSha !== process.argv[3]) {
      throw new Error(`signed app probe mismatch: ${JSON.stringify(probe)}`);
    }
  ' "$SIGNED_PROBE" "$VERSION" "$BUILD_SHA"
  echo "    signed packaged daemon probe passed"

  if [ -n "${NOTARY_PROFILE:-}" ]; then
    echo "==> Notarizing via profile: $NOTARY_PROFILE"
    ZIP="$DIST/Claudexor.zip"
    /usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
    # NOTARY_KEYCHAIN: CI stores the profile in its ephemeral build keychain
    # (notarytool store-credentials --keychain); point lookups at it there.
    xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" \
      ${NOTARY_KEYCHAIN:+--keychain "$NOTARY_KEYCHAIN"} --wait
    xcrun stapler staple "$APP"
    xcrun stapler validate "$APP"
    rm -f "$ZIP"
  else
    echo "    (set NOTARY_PROFILE to notarize + staple)"
  fi
else
  echo "==> Skipping codesign (set SIGN_IDENTITY to sign). This bundle is for LOCAL use;"
  echo "    Gatekeeper will block it on other machines until signed + notarized."
fi

if [ "${MAKE_ZIP:-1}" = "1" ]; then
  ZIP_SUFFIX=""
  if [ -z "${SIGN_IDENTITY:-}" ]; then
    ZIP_SUFFIX="-unsigned"
  elif [ -z "${NOTARY_PROFILE:-}" ]; then
    ZIP_SUFFIX="-signed-unnotarized"
  fi
  ZIP="$DIST/Claudexor-$VERSION$ZIP_SUFFIX.zip"
  echo "==> Building ZIP"
  rm -f "$ZIP"
  /usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
  shasum -a 256 "$ZIP" > "$ZIP.sha256"
  echo "    ZIP: $ZIP"
  echo "    SHA256: $ZIP.sha256"
fi

if [ "${MAKE_DMG:-0}" = "1" ]; then
  echo "==> Building DMG"
  DMG_SUFFIX=""
  if [ -z "${SIGN_IDENTITY:-}" ]; then
    DMG_SUFFIX="-unsigned"
  elif [ -z "${NOTARY_PROFILE:-}" ]; then
    DMG_SUFFIX="-signed-unnotarized"
  fi
  DMG="$DIST/Claudexor-$VERSION$DMG_SUFFIX.dmg"
  STAGE="$BUNDLES/dmg-stage"
  rm -rf "$STAGE" "$DMG"; mkdir -p "$STAGE"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -volname "Claudexor" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
  rm -rf "$STAGE"
  if [ -n "${SIGN_IDENTITY:-}" ]; then
    codesign --force --sign "$SIGN_IDENTITY" --timestamp "$DMG"
    if [ -n "${NOTARY_PROFILE:-}" ]; then
      xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" \
        ${NOTARY_KEYCHAIN:+--keychain "$NOTARY_KEYCHAIN"} --wait
      xcrun stapler staple "$DMG"
      xcrun stapler validate "$DMG"
    fi
  else
    echo "    (unsigned DMG; Gatekeeper bypass instructions are in the README)"
  fi
  shasum -a 256 "$DMG" > "$DMG.sha256"
  echo "    DMG: $DMG"
  echo "    SHA256: $DMG.sha256"
fi

echo "==> Done: $APP"
