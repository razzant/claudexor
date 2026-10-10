#!/usr/bin/env bash
# Build engine resources independently of the Swift app. Both app packaging and
# the runtime closure consume this exact staged tree; Node and UI are separate.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "$#" -eq 1 ] && [ -n "$1" ] || { echo "usage: build-engine-resources.sh NEW_DIRECTORY" >&2; exit 2; }
RESOURCES="$1"
# A fresh output tree prevents stale resources from entering either consumer.
mkdir "$RESOURCES"
RESOURCES="$(cd "$RESOURCES" && pwd -P)"
BUILD_SHA="${CLAUDEXOR_BUILD_SHA:-$(git -C "$REPO_ROOT" rev-parse HEAD)}"
ENGINE_JS="$RESOURCES/claudexord.bundle.cjs"
CLI_JS="$RESOURCES/claudexor.bundle.cjs"
SETUP_RUNNER_JS="$RESOURCES/setup-login-runner.cjs"
BROWSER_MCP_DIR="$RESOURCES/browser-mcp-runtime"
WIN32_CONPTY_SOURCE="${CLAUDEXOR_WIN32_CONPTY_HELPER:-}"
WIN32_CONPTY_EXPECTED_SHA256="${CLAUDEXOR_WIN32_CONPTY_SHA256:-}"
REQUIRE_WIN32_CONPTY="${CLAUDEXOR_REQUIRE_WIN32_CONPTY_HELPER:-0}"
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
      --bundle --platform=node --format=cjs --target=node24 \
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
      --bundle --platform=node --format=cjs --target=node24 \
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
      --bundle --platform=node --format=cjs --target=node24 \
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
if ( cd "$REPO_ROOT" && pnpm --filter @claudexor/core deploy --prod \
      --config.inject-workspace-packages=true --config.node-linker=hoisted "$BROWSER_MCP_DIR" >/dev/null ); then
  # The shared-lockfile deploy preserves exact versions in a hoisted layout.
  # Dereferencing pnpm's isolated links alone relocates packages away from their
  # dependency lookup context, breaking transitive requires in runtime archives.
  # A leftover isolated-layout self-link back to the source workspace is
  # redundant: this deployment already is @claudexor/core. Keep rejecting that
  # external destination even though the current deploy uses a hoisted layout.
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
if [ "$(uname -s)" = "Darwin" ]; then
  PROCESS_IDENTITY_HELPER="$RESOURCES/native/claudexor-process-identity"
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
fi
# Linux uses procfs identity and host PTY tools. Do not create an empty native
# directory that could masquerade as a complete universal update closure.
WIN32_CONPTY_SHA256=""
if [ -n "$WIN32_CONPTY_SOURCE" ]; then
  WIN32_CONPTY_HELPER="$RESOURCES/native/claudexor-conpty-helper.exe"
  VERIFY_CONPTY_ARGS=(--file "$WIN32_CONPTY_SOURCE")
  if [ -n "$WIN32_CONPTY_EXPECTED_SHA256" ]; then
    VERIFY_CONPTY_ARGS+=(--expected-sha256 "$WIN32_CONPTY_EXPECTED_SHA256")
  fi
  node "$REPO_ROOT/scripts/verify-win32-conpty-helper.mjs" "${VERIFY_CONPTY_ARGS[@]}"
  mkdir -p "$(dirname "$WIN32_CONPTY_HELPER")"
  cp "$WIN32_CONPTY_SOURCE" "$WIN32_CONPTY_HELPER"
  chmod 755 "$WIN32_CONPTY_HELPER"
  WIN32_CONPTY_SHA256="$(shasum -a 256 "$WIN32_CONPTY_HELPER" | awk '{print $1}')"
  node "$REPO_ROOT/scripts/verify-win32-conpty-helper.mjs" \
    --file "$WIN32_CONPTY_SOURCE" \
    --file "$WIN32_CONPTY_HELPER" \
    --expected-sha256 "$WIN32_CONPTY_SHA256"
  echo "    bundled Windows ConPTY helper (PE32+ x64, enclosing app resource seal only)"
elif [ "$REQUIRE_WIN32_CONPTY" = "1" ]; then
  echo "ERROR: candidate build requires CLAUDEXOR_WIN32_CONPTY_HELPER from the authoritative Windows build" >&2
  exit 1
fi

# Sign engine-owned Mach-O files ONCE before either consumer copies them.
# Re-signing the app's copies would break shared app/closure byte identity.
if [ "$(uname -s)" = "Darwin" ] && [ -n "${SIGN_IDENTITY:-}" ]; then
  for helper in "$RESOURCES/native/claudexor-process-identity" \
    "$RESOURCES/browser-mcp-runtime/dist/native/claudexor-process-identity"; do
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$helper"
    codesign --verify --strict --verbose=2 "$helper"
  done
fi
