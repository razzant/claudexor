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

The app targets macOS 26 SDK features such as the Liquid Glass APIs
(`glassEffect`, `GlassEffectContainer`) and `.inspector`. (The shell is a
custom chat cockpit, not `NavigationSplitView` — see
`docs/DESIGN_SYSTEM.md` §3.) Use one of these setups:

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

Local builds without signing env produce `Claudexor-<version>-unsigned.zip`
and `Claudexor-<version>-unsigned.dmg`, with sibling `.sha256` checksum
files — Gatekeeper blocks those on other Macs (local smoke only). The
public GitHub Release assets are SIGNED + NOTARIZED + STAPLED (the CI build imports
the Developer ID certificate from repository secrets) and are built by
`.github/workflows/release.yml` on a macOS runner from the pushed tag/sha, then
attached to the draft release with `GITHUB_TOKEN`. Do not upload local
`apps/macos/dist` artifacts as final release assets. Release notes must also
call out the macOS 26 minimum.

`build-app.sh` also copies SwiftPM's generated
`ClaudexorApp_ClaudexorApp.bundle` into `Contents/Resources`, the only place it
can go: a copy at the `.app` root works unsigned, but codesign refuses
"unsealed contents present in the bundle root". SwiftPM's generated
`Bundle.module` accessor does NOT find it there — for an *executable* target
that accessor only checks `Bundle.main.bundleURL` (the `.app` root) and the
absolute `.build` directory of the machine that compiled it, then calls
`fatalError`. So the app resolves the bundle itself in
`AppDelegate.resourceBundle`, which prefers `Contents/Resources` and stays
optional. The release workflow unzips the release ZIP and fails if that
resource bundle is missing — note this proves presence, not loadability, so it
cannot catch a packaged app that ships the bundle but cannot open it.
The self-contained app also places `setup-login-runner.cjs` beside
`claudexord.bundle.cjs` and the bundled Node in `Contents/Resources`. Packaging
executes that runner with the bundled Node before the daemon boot smoke, so a
missing runner or broken direct-entry guard fails the build instead of shipping
a subscription login flow that can open Terminal and then hang.

The app is distributed outside the App Store because the engine-service launches
local harnesses and works with arbitrary repositories. The App Sandbox is not
enabled for that local control-plane model.

## Runtime Bridge

The app connects to the loopback control API for health, threads/turns, run
list/detail, primary output, timeline, budget snapshot, artifacts, harness
doctor, settings, secrets metadata, start/cancel, apply check, and SSE events.
AuthSheet delegates setup state to the ClaudexorKit lifecycle controller: it
GET-resnapshots before observing SSE, retries the stream up to five times,
recovers a background job with the filtered active-job lookup, and keeps native
source readiness separate from aggregate/API-key readiness. Closing an active
login offers Keep Running, Cancel Login, or Stay; cancellation stays visible
until the daemon proves the process ended. The vendor Terminal is intentionally
left open with its final result until the user presses Return.
Ask can run without a project and writes user-level artifacts; project-aware
modes are gated until a project is picked in the composer's `ProjectChip` (the
only place project selection lives — there is no Current Project setting).

Run detail uses the server-projected `primaryOutput` first, then artifact
fallbacks. Active runs default to Timeline, completed runs to Outcome, and
failures without output to Diagnostics. Cancel uses the server control endpoint
(`cancel` is the only control verb; the former `interrupt` alias was deleted as
a duplicate of cancel); live input forwarding is not part of the control surface
(the former input stub was removed as dead code), so the app shows no input UI
for active runs.

The trailing Workbench bridges two artifact planes: Run Detail reads the run's
internal tree via the artifacts endpoints, while the Canvas gallery and
mini-browser read the project's PRODUCED outputs via `GET /runs/:id/produced`
(bytes/text fetched per path through the same client). The composer sends
attachments (file picker + the `screencapture`-backed Capture button) as
attachment DTOs on turn creation, gated by an available vision-capable route;
the per-turn browser toggle arms the engine's agent-driven browser (offered
only when a pooled harness reports `browser_tool`). Ambiguity is handled by
the plan lifecycle: a plan turn surfaces typed open questions, answers ride
follow-up plan turns, and Implement freezes the plan (readiness-gated).

There is no sample/demo data mode: surfaces the engine does not fully expose
yet use honest empty states instead of pretending to be live.

The Per-Harness Defaults editor saves enable/disable, model override, effort,
web policy, per-harness budget cap (`maxUsd` per run), tool allow/deny lists,
and fallback model via the `HarnessSettingsPatch` DTO (which also carries
`maxTurns`/`maxRounds`); the per-harness turn/round caps remain
config-file/settings-API surfaces the editor UI does not yet expose.

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
