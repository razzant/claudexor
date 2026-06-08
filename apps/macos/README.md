# Claudex For macOS

The macOS app is a native SwiftUI control surface for Claudex. It talks to the
local loopback control API and displays the same runs, artifacts, harness status,
settings, and diagnostics that the CLI/daemon expose. The TypeScript control
plane in `packages/*` remains the source of truth.

This tree lives outside the pnpm workspace glob (`packages/*`), so pnpm/Turbo do
not build it as part of normal package tasks.

## Layout

- `ClaudexKit/` - SwiftPM library for the control API client and DTOs.
- `ClaudexApp/` - SwiftUI app.
- `packaging/` - app bundle metadata, entitlements, and LaunchAgent template.
- `scripts/build-app.sh` - local/release app packaging script.

## Toolchain

The app targets macOS 26 SDK features such as Liquid Glass APIs,
`NavigationSplitView`, and `.inspector`. Use one of these setups:

1. Full Xcode 26 for distribution builds and notarization.
2. Swiftly + swift.org Swift 6.3+ for local SwiftPM build/test work.

With Swiftly:

```bash
curl -O https://download.swift.org/swiftly/darwin/swiftly.pkg
installer -pkg swiftly.pkg -target CurrentUserHomeDirectory
~/.swiftly/bin/swiftly init --skip-install
~/.swiftly/bin/swiftly install 6.3.1
export PATH="$HOME/.swiftly/bin:$PATH"
```

## Build And Run

```bash
export PATH="$HOME/.swiftly/bin:$PATH"
cd apps/macos/ClaudexKit && swift build && swift test
cd ../ClaudexApp && swift run ClaudexApp
```

Dev/QA env switches:

- `CLAUDEX_DEBUG_ROUTE`: jump to a screen such as `tasks`, `task`, `review`,
  `budget`, `harnesses`, `benchmarks`, `settings`, or `composer`.
- `CLAUDEX_DEBUG_SIZE="WxH"`: deterministic window size.
- `CLAUDEX_DEBUG_APPEARANCE=light|dark`: deterministic appearance.

## Packaging

```bash
# Unsigned local bundle + ZIP:
apps/macos/scripts/build-app.sh

# Unsigned local bundle + ZIP + DMG:
MAKE_DMG=1 apps/macos/scripts/build-app.sh

# Signed + notarized + DMG, when Developer ID credentials are configured locally:
xcrun notarytool store-credentials "claudex-notary" \
  --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
NOTARY_PROFILE="claudex-notary" MAKE_DMG=1 \
apps/macos/scripts/build-app.sh
```

The app is distributed outside the App Store because the engine-service launches
local harnesses and works with arbitrary repositories. The App Sandbox is not
enabled for that local control-plane model.

## Runtime Bridge

The app connects to the loopback control API for health, run list/detail,
artifacts, harness doctor, settings, secrets metadata, start/cancel, apply check,
and SSE events. Ask can run without a Current Project and writes user-level
artifacts; project-aware modes are gated until Current Project is selected.

Sample data is off by default behind Settings. Surfaces the engine does not
fully expose yet use honest empty states instead of pretending to be live.

## Design And Contributor Docs

- [`../../CLAUDEX_BIBLE.md`](../../CLAUDEX_BIBLE.md) - product principles.
- [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) - runtime and
  package map.
- [`../../docs/DESIGN_SYSTEM.md`](../../docs/DESIGN_SYSTEM.md) - macOS visual
  and interaction contract.
- [`../../docs/DEVELOPMENT.md`](../../docs/DEVELOPMENT.md) - contributor
  workflow.
- [`../../docs/CHECKLISTS.md`](../../docs/CHECKLISTS.md) - visual QA, release,
  docs, schema, and security gates.
