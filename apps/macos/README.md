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
    `events()` (SSE with `Last-Event-ID` resume), `health`.
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
cd apps/macos/ClaudexKit && swift build && swift test

# App (dev executable via SwiftPM); for a distributable bundle, build in Xcode 26.
```

## Design

The visual + interaction system is the SSOT in [`../../docs/DESIGN_SYSTEM.md`](../../docs/DESIGN_SYSTEM.md):
graphite-dark default, glass on the navigation layer only, per-harness candidate
colors, SF Pro/SF Mono, compact density, WCAG-AA contrast.

## Status

`ClaudexKit` is built and tested (Swift 6.3.1 via Swiftly; `swift build` + `swift test`
green, swift-testing). The SwiftUI app screens build on top of it next; a notarized
distributable `.app` is produced in Xcode 26.
