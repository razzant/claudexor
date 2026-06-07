# Claudex for macOS

Native SwiftUI mission-control for Claudex (Liquid Glass, macOS 26 Tahoe). It is a
thin client of the local Claudex engine-service over the loopback control-api
(`@claudex/control-api`, HTTP+SSE). The TypeScript control plane in `packages/*` is
the source of truth; this app observes and drives runs.

This tree lives OUTSIDE the pnpm workspace glob (`packages/*`), so pnpm/Turbo never
see it — the CLI-first toolchain stays unaffected.

## Layout

- `ClaudexKit/` — SwiftPM library (no SwiftUI): the control-api client.
  - `JSONValue.swift` — dynamic Codable JSON for loosely-typed event payloads.
  - `Models.swift` — minimal client DTOs (SSE `BusEnvelope`, `StartRunRequest`, …).
  - `GatewayClient.swift` — async URLSession client: `startRun`, `cancel`, `listRuns`,
    `runDetail`, `listHarnesses`, `applyCheck`, `setSecret`, `events()` (SSE with
    `Last-Event-ID` resume), `health`.
- `ClaudexApp/` — the SwiftUI app (added in the Xcode-buildable phase; see below).

## Toolchain

The macOS 26 SDK (which ships Liquid Glass APIs: `glassEffect`, `GlassEffectContainer`,
`NavigationSplitView` + `.inspector`, …) must be paired with a matching Swift toolchain
(6.3+). Two working setups:

1. **Full Xcode 26** (needed to produce a notarized `.app` bundle for distribution):
   `sudo xcode-select -s /Applications/Xcode.app`.
2. **Swiftly + swift.org toolchain (no sudo, no Xcode — used for dev/CI here):**
   ```bash
   curl -O https://download.swift.org/swiftly/darwin/swiftly.pkg
   installer -pkg swiftly.pkg -target CurrentUserHomeDirectory
   ~/.swiftly/bin/swiftly init --skip-install
   ~/.swiftly/bin/swiftly install 6.3.1   # matches the macOS 26.4 SDK
   ```
   Then `export PATH="$HOME/.swiftly/bin:$PATH"`. This builds + tests the SwiftPM
   targets (library and the SwiftUI app as a dev executable). A Command Line Tools–only
   environment whose `swiftc` predates the SDK will NOT work (the compiler rejects the
   newer SDK's stdlib) — use one of the two setups above.

## Build

```bash
export PATH="$HOME/.swiftly/bin:$PATH"   # if using the Swiftly setup
cd apps/macos/ClaudexKit && swift build && swift test     # client library + tests

cd apps/macos/ClaudexApp && swift run ClaudexApp          # run the app (dev)
```

Dev/QA env switches (no effect unless set): `CLAUDEX_DEBUG_ROUTE` (jump to a screen:
`tasks|task|interview|review|budget|harnesses|benchmarks|settings|composer`),
`CLAUDEX_DEBUG_SIZE="WxH"` (deterministic window size), `CLAUDEX_DEBUG_APPEARANCE`
(`light|dark`).

## Packaging & distribution (Developer ID + notarization, no App Sandbox)

A real `.app`/DMG is assembled from the release binary by `scripts/build-app.sh` using the
files in `packaging/` (`Info.plist`, `Claudex.entitlements`, `com.claudex.claudexd.plist`).
We ship **outside** the App Store with Developer ID + hardened runtime + notarization and do
**not** enable the App Sandbox — the engine-service spawns native harnesses and touches
arbitrary repos, which the sandbox can't express (see `docs/DECISIONS.md`).

```bash
# Unsigned local bundle (Gatekeeper-blocked on other machines):
apps/macos/scripts/build-app.sh            # → apps/macos/dist/Claudex.app

# Signed + notarized + DMG (needs YOUR Apple Developer ID — cannot be done for you):
xcrun notarytool store-credentials "claudex-notary" \
  --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
NOTARY_PROFILE="claudex-notary" MAKE_DMG=1 \
apps/macos/scripts/build-app.sh            # → signed, stapled .app + Claudex-<v>.dmg
```

The engine-service can be kept alive across logins via the `com.claudex.claudexd` LaunchAgent
template (install to `~/Library/LaunchAgents/`, or register it from the app bundle with
`SMAppService.agent(plistName:)`). The app does not require it — it connects to `claudexd`
whenever it is running.

## Design

The visual + interaction system is the SSOT in [`../../docs/DESIGN_SYSTEM.md`](../../docs/DESIGN_SYSTEM.md):
graphite-dark default, glass on the navigation layer only, per-harness candidate
colors, SF Pro/SF Mono, compact density, WCAG-AA contrast.

## Status (honest)

`ClaudexKit` builds + tests green (Swift 6.3.1 via Swiftly, swift-testing). `ClaudexApp`
is a **macOS prototype** of a Liquid Glass mission-control: composer-led Home (default Ask),
Tasks inbox, Task detail (Plan/Activity/Candidates/Diff/Review), table-first Review queue,
Budget, Harnesses, Benchmarks, native Settings, and onboarding — adaptive `NavigationSplitView` (sidebar/content/inspector)
that reflows cleanly from the 3-pane minimum upward, with a disciplined palette (steel-blue
brand + graphite; **official harness logos + colors** only on harness UI; semantic status).

Live bridge (real, partial):

- Connects to the loopback control-api: health, run list/detail/artifacts, harness doctor,
  **start** (with composer policy — eligible pool, Primary, portfolio, model hint, budget cap,
  access profile, gate commands — forwarded through `daemon.enqueue` to the orchestrator),
  **cancel**, secret setting for onboarding, and the **SSE stream** (parsed from the daemon's canonical
  `events.jsonl` types: `run.*`, `harness.*`, `gate.*`, `review.*`, `budget.*` → live
  status, phase, activity, spend, and findings).
- **Sample data is OFF by default** behind Settings → "Show sample data". Surfaces the
  engine doesn't expose yet (budget live ledger, benchmarks, the GUI spec interview)
  show honest empty states when sample data is off; they are previews, not live.

`scripts/build-app.sh` produces a `.app`/DMG; notarization needs a Developer ID.
