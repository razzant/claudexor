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
- `scripts/sign-local-app.sh` - ad-hoc root seal and strict verification for local bundles.
- `scripts/boot-smoke.sh` - packaged daemon boot smoke in a scrubbed scratch root.

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
# Local ad-hoc-signed bundle + ZIP (no Developer ID):
apps/macos/scripts/build-app.sh

# Local ad-hoc-signed bundle + ZIP + DMG (no Developer ID):
MAKE_DMG=1 apps/macos/scripts/build-app.sh

# Signed + notarized + DMG, when Developer ID credentials are configured locally:
xcrun notarytool store-credentials "claudexor-notary" \
  --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
NOTARY_PROFILE="claudexor-notary" MAKE_DMG=1 \
apps/macos/scripts/build-app.sh
```

The assembled `Claudexor.app` bundle lands in `apps/macos/dist/bundle.noindex/`
(the `.noindex` suffix keeps Spotlight from indexing dev builds as launchable
apps), while the DMG/ZIP artifacts and their checksums stay directly in
`apps/macos/dist/`.
Local builds without `SIGN_IDENTITY` ad-hoc sign and strictly verify the root
`.app` bundle after assembly. This seals bundle resources while leaving nested
executable bytes, existing signatures, and entitlements unchanged. Root verification
does not independently verify the signatures of executables stored in `Resources`;
the build's execution probes remain separate checks of the bundled runtime.
System or custom Node binaries do not need a signature for this local sealing step.

Local artifacts keep the names `Claudexor-<version>-unsigned.zip` and
`Claudexor-<version>-unsigned.dmg`, with sibling `.sha256` checksum files:
`-unsigned` here means no Developer ID signing, despite the ad-hoc root seal.
These are local smoke artifacts. Successful signature verification proves bundle
integrity; app/engine startup and distribution trust require separate checks.
Ad-hoc signing provides neither Developer ID trust nor notarization, and Gatekeeper
may block quarantined copies even on the build Mac. The public GitHub Release assets
are SIGNED + NOTARIZED + STAPLED. `.github/workflows/release.yml` builds them on a
macOS runner from the pushed tag/sha, imports the Developer ID certificate from
repository secrets, and attaches them to the draft release with `GITHUB_TOKEN`. Do not upload local
`apps/macos/dist` artifacts as final release assets. Release notes must also
call out the macOS 26 minimum.

`build-app.sh` also copies SwiftPM's generated
`ClaudexorApp_ClaudexorApp.bundle` into `Contents/Resources`, the only place it
can go: a copy at the `.app` root works unsigned, but codesign refuses
"unsealed contents present in the bundle root". SwiftPM's generated
`Bundle.module` accessor does NOT find it there — for an *executable* target
that accessor only checks `Bundle.main.bundleURL` (the `.app` root) and the
absolute `.build` directory of the machine that compiled it, then calls
`fatalError`. So the app never touches `Bundle.module` on the launch path:
`AppDelegate.devIconURL` resolves the icon by plain file path (preferring
`Contents/Resources`), and it stays optional — a missing bundle means no dev
icon, never a trap. The release workflow unzips the release ZIP and fails if that
resource bundle is missing — note this proves presence, not loadability, so it
cannot catch a packaged app that ships the bundle but cannot open it.
The self-contained app also places `setup-login-runner.cjs` beside
`claudexord.bundle.cjs` and the bundled Node in `Contents/Resources`. Packaging
executes that runner with the bundled Node before the daemon boot smoke, so a
missing runner or broken direct-entry guard fails the build instead of shipping
a subscription login flow that can open Terminal and then hang.
The boot smoke (`scripts/boot-smoke.sh`) then starts the packaged daemon entry
with the bundled Node in an empty environment holding only a short scratch
`HOME` and a fixed `PATH`, so an exported `CLAUDEXOR_CONFIG_DIR`, socket or
control-API override, `NODE_OPTIONS` or provider key cannot reach it. It waits
for control-api discovery in the default root derived from that `HOME`, then
stops and reaps the daemon before deleting the root. A daemon that exits before
it is stopped or needs SIGKILL fails the build; if even SIGKILL cannot be
confirmed, the root is kept for inspection. Discovery is published before normal
admission opens, so a pass shows that the bundle starts and binds its
transports, not that the engine reached normal readiness.

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

Each turn keeps a persistent inline receipt in the conversation. Its answer uses
the server-projected `primaryOutput` first, then artifact fallbacks; active runs
show live progress, completed runs show Outcome facts, and failures without
output show Diagnostics. Selecting a receipt filters the trailing workspace to
that run. Cancel uses the server control endpoint (`cancel` is the only control
verb; the former `interrupt` alias was deleted as a duplicate of cancel); live
input forwarding is not part of the control surface (the former input stub was
removed as dead code), so the app shows no input UI for active runs.

The trailing workspace belongs to the current thread and has three always-present
tabs: Changes, Artifacts, and Evidence. A thread executing on a remote location
adds a fourth, Terminal; it is never shown for local threads. It aggregates the
thread's runs until a receipt filters it. Project-produced outputs from `GET /runs/:id/produced` fill the
Artifacts gallery, including project preview; internal run-tree artifacts stay
with diagnostics under Evidence. There is no separate Canvas plane or two-plane
Workbench. The composer sends
attachments (file picker + the `screencapture`-backed Capture button) as
attachment DTOs on turn creation, gated by an available vision-capable route;
the per-turn browser toggle arms the engine's agent-driven browser (offered
only when a pooled harness reports `browser_tool`). Ambiguity is handled by
the plan lifecycle: a plan turn surfaces typed open questions, answers ride
follow-up plan turns, and Implement freezes the plan (readiness-gated).

There is no sample/demo data mode: surfaces the engine does not fully expose
yet use honest empty states instead of pretending to be live.

The Per-Harness Defaults editor saves enable/disable, model override, effort,
web policy, tool allow/deny lists, and fallback model via the
`HarnessSettingsPatch` DTO (which also carries `maxTurns`/`maxRounds`); the
per-harness turn/round caps remain config-file/settings-API surfaces the editor
UI does not yet expose. There is no per-harness budget cap: the global
`budget.paid_budget_per_run` and the per-run `--max-usd` cover run spend.

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
