# Claudexor For macOS

The macOS app is a native SwiftUI control surface for Claudexor. It talks to the
local loopback control API and displays the same runs, artifacts, harness status,
settings, and diagnostics that the CLI/daemon expose. The TypeScript control
plane in `packages/*` remains the source of truth.

This tree lives outside the pnpm workspace glob (`packages/*`), so pnpm/Turbo do
not build it as part of normal package tasks.

## Layout

- `ClaudexorKit/` - SwiftPM library for the control API client and DTOs.
- `ClaudexorApp/` - SwiftUI app.
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
cd apps/macos/ClaudexorKit && swift build && swift test
cd ../ClaudexorApp && swift run ClaudexorApp
```

Dev/QA env switches:

- `CLAUDEXOR_DEBUG_ROUTE`: open a run's inspector for deterministic screenshots.
  The code handles `task` and `convergence` (each opens a sample run's detail);
  setting any value also turns on sample data. The older per-screen routes were
  removed in the v0.10 chat-first collapse.
- `CLAUDEXOR_DEBUG_SIZE="WxH"`: deterministic window size.
- `CLAUDEXOR_DEBUG_APPEARANCE=light|dark`: deterministic appearance.

## Packaging

```bash
# Unsigned local bundle + ZIP:
apps/macos/scripts/build-app.sh

# Unsigned local bundle + ZIP + DMG:
MAKE_DMG=1 apps/macos/scripts/build-app.sh

# Signed + notarized + DMG, when Developer ID credentials are configured locally:
xcrun notarytool store-credentials "claudexor-notary" \
  --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
NOTARY_PROFILE="claudexor-notary" MAKE_DMG=1 \
apps/macos/scripts/build-app.sh
```

Unsigned artifacts are named `Claudexor-<version>-unsigned.zip` and
`Claudexor-<version>-unsigned.dmg`, with sibling `.sha256` checksum files. They
are beta/local smoke artifacts:
Gatekeeper can block them on other Macs until a signed/notarized build is
produced. The public GitHub Release assets are built by
`.github/workflows/release.yml` on a macOS runner from the pushed tag/sha, then
attached to the draft release with `GITHUB_TOKEN`. Do not upload local
`apps/macos/dist` artifacts as final release assets. Release notes must also
call out the macOS 26 minimum.

`build-app.sh` also copies SwiftPM's generated
`ClaudexorApp_ClaudexorApp.bundle` next to the `.app` root because the generated
`Bundle.module` accessor looks there before falling back to an absolute `.build`
path from the build machine. The release workflow unzips the release ZIP and
fails if that resource bundle is missing, so an artifact cannot pass merely
because it launches inside the original repo checkout.

The app is distributed outside the App Store because the engine-service launches
local harnesses and works with arbitrary repositories. The App Sandbox is not
enabled for that local control-plane model.

## Runtime Bridge

The app connects to the loopback control API for health, run list/detail,
primary output, timeline, budget snapshot, artifacts, harness doctor, settings,
secrets metadata, start/cancel, apply check, and SSE events. Ask can run without
a Current Project and writes user-level artifacts; project-aware modes are gated
until Current Project is selected.

Run detail uses the server-projected `primaryOutput` first, then artifact
fallbacks. Active runs default to Timeline, completed runs to Outcome, and
failures without output to Diagnostics. Cancel/interrupt uses the server control
endpoint; live input forwarding is not part of the control surface (the former
input stub was removed in v0.7.0), so the app shows no input UI for active runs.

Sample data is off by default behind Settings. Surfaces the engine does not
fully expose yet use honest empty states instead of pretending to be live.

The Per-Harness Defaults editor saves enable/disable, model override, effort,
web policy, per-harness budget cap (`maxUsd` per run), tool allow/deny lists,
and fallback model via the `HarnessSettingsPatch` DTO. The remaining engine
knobs (per-harness turn/round caps) stay config-file/settings-API surfaces this
editor does not yet expose.

## Design And Contributor Docs

- [`../../CLAUDEXOR_BIBLE.md`](../../CLAUDEXOR_BIBLE.md) - product principles.
- [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) - runtime and
  package map.
- [`../../docs/DESIGN_SYSTEM.md`](../../docs/DESIGN_SYSTEM.md) - macOS visual
  and interaction contract.
- [`../../docs/DEVELOPMENT.md`](../../docs/DEVELOPMENT.md) - contributor
  workflow.
- [`../../docs/CHECKLISTS.md`](../../docs/CHECKLISTS.md) - visual QA, release,
  docs, schema, and security gates.
