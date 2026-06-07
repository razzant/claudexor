#!/usr/bin/env bash
#
# Assemble a distributable Claudex.app from the SwiftPM release build, and optionally
# codesign (Developer ID + hardened runtime), notarize, staple, and package a DMG.
#
# Dev builds run the executable directly (`swift run ClaudexApp`); this script is only for
# producing a shippable, notarized bundle. Signing/notarization are OPT-IN via env vars so
# the script also works for an unsigned local .app:
#
#   # unsigned local bundle:
#   apps/macos/scripts/build-app.sh
#
#   # signed + notarized + DMG (requires your Apple Developer ID):
#   SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
#   NOTARY_PROFILE="claudex-notary" \   # a stored `notarytool store-credentials` profile
#   MAKE_DMG=1 \
#   apps/macos/scripts/build-app.sh
#
# Notarization prerequisites (one-time, needs YOUR Apple ID — cannot be done for you):
#   xcrun notarytool store-credentials "claudex-notary" \
#     --apple-id "you@example.com" --team-id TEAMID --password <app-specific-password>
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MACOS_DIR="$(cd "$HERE/.." && pwd)"
APP_PKG="$MACOS_DIR/ClaudexApp"
PACKAGING="$MACOS_DIR/packaging"
DIST="$MACOS_DIR/dist"
APP="$DIST/Claudex.app"

VERSION="${CLAUDEX_VERSION:-0.2.0}"
BUILD="${CLAUDEX_BUILD:-$(date +%Y%m%d%H%M)}"

echo "==> Building release binary (Swift)"
( cd "$APP_PKG" && swift build -c release )
BIN="$APP_PKG/.build/release/ClaudexApp"
[ -x "$BIN" ] || { echo "ERROR: release binary not found at $BIN" >&2; exit 1; }

echo "==> Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/ClaudexApp"

# Info.plist with version substitution.
sed -e "s/__CLAUDEX_VERSION__/$VERSION/" -e "s/__CLAUDEX_BUILD__/$BUILD/" \
    "$PACKAGING/Info.plist" > "$APP/Contents/Info.plist"

# App icon (optional): drop an AppIcon.icns into packaging/ to include it.
if [ -f "$PACKAGING/AppIcon.icns" ]; then
  cp "$PACKAGING/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
else
  echo "    (no packaging/AppIcon.icns — bundle will use the default icon)"
fi

printf 'APPL????' > "$APP/Contents/PkgInfo"

# --- Bundle the engine-service so the .app is self-contained (one-click) ---
# A single-file esbuild bundle of claudexd + the notarized Node go into Resources; the app
# auto-starts them (DaemonLauncher) when nothing is serving the control-api. Skip with
# CLAUDEX_NO_ENGINE_BUNDLE=1 for a small app-only build.
if [ "${CLAUDEX_NO_ENGINE_BUNDLE:-0}" != "1" ]; then
  REPO_ROOT="$(cd "$MACOS_DIR/../.." && pwd)"
  ENGINE_JS="$APP/Contents/Resources/claudexd.bundle.cjs"
  echo "==> Bundling claudexd (esbuild single-file)"
  if [ ! -f "$REPO_ROOT/packages/cli/dist/claudexd.js" ]; then
    echo "    building TS first (pnpm -w build)"
    ( cd "$REPO_ROOT" && pnpm -w build >/dev/null )
  fi
  if ( cd "$REPO_ROOT" && pnpm exec esbuild packages/cli/dist/claudexd.js --bundle --platform=node --format=cjs --target=node22 --outfile="$ENGINE_JS" >/dev/null 2>&1 ); then
    echo "    claudexd.bundle.cjs $(wc -c < "$ENGINE_JS" | tr -d ' ') bytes"
  else
    echo "ERROR: esbuild bundle failed; cannot build self-contained app" >&2
    exit 1
  fi
  NODE_BIN="${CLAUDEX_NODE_BIN:-$HOME/.claudex/node/bin/node}"
  if [ -x "$NODE_BIN" ]; then
    cp "$NODE_BIN" "$APP/Contents/Resources/node"; chmod +x "$APP/Contents/Resources/node"
    echo "    bundled node ($(du -h "$APP/Contents/Resources/node" | cut -f1 | tr -d ' '))"
  else
    echo "ERROR: notarized node not found at $NODE_BIN; set CLAUDEX_NODE_BIN or CLAUDEX_NO_ENGINE_BUNDLE=1" >&2
    exit 1
  fi
fi

if [ -n "${SIGN_IDENTITY:-}" ]; then
  echo "==> Codesigning with hardened runtime: $SIGN_IDENTITY"
  codesign --force --deep --options runtime --timestamp \
    --entitlements "$PACKAGING/Claudex.entitlements" \
    --sign "$SIGN_IDENTITY" "$APP"
  codesign --verify --strict --verbose=2 "$APP"

  if [ -n "${NOTARY_PROFILE:-}" ]; then
    echo "==> Notarizing via profile: $NOTARY_PROFILE"
    ZIP="$DIST/Claudex.zip"
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

if [ "${MAKE_DMG:-0}" = "1" ]; then
  if [ -z "${SIGN_IDENTITY:-}" ] || [ -z "${NOTARY_PROFILE:-}" ]; then
    echo "ERROR: MAKE_DMG=1 requires SIGN_IDENTITY and NOTARY_PROFILE; unsigned local builds stop at .app" >&2
    exit 1
  fi
  echo "==> Building DMG"
  DMG="$DIST/Claudex-$VERSION.dmg"
  STAGE="$DIST/dmg-stage"
  rm -rf "$STAGE" "$DMG"; mkdir -p "$STAGE"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -volname "Claudex" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
  rm -rf "$STAGE"
  codesign --force --sign "$SIGN_IDENTITY" --timestamp "$DMG"
  echo "    DMG: $DMG"
fi

echo "==> Done: $APP"
