# Developing Claudexor

This document is for contributors changing Claudexor itself. It is not a guide for
using Claudexor on a target project. User-facing behavior belongs in the README
and the current runtime map belongs in `docs/ARCHITECTURE.md`.

Read these together before changing shared behavior:

- `CLAUDEXOR_BIBLE.md` - product and engineering invariants.
- `docs/ARCHITECTURE.md` - current package map, run flow, artifacts, and
  control API.
- `docs/WHITEPAPER.md` - public rationale and architecture narrative; keep it
  current when runtime, harness, auth/setup, observability, budget, orchestration,
  or permission behavior changes.
- `docs/DESIGN_SYSTEM.md` - macOS visual and interaction contract.
- `docs/CHECKLISTS.md` - human gates for reviews, releases, docs, visual QA,
  and security.

## Repository Shape

- `packages/schema` owns Zod schemas, TypeScript types, and generated JSON
  Schema. Change data contracts here first.
- `packages/util` owns shared helpers (ids, hashing, redaction, config dirs).
- `packages/core` owns adapter contracts, the shared CLI run loop, process
  helpers, typed errors, the doctor runner, and the stream conformance
  validator.
- `packages/orchestrator` owns the three canonical intent pipelines (ask, plan,
  agent) with their strategy flags (ask deep-scan, plan solo/council, agent
  race width, attempt caps, until-clean, create, delegate), plus run telemetry
  and policy gates.
- `packages/gateway` owns harness discovery, doctor output, and capability
  gating.
- `packages/harness-*` translate native CLI/API streams into typed events. They
  do not select winners, manage budgets, or decide review policy. Each has a
  `fixtures/` dir backing its conformance parity test.
- `packages/workspace` owns Git and directory envelopes, scoped harness homes,
  byte-faithful diff/file capture, and cleanup.
- `packages/policy` owns typed risk classification, protected-path rules, and
  the workspace path guard.
- `packages/context` owns the scope atlas and lazy ContextPack.
- `packages/config` owns layered config loading (global, project, user trust).
- `packages/review`, `packages/arbitration`, `packages/synthesis`,
  `packages/budget`, `packages/secrets`, and `packages/delivery` own their
  named control-plane subsystems.
- `packages/artifact-store` and `packages/event-log` own run artifact trees and
  the append-only event log.
- `packages/claudexor` is the bare-name bin wrapper over `@claudexor/cli`
  (the only package that installs the global `claudexor`/`claudexord` bins).
- `packages/cli`, `packages/daemon`, `packages/control-api`,
  `packages/mcp-server`, `packages/acp-server`, and `apps/macos` are surfaces.
  Keep them thin.
- `packages/canary` holds the canary golden stories: user-level E2E smokes
  over the built CLI with offline fake harnesses, pinned to Bible invariant
  tags (`pnpm canary`).
- `benchmarks/runner` holds the SWE-bench benchmark runner and is part of the
  pnpm workspace.

## Development Commands

Use the repository package manager and keep generated schema output checked.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm typecheck:tests   # type-checks *.test.ts, schema scripts, and canary sources
pnpm test
pnpm schema:gen
git diff --exit-code packages/schema/generated
node scripts/validate-generated-schemas.mjs   # ajv-compiles every generated schema (draft-07)
pnpm docs:check    # docs-truth gate (endpoints / mode ids / CLI flags vs source)
pnpm staged:check  # staged-field gate (comments do not count as consumers)
pnpm knip          # dead exports / unused files / unused dependencies gate
node scripts/mcp-cli-parity-check.mjs # MCP tool args <-> CLI run-control flags parity (stale-schema class)
node scripts/artifact-text-parity-check.mjs # server SEMANTIC_TEXT_EXTENSIONS <-> Swift set parity (QA-067)
node scripts/fixture-freshness-check.mjs # fixture provenance manifests + recorded-vs-installed CLI drift
node scripts/complexity-ratchet.mjs   # readability ratchet: tracked files may only shrink
node scripts/model-hints-freshness.mjs # manifest known_models vs installed vendor CLIs (release: --strict)
pnpm canary        # canary golden stories (offline fake harnesses; needs pnpm build first)
```

There is no root `pnpm lint` script at the moment. `pnpm format:check` checks
Prettier formatting when a formatting pass is relevant. Note on Node versions:
`.node-version` pins the DEV toolchain (24.16.0, matching CI); the root
`engines.node >= 20.19.0` is the published-package compatibility floor — the
split is intentional, do not "reconcile" them. CI runs the full Node battery
on both 20.19.0 and 24.16.0; publication repeats a clean installed-package CLI
smoke on both versions before the GitHub Release becomes public.

macOS app checks:

```bash
cd apps/macos/ClaudexorKit && swift test
cd ../ClaudexorApp && swift test && swift build
```

Release verification is wrapped by:

```bash
pnpm release:verify
```

This is the portable Node/schema/documentation gate. Native platform checks run
in GitHub CI; `pnpm release:verify:macos` adds optional local Swift and unsigned
app checks. Installed-vendor fixture/model freshness is diagnostic by default;
`pnpm release:verify:vendors` opts into strict comparison when the relevant
vendor CLIs are available. A missing local vendor CLI is not a contribution
blocker.

The workflow has two manual modes. `candidate` accepts a full commit SHA and
builds/signs/notarizes/attests without publishing. `publish` accepts an annotated
stable tag on exact `origin/main`, the successful candidate run id, a
`review_url` reference to the full independent report and dispositions, and
`review_confirmed: true` from the responsible maintainer. GitHub authenticates
the dispatcher; the confirmation attests that they read and checked the review
of this exact candidate, not that CI can measure review quality. The reference
may be a PR or private CI artifact, without publishing private user dialogue or
using a credential-bearing URL. The release protocol lives in CHECKLISTS.
Historical signed review artifacts remain readable but are not publish inputs;
their version-specific waiver switches are retired.

Publish promotes the candidate DMG, ZIP, SBOM and runtime archives byte-for-byte,
never rebuilding accepted app or engine bytes. Runtime manifests remain signed
independently, as described below. Missing signing/notary/npm credentials fail;
there is no unsigned or GitHub-only fallback. npm packages publish in dependency
order with provenance. An existing package is accepted only when its signed npm
provenance binds this repository's release workflow, exact tag/commit and published
digest; a collision fails. Eventual-consistency reads are bounded. The GitHub
Release stays draft until all publication checks pass, rejects differing
same-name assets, and becomes public as the final mutation. Published releases
are never edited. Versions still use changesets and the fixed lockstep group.

The `publish` mode carries the OWNER-SIGNED runtime-update manifest (D-2),
transported as a base64 workflow-dispatch input. The candidate run builds the
engine-runtime closure and an UNSIGNED `runtime-manifest.json`; on a trusted
machine the owner signs it offline against the exact promoted-artifact digest:

```
# The candidate's unsigned manifest and the promoted runtime archive digest:
pnpm sign:runtime-manifest \
  --in       runtime-manifest.json \
  --sha256   <sha256 of the promoted claudexor-runtime-<v>.tar.gz> \
  --private-key ~/.claudexor/keys/runtime-update-ed25519.pem \
  --authority   release/runtime-update-authority.json \
  --out         runtime-manifest.signed.json
```

The private key is the dedicated OFFLINE runtime-update Ed25519 key (never on
CI); the signer refuses any unstamped/
placeholder field and self-verifies. Publish also takes the `candidate_run_id`
input (the candidate workflow run whose artifact is promoted): it downloads that
run's EXACT closure bytes (never a publish rebuild, A-5), verifies their build
provenance, then runs `scripts/verify-signed-runtime-manifest.mjs`, which ships
the signed manifest ONLY if its signature verifies against the pinned
`release/runtime-update-authority.json`, its `sha256` byte-matches the promoted
tarball, and its non-secret fields equal the candidate's unsigned manifest. A
wrong or expired (14-day artifact retention) run id fails the download.
Only publish ships the signed runtime manifest; the candidate app is signed
separately for testing and exact-byte promotion.
Rotate the key by minting a new keypair, bumping its `keyId`, and shipping the
new public half in a signed DMG.

The engine closure is also the supported host-embedding payload. Do not add a
second embed archive or trust root: `scripts/build-runtime-closure.mjs`
materializes contained package links from the shared engine-resource stage and
emits a regular-file/directory-only tarball for extractors without POSIX
symlink semantics. It rejects escaping links, special files, and `.node`
addons. The closure includes both top-level `claudexord.bundle.cjs` and
`claudexor.bundle.cjs`, while Node remains host-owned. Embedders keep one exact
tested full Node toolchain plus protocol/separate daemon-and-CLI
entrypoints/size in their reviewed pin; POSIX local harness installation
requires the adjacent `lib/node_modules/npm/bin/npm-cli.js` from that same
toolchain and must never fall back to ambient PATH npm. The npm `engines` range
is not closure-smoke evidence. The existing signed manifest is the publication
authority used to form that pin; runtime consumers may verify it directly or
rely on a review-bound exact URL/`buildSha`/SHA-256/size pin, without a second
manifest or verifier. The focused builder test must cover an internal link's
expected materialized bytes and an escaping-link refusal. A Windows claim also
requires a native extract/exact-Node probe/isolated handshake/graceful-stop
smoke; feature support must not be inferred from portable extraction alone,
and local Windows harness installation remains typed-unsupported until its own
bounded support contract exists.

The `publish` mode also carries `remote_runtime_manifest_b64`:
the OWNER-SIGNED four-target SSH runtime manifest, transported the same way.
The candidate run builds the four remote runtime archives
(`claudexor-remote-runtime-<v>-{linux-x64,linux-arm64,darwin-x64,darwin-arm64}.tar.gz`)
plus an UNSIGNED `remote-runtime-manifest.json`; the owner downloads the
promoted candidate assets and signs offline:

```
pnpm sign:remote-runtime-manifest \
  --in remote-runtime-manifest.json \
  --assets-dir <promoted-assets-dir> \
  --private-key ~/.claudexor/keys/runtime-update-ed25519.pem \
  --authority release/runtime-update-authority.json \
  --out remote-runtime-manifest.signed.json
```

`--in` is the candidate's unsigned manifest; `--assets-dir` is the directory
holding the four promoted
`claudexor-remote-runtime-<v>-<target>.tar.gz` archives.

The same OFFLINE runtime-update key signs both manifest kinds; domain
separation is the signed `kind` field (`claudexor-remote-runtime`), which the
engine manifest's signed bytes never contain. The signer refuses to read the
private key until all four exactly-named archives sit in `--assets-dir` as
nonempty regular files (no symlinks) whose digests match the unsigned
manifest. In the publish run the promoted candidate artifact is an exact
TWELVE-asset set (DMG, ZIP, app SBOM, SHA256SUMS, engine closure + unsigned
runtime manifest, four remote archives, unsigned remote manifest, remote
SBOM); one early `gh attestation verify` loop — the single provenance owner —
verifies every one of them against the candidate run before ANY later step
copies or extracts them. Publish then runs
`scripts/verify-signed-remote-runtime-manifest.mjs` (pinned-authority
signature, per-archive digest match against the promoted bytes, field equality
with the candidate's unsigned manifest), regenerates the remote SBOM
deterministically from the promoted unsigned manifest, `cmp`s it against the
provenance-verified candidate SBOM, and ships the CANDIDATE bytes (A-5).

Historical release exceptions and signed review envelopes remain archival
facts of their original commits. They cannot authorize a new release. Current
publication always requires both validly signed runtime manifests; the
signature-reading helpers and test vectors preserve historical review evidence
without making its old panel or sealing ceremony a current gate.

RESTART `claudexord` AFTER REBUILDING: the daemon loads the engine at start
and serves that build until stopped — a long-lived daemon silently runs
pre-rebuild code (`claudexor daemon stop` and let the next command
auto-start it). This trap has silently invalidated dogfood runs; restart the
daemon after every rebuild.

### Local toolchain notes

The build scripts prefer machine-local toolchains when present and fall back to
the system ones, so CI and other machines work unchanged:

- On macOS, some setups kill ad-hoc-signed Homebrew Node during bundling.
  `apps/macos/scripts/build-app.sh` therefore prefers a notarized Node: set
  `CLAUDEXOR_NODE_BIN`, or place one under `~/.claudexor/node/bin` (probed
  automatically); otherwise it falls back to the `node` on `PATH`. That
  fallback is now a HARD FAIL, not a warning, when the selected Node links
  `libnode` dynamically (an `otool -L` check): a non-self-contained Node
  bundles a dead binary that crashes the packaged app, so the build stops and
  names the `CLAUDEXOR_NODE_BIN` remedy. CI is unaffected — the release
  workflow always sets `CLAUDEXOR_NODE_BIN`.
- If the Xcode Command Line Tools `swift-package` crashes with a dyld llbuild
  symbol error, use a Swiftly-managed toolchain
  (`PATH="$HOME/.swiftly/bin:$PATH" swift build`).
- `claudexor doctor` surfaces a non-gating advisory when the running Node is an
  at-risk Homebrew build on macOS; set `CLAUDEXOR_NODE_BIN` (or put a notarized
  Node first on `PATH`) to silence it. At run time the harness spawn PATH also
  prepends the directory of the Node the daemon itself runs on (the notarized
  app-bundled runtime), so a vendor CLI's inner login shell resolves that same
  working Node instead of an ad-hoc Homebrew one it would otherwise SIGKILL; see
  `docs/ARCHITECTURE.md`. The prepend is skipped when the daemon's own Node is
  the at-risk build.

### Deterministic / hermetic testing

Tests and local smokes must never touch real user state:

- Isolate global config, the daemon (token/socket/jobs/logs), trust files, and
  run artifacts by pointing `CLAUDEXOR_CONFIG_DIR` at a temp dir; isolate host
  plugin files by pointing `HOME` at a temp dir.
- Canary `makeSandbox()` admits only the shared runtime environment key sets,
  then scopes HOME/XDG/Windows application-data roots. Ambient provider keys
  and harness route overrides must not make an offline fake race discover real
  reviewers; sandbox-specific overrides remain explicit at each CLI call.
- Managed secrets always use the daemon-owned v2 0600 file store, so a
  disposable `CLAUDEXOR_CONFIG_DIR` fully contains test secret I/O. The public
  CLI cannot select a storage backend.
- Model-response changes exercise the actual adapter through the model-operation
  and resource/HTTP owners with injected provider I/O. Pin byte-faithful failed
  SSE and HTTP-body evidence, original exception causes, legacy query/result
  compatibility and same-key replay, plus terminal usage when message conversion
  fails. Test public receipts separately from private result bytes, including a
  large failed result through restart, GET and ACK/expiry. The contract lives in
  [Caller-owned model operations](ARCHITECTURE.md#caller-owned-model-operations).
- Setup-job/runner tests inject filesystem, clock, launcher, process identity,
  signal, and timer dependencies and use temp roots only. They checksum the
  legacy registry before/after, exercise PID reuse and symlink/path fences, and
  never open Terminal or write `~/.claudexor`.
- The `fake-*` harnesses are the offline, keyless, deterministic fixtures
  (`--harness fake-success`, etc.); they are only selectable by explicit id and
  never enter automatic or reviewer pools. `fake-implement` additionally writes
  a real worktree file for producing intents, so the Agent write→apply and
  Create chains are exercisable with no real harness.
- Council regression fixtures exercise actual planner transports and final
  artifacts: retained unverified drafts, original failures, merge selection and
  terminal RunFacts must agree. Check solo/draft/merge prompt guidance through
  the real prompt consumers, and inspect the affected Council receipt visually.
- Journal maintenance tests preserve synchronous `compact()` consumer coverage
  and separately exercise streamed compaction with concurrent acknowledged
  batches, cursor continuity, cancellation and installation faults, plus the
  fold contract: positional-reader equivalence with whole-buffer replay,
  receipt byte-identity, disk chain state when a fold drops the last frame,
  fold boundary arithmetic under streaming appends, and multi-frame
  seq-preserving snapshot roundtrips. `scripts/journal-bench.mjs` is the opt-in
  preparation benchmark against a copied journal root. Run daemon
  responsiveness/SSE acceptance in an empty fixture config without provider
  profiles; rebuilding candidate source never requires restarting a live daemon
  used by other work.
- Read-only run lookups (`inspect`, `apply`) connect to an already-running daemon
  but never auto-start one (a typo'd run id reports `no such run`); only acting
  paths (`agent`/`best-of`/`create`, `decision`) auto-start it. `daemon start` blocks
  until the daemon is actually ready, so a follow-up `status`/run can't race it.
- Real-harness dogfood lives in `scripts/real-harness-battery.mjs`. Its default
  scratch mode runs disposable repos under `~/.claudexor/dogfood`, with an
  isolated config root. It asserts engine-owned artifacts, quarantines repeated
  host/network transient failures as ENV, and must not target the Claudexor repo
  for harness writes.
- A credentialed disposable VM may opt into the existing default login state:

  ```bash
  CLAUDEXOR_BATTERY_CONFIG_DIR="$HOME/.claudexor/v3" \
  CLAUDEXOR_BATTERY_DIR="$HOME/claudexor-dogfood/repo/battery-$(git rev-parse --short=12 HEAD)-$(date -u +%Y%m%dT%H%M%SZ)" \
    pnpm battery:real
  ```

  This mode accepts only the canonical default config path and requires the
  battery directory outside both `~/.claudexor` and the source checkout. It
  deliberately does not export `CLAUDEXOR_CONFIG_DIR`. The battery entrypoint
  itself first forces every workspace build (no Turbo cache), then dynamically
  loads the resulting dist modules and records the launched daemon entry digest
  beside its exact version/SHA/entry handshake. The
  lane refuses a pre-existing daemon, stops only the identity-bound daemon it
  started, and snapshots both `config.yaml` and
  `migration/accounts-unified.json` bytes and modes before startup. An
  already-migrated fixture must remain identical immediately. A pre-migration
  fixture may change once only by appending receipt-matched
  `<harness>-default` credential rows and completed migration records whose
  row id, locator, and backup reference agree. The ordered backup chain starts
  byte-identical to the pre-start config and each later backup contains exactly
  the preceding appended rows at the same private mode; every other config
  delta fails. After identity-bound shutdown the
  lane starts and stops the same exact candidate again, and both state files
  must then remain byte- and mode-identical. The receipt records both startup
  snapshots, its classification, and every validated row.

  The native-access phase gives each required row a stable registered/trusted
  project plus a separate delegated live `execution.workspaceRoot`. It proves
  a real edit and test only in the execution clone, requested/effective native
  access, requested/observed model, exact named profile without fallback,
  relevant Codex/Cursor/Agy vendor state, the deliberate no-outer-boundary
  receipt, and no `sandbox-exec` invocation. Codex, Claude, and Cursor each run
  default and named `workspace_write` rows; Agy is named-only. Cursor also runs
  trusted `full`; Claude/Codex Browser and Delegate rows retain their native
  per-adapter access requirements. OpenCode `workspace_write` must refuse
  before spawn, while its trusted-Full smoke is recorded as a conditional
  omission when the binary/route is unavailable, not as a required PASS or
  SKIP. The lane revokes every temporary disposable-repo full-access grant.
  Every Codex and
  Claude task attempt in the daemon's complete new-job inventory must disclose
  `local_session` from `native_session`; an API fallback or undisclosed route
  fails this VM acceptance, while Cursor retains its declared credential
  transport. The lane is strict: FAIL, ENV, or required SKIP greater than zero,
  a phase filter, or omission of Codex, Claude, Cursor, or Agy makes the
  acceptance run fail. A typed OpenCode conditional omission is counted
  separately.
  The single-family convergence refusal probe matches its canonical top-level
  failed status/message; nested RunFacts fields or incidental prose cannot
  satisfy that assertion.
  The build proof has no caller-supplied sentinel: every invocation owns and awaits
  the forced build before battery code can load. Never use the lane on the
  credential-free pristine VM or on a config root with live work.
- Runtime retry/review/concurrency knobs are user-global config
  (`runtime.transient_retry`, `runtime.reviewer_timeout_ms`, and the four
  `runtime.max_*` concurrency fields) with env overrides
  `CLAUDEXOR_TRANSIENT_RETRY_MAX`,
  `CLAUDEXOR_TRANSIENT_RETRY_INITIAL_DELAY_MS`,
  `CLAUDEXOR_TRANSIENT_RETRY_MAX_DELAY_MS`, and
  `CLAUDEXOR_REVIEWER_TIMEOUT_MS`, `CLAUDEXOR_MAX_CONCURRENT`,
  `CLAUDEXOR_MAX_PARALLEL_CANDIDATES`, `CLAUDEXOR_MAX_DEEP_SCAN_WIDTH`, and
  `CLAUDEXOR_MAX_COUNCIL_MEMBERS`. Concurrency values are read at daemon
  startup; settings surfaces distinguish configured, effective, and pending
  replacement state.

## Schema-First Workflow

Any change to modes, DTOs, artifacts, events, config, run control, auth,
routing, review, or delivery must start in `packages/schema`.

1. Update the schema and exported types.
2. Regenerate JSON Schema with `pnpm schema:gen`.
3. Update TypeScript consumers.
4. Update Swift DTOs when the control API payload changes.
5. Update README, Architecture, Integrations, Design System, or app docs when
   behavior changes.
6. Add or update focused tests for the behavior.

For a deletion-class access change, keep that order concrete: split active
ingress types from bounded recorded-artifact decoders first; delete the core
mechanism and rewrites next; update every adapter and public surface from the
active schema; migrate retry/thread/UI consumers together; then regenerate
schemas, run focused TypeScript/Swift checks, and run the exact-candidate
native-access battery. Historical readability is tested, never implemented as
a path that can start a new retired-mode process.

### Restriction design

1. Before adding or tightening a sandbox, deny/allow list, permission gate,
   reduced mode or validation fence, identify the concrete reachable marginal
   harm and why existing native policy, review, provenance, custody, trust,
   rollback and disclosure do not cover it.
2. Choose the smallest design, preferring deletion or simplification over a
   growing exception system.
3. Define and run a positive production-shaped acceptance path for every
   affected supported configuration before treating a denial test as success.
4. If the ordinary path breaks, the restriction is the defect and must be
   removed or simplified unless an explicit human decision accepts that exact
   lost outcome.
5. Use the existing plan, tests and review evidence; do not create a new
   restriction ledger, reviewer, approval gate or documentation authority.

Do not fork contracts in UI code, CLI parsing, adapter output, or docs. Run
`pnpm docs:check` in the same change: its small retired-contract inventory is a
ratchet, so removing or replacing a product surface also removes every stale
positive promise instead of relying on a one-time documentation cleanup.

## Processing preference

`processingPreference` is an advisory transport option for the selected model,
independent of routing goal, reasoning effort, context and output policy.
Standard requests ordinary service. Fast and Economy may fall back to Standard;
fallback, account rotation and retry must never introduce Fast. Omission keeps
legacy behavior, while explicit native `serviceTier` on `ModelCallOptions` takes
precedence and is disclosed. Keep the captured preference and canonical request
unchanged on exact replay. A confirmed no-generation processing refusal may
produce a new Standard request and reservation; an unknown outcome may not.

Choosing Fast permits its premium service within existing monetary limits. It
does not enable paid account settings, change credentials, buy credits, or raise
limits. An explicit no-paid policy selects ordinary fallback before dispatch.
Resolve native controls and mode-qualified billing before ranking and reservation;
carry observed usage through the existing ledger. Authentication proves the
credential route, not inclusion of premium service. A native list-price amount is
valuation; unobserved cash or credit consumption stays unknown. Never use a fixed
price multiplier or infer actual execution from the submitted flag. Preserve
requested, submitted and observed service separately, including mixed sessions.

Capabilities, exact-account inventories and their observation provenance belong
to existing adapter/discovery owners. Clients negotiate new account views through
the operation catalog and preserve strict legacy requests when unsupported.
Do not add a parallel catalog cache, pricing ledger or preference resolver.

## Boundaries

- Adapters translate I/O only. They never orchestrate.
- Surfaces call the engine/control plane. They do not create app-only semantics.
- Routing and capability decisions come from Gateway/doctor/capability data.
- Discovery can describe static capabilities and auth source availability, but
  readiness comes from doctor status, enabled intents, and smoke/conformance
  checks. Do not route, mark Auth UI ready, or select reviewers from source
  availability alone.
- **CONCEPT-CHANGE(INV-067, INV-135):** credential/profile policy is evaluated
  from the adapter declaration for the current platform. Keep transport,
  identity scope, relocation, enabled-row cardinality, and cleanup in that one
  policy owner. Create and enable limits belong inside the locked config
  mutation; an over-cap legacy set stays loadable and fails targeted
  routing/setup/quota loudly without probing or choosing a row.
- Managed-login input class has one manifest-owned declaration. Public
  `setupLogin` projection, setup admission, and the setup runner consume the
  same async terminal resolver; a file-exists check or a second host-capability
  projector is not readiness. Validate request/profile/cardinality before the
  resolver so rejected setup creates make no helper/vendor call or mutation.
- A native-login success assertion requires the journaled hash-bound vendor
  result, a fresh source-targeted probe, and an isolated same-harness capability
  smoke on the exact native route; process exit, browser confirmation, manifest
  capability, another provider, or an API key alone is insufficient. Readiness
  mapping
  is stable across adapters: absent/logged-out = `unavailable + not_run`, probe
  failure = `unknown + not_run`, and present-but-unusable = `available + failed`.
- Native session transport remains vendor-owned. Codex uses a
  Claudexor-dedicated `CODEX_HOME` with the vendor's file credential store forced,
  never the operator's ordinary Codex home or OS Keychain. Claude uses a
  Claudexor-owned `CLAUDE_CONFIG_DIR`; only its disposable child HOME bridges
  the macOS login Keychain so the vendor can read the item keyed by that dir.
  Cursor uses the vendor's file credential and SQLite state inside its selected
  Claudexor-owned profile HOME; the ordinary host Keychain login is not a
  route. Antigravity prepares a private `Library/Keychains/login.keychain-db`
  inside each Darwin profile HOME and leaves the vendor file fallback intact;
  Linux keeps the profile HOME file route, while Windows retains the vendor
  credential at OS-user scope and uses HOME only for relocatable state. Do not
  read or copy those credential files/tokens
  into Claudexor state or an envelope. API keys and the
  Claude setup-token are separate secret-store/env routes with separate typed
  source evidence.
- Browser MCP is an exact production dependency of `@claudexor/core`. App
  packaging uses shared-lockfile `pnpm deploy --prod` with a hoisted dependency
  layout to preserve transitive imports after archive link materialization. It
  places that pinned runtime beside the daemon and runs its help entrypoint under
  the app's bundled Node with an empty environment. Do not restore runtime `npx`, `@latest`, or a
  package-manager override.
- Git diffs come from the target workspace or envelope; directory results use
  complete manifest-bound files through the same workspace owner.
- Files and typed artifacts are the source of truth; terminal text and UI rows
  are projections.
- Unknown modes, invalid config, unavailable harnesses, stale reviews, malformed
  artifacts, and missing required context should fail loudly.

## Public Docs Discipline

Public docs describe current product truth, current contributor workflow, or
current integration surfaces. They must not store private planning packets,
review transcripts, local operator notes, local paths, token handling details, or
one-off release scratch.

Use this split:

- `README.md`: product entrypoint and detailed quickstart.
- `docs/AGENT_ONBOARDING.md`: external-agent orientation (machine-readable
  surfaces, decision tree, recovery).
- `docs/FEATURES.md`: status ledger of non-solid features (empty = healthy;
  update or delete a row in the same commit that changes the feature).
- `CLAUDEXOR_BIBLE.md`: compact product constitution.
- `docs/ARCHITECTURE.md`: current runtime and package map.
- `docs/INTEGRATIONS.md`: current external integration surfaces and limitations.
- `docs/DESIGN_SYSTEM.md`: macOS UI/UX contract.
- `docs/WHITEPAPER.md`: public rationale and conceptual model.
- `docs/DEVELOPMENT.md`: developing Claudexor itself.
- `docs/CHECKLISTS.md`: human gates for changes and releases.
- `apps/macos/README.md`: macOS app contributor notes.

Local operator guidance belongs in gitignored local files such as `AGENTS.md`.
Temporary adversarial review packets and release scratch belong outside public
docs. Review gates must be file-backed and diagnosable: persist local/redacted
per-reviewer artifacts and progress events, and point reviewers at evidence
files instead of embedding large diffs in process argv.

## Governance Rules

Do not implement risk, permission, tool success, web-required detection,
winner selection, or tests-passed decisions with regex checks over model prose.
Use typed schema fields, settings/profiles, normalized events, run artifacts,
deterministic gates, and reviewer evidence.

Runtime/harness/auth/setup/observability/budget/orchestration changes must update
the public docs that describe them, including `docs/WHITEPAPER.md` when the
conceptual model or product guarantees change.
