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
APP="$DIST/Claudexor.app"

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

# On macOS, Homebrew's ad-hoc-signed Node can be killed by the OS code-signing
# monitor during bundling. Prefer a notarized Node under ~/.claudexor/node/bin
# when present (override with CLAUDEXOR_NODE_BIN); otherwise fall back to the
# system node on PATH.
if [ -d "$HOME/.claudexor/node/bin" ]; then
  export PATH="$HOME/.claudexor/node/bin:$PATH"
fi

echo "==> Building release binary (Swift)"
( cd "$APP_PKG" && swift build -c release )
BIN="$APP_PKG/.build/release/ClaudexorApp"
[ -x "$BIN" ] || { echo "ERROR: release binary not found at $BIN" >&2; exit 1; }

echo "==> Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/ClaudexorApp"

# SwiftPM resource bundles are not embedded automatically when we manually wrap
# the executable in a macOS .app. The generated Bundle.module accessor first
# looks beside Bundle.main.bundleURL (the .app root), then falls back to an
# absolute build-machine .build path. Shipping without this bundle therefore
# works only on the builder and crashes on user machines.
SPM_BUNDLE_NAME="ClaudexorApp_ClaudexorApp.bundle"
SPM_BUNDLE="$APP_PKG/.build/release/$SPM_BUNDLE_NAME"
[ -d "$SPM_BUNDLE" ] || { echo "ERROR: SwiftPM resource bundle missing at $SPM_BUNDLE" >&2; exit 1; }
/usr/bin/ditto "$SPM_BUNDLE" "$APP/$SPM_BUNDLE_NAME"
[ -f "$APP/$SPM_BUNDLE_NAME/AppIcon.png" ] || { echo "ERROR: SwiftPM resource bundle is missing AppIcon.png" >&2; exit 1; }

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
  echo "==> Building engine workspace (pnpm -w build)"
  ( cd "$REPO_ROOT" && pnpm -w build >/dev/null )
  echo "==> Bundling claudexord (esbuild single-file)"
  # ESM->CJS shim: esbuild rewrites `import.meta.url` to undefined in CJS
  # output, which crashes createRequire(import.meta.url) at load (the v1.0.0
  # DMG shipped that crash). Define it to a banner-computed file URL so the
  # bundle behaves like the real ESM module.
  if ( cd "$REPO_ROOT" && pnpm exec esbuild packages/cli/dist/claudexord.js \
        --bundle --platform=node --format=cjs --target=node22 \
        --banner:js="const CLAUDEXOR_BUNDLE_URL = require('node:url').pathToFileURL(__filename).href;" \
        --define:import.meta.url=CLAUDEXOR_BUNDLE_URL \
        --outfile="$ENGINE_JS" >/dev/null ); then
    echo "    claudexord.bundle.cjs $(wc -c < "$ENGINE_JS" | tr -d ' ') bytes"
  else
    echo "ERROR: esbuild bundle failed; cannot build self-contained app" >&2
    exit 1
  fi
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
  if [ -x "$NODE_BIN" ]; then
    cp "$NODE_BIN" "$APP/Contents/Resources/node"; chmod +x "$APP/Contents/Resources/node"
    echo "    bundled node ($(du -h "$APP/Contents/Resources/node" | cut -f1 | tr -d ' '))"
  else
    echo "ERROR: no node found (looked at CLAUDEXOR_NODE_BIN, ~/.claudexor/node/bin/node, and PATH); set CLAUDEXOR_NODE_BIN or CLAUDEXOR_NO_ENGINE_BUNDLE=1" >&2
    exit 1
  fi

  # Boot smoke: the bundled daemon must actually START (a load-time crash in
  # the bundle shipped in v1.0.0 and survived every gate because nothing
  # executed the bundle). Scratch HOME so the smoke never touches real state.
  echo "==> Bundle boot smoke"
  SMOKE_HOME="$(mktemp -d)"
  ( HOME="$SMOKE_HOME" "$APP/Contents/Resources/node" "$ENGINE_JS" >/dev/null 2>"$SMOKE_HOME/smoke.err" & echo $! > "$SMOKE_HOME/pid" )
  SMOKE_OK=0
  for _ in $(seq 1 20); do
    if [ -f "$SMOKE_HOME/.claudexor/daemon/control-api.json" ]; then SMOKE_OK=1; break; fi
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
fi

if [ -n "${SIGN_IDENTITY:-}" ]; then
  echo "==> Codesigning with hardened runtime: $SIGN_IDENTITY"
  # Inside-out signing (NOT --deep: --deep re-signs nested code with the
  # APP's entitlements, which strips the JIT entitlements the bundled Node
  # needs under hardened runtime — V8 would be killed at startup).
  if [ -x "$APP/Contents/Resources/node" ]; then
    codesign --force --options runtime --timestamp \
      --entitlements "$PACKAGING/NodeRuntime.entitlements" \
      --sign "$SIGN_IDENTITY" "$APP/Contents/Resources/node"
  fi
  codesign --force --options runtime --timestamp \
    --entitlements "$PACKAGING/Claudexor.entitlements" \
    --sign "$SIGN_IDENTITY" "$APP"
  codesign --verify --strict --verbose=2 "$APP"

  if [ -n "${NOTARY_PROFILE:-}" ]; then
    echo "==> Notarizing via profile: $NOTARY_PROFILE"
    ZIP="$DIST/Claudexor.zip"
    /usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
    # NOTARY_KEYCHAIN: CI stores the profile in its ephemeral build keychain
    # (notarytool store-credentials --keychain); point lookups at it there.
    xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" \
      ${NOTARY_KEYCHAIN:+--keychain "$NOTARY_KEYCHAIN"} --wait
    xcrun stapler staple "$APP"
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
  STAGE="$DIST/dmg-stage"
  rm -rf "$STAGE" "$DMG"; mkdir -p "$STAGE"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -volname "Claudexor" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
  rm -rf "$STAGE"
  if [ -n "${SIGN_IDENTITY:-}" ]; then
    codesign --force --sign "$SIGN_IDENTITY" --timestamp "$DMG"
  else
    echo "    (unsigned DMG; Gatekeeper bypass instructions are in the README)"
  fi
  shasum -a 256 "$DMG" > "$DMG.sha256"
  echo "    DMG: $DMG"
  echo "    SHA256: $DMG.sha256"
fi

echo "==> Done: $APP"
