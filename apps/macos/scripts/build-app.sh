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

# On this macOS dev/release machine, Homebrew's ad-hoc-signed Node can be
# killed by the OS code-signing monitor during bundling. Prefer the official
# Claudexor runtime Node whenever it exists.
if [ -d "$HOME/.claudex/node/bin" ]; then
  export PATH="$HOME/.claudex/node/bin:$PATH"
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

# App icon (optional): drop an AppIcon.icns into packaging/ to include it.
if [ -f "$PACKAGING/AppIcon.icns" ]; then
  cp "$PACKAGING/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
else
  echo "    (no packaging/AppIcon.icns — bundle will use the default icon)"
fi

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
  if ( cd "$REPO_ROOT" && pnpm exec esbuild packages/cli/dist/claudexord.js --bundle --platform=node --format=cjs --target=node22 --outfile="$ENGINE_JS" >/dev/null ); then
    echo "    claudexord.bundle.cjs $(wc -c < "$ENGINE_JS" | tr -d ' ') bytes"
  else
    echo "ERROR: esbuild bundle failed; cannot build self-contained app" >&2
    exit 1
  fi
  NODE_BIN="${CLAUDEXOR_NODE_BIN:-$HOME/.claudex/node/bin/node}"
  if [ -x "$NODE_BIN" ]; then
    cp "$NODE_BIN" "$APP/Contents/Resources/node"; chmod +x "$APP/Contents/Resources/node"
    echo "    bundled node ($(du -h "$APP/Contents/Resources/node" | cut -f1 | tr -d ' '))"
  else
    echo "ERROR: notarized node not found at $NODE_BIN; set CLAUDEXOR_NODE_BIN or CLAUDEXOR_NO_ENGINE_BUNDLE=1" >&2
    exit 1
  fi
fi

if [ -n "${SIGN_IDENTITY:-}" ]; then
  echo "==> Codesigning with hardened runtime: $SIGN_IDENTITY"
  codesign --force --deep --options runtime --timestamp \
    --entitlements "$PACKAGING/Claudexor.entitlements" \
    --sign "$SIGN_IDENTITY" "$APP"
  codesign --verify --strict --verbose=2 "$APP"

  if [ -n "${NOTARY_PROFILE:-}" ]; then
    echo "==> Notarizing via profile: $NOTARY_PROFILE"
    ZIP="$DIST/Claudexor.zip"
    /usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
    xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
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
    echo "    (unsigned DMG; for beta/local distribution only)"
  fi
  shasum -a 256 "$DMG" > "$DMG.sha256"
  echo "    DMG: $DMG"
  echo "    SHA256: $DMG.sha256"
fi

echo "==> Done: $APP"
