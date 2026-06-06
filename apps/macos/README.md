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

## Toolchain requirement (important)

Building the macOS app requires **Xcode 26** (macOS 26 SDK + the matching Swift
toolchain) on an Apple Silicon Mac. Liquid Glass APIs (`glassEffect`,
`GlassEffectContainer`, `NavigationSplitView` + `.inspector`, …) need the macOS 26 SDK.

> Note: a Command Line Tools–only environment whose Swift compiler predates the macOS
> 26 SDK cannot build this (the compiler rejects the newer SDK's stdlib, and SwiftPM's
> llbuild may be mismatched). Install full Xcode 26 and select it with
> `sudo xcode-select -s /Applications/Xcode.app`.

## Build

```bash
# Library (once a matching toolchain is active):
cd apps/macos/ClaudexKit && swift build && swift test

# App: open the generated Xcode project (XcodeGen project.yml) in Xcode 26.
```

## Design

The visual + interaction system is the SSOT in [`../../docs/DESIGN_SYSTEM.md`](../../docs/DESIGN_SYSTEM.md):
graphite-dark default, glass on the navigation layer only, per-harness candidate
colors, SF Pro/SF Mono, compact density, WCAG-AA contrast.

## Status

`ClaudexKit` sources are written but **not yet compiled in this environment** (no
matching Swift toolchain here). They must be built/validated on a machine with
Xcode 26 before they are trusted. The SwiftUI app screens are added in that phase.
