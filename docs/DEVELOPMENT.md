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
- `packages/orchestrator` owns the five canonical mode pipelines (ask, plan,
  audit, agent, orchestrate) with their strategy flags (race width, attempt
  caps, until-clean, swarm, create), plus run telemetry and policy gates.
- `packages/gateway` owns harness discovery, doctor output, and capability
  gating.
- `packages/harness-*` translate native CLI/API streams into typed events. They
  do not select winners, manage budgets, or decide review policy. Each has a
  `fixtures/` dir backing its conformance parity test.
- `packages/workspace` owns worktree envelopes, scoped harness homes, diff
  capture, and cleanup.
- `packages/policy` owns typed risk classification, protected-path rules, and
  the workspace path guard.
- `packages/context` owns the scope atlas and lazy ContextPack.
- `packages/config` owns layered config loading (global, project, user trust).
- `packages/review`, `packages/arbitration`, `packages/synthesis`,
  `packages/budget`, `packages/secrets`, and `packages/delivery` own their
  named control-plane subsystems.
- `packages/artifact-store` and `packages/event-log` own run artifact trees and
  the append-only event log.
- `packages/interview` owns the spec interview engine.
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
cd ../ClaudexorApp && swift build
```

Release verification is wrapped by:

```bash
pnpm release:verify
```

It runs Node/schema checks, Swift build/test checks, and local (unsigned)
app packaging. Public CI artifacts are fail-closed: all Apple signing and
notary secrets must be present, and both the app and DMG are signed,
notarized, stapled, and validated. App packaging also asserts that the separately bundled
setup-login runner exists and can start under the bundled Node; a daemon-only
bundle is incomplete.

The workflow has two explicit manual modes. `candidate` accepts only a full
40-character commit SHA and builds/signs/notarizes/attests without publishing.
After review, `publish` accepts only an annotated stable tag on the exact
`origin/main` commit plus the base64 signed schema-v2 review attestation. The
workflow verifies its Ed25519 signature against the pinned public release-review
key before reading any review claims, then recomputes the commit tree and
validates the sealed packet, full-gate receipt, artifact digests, exact six
reviewer slots, quorum, and pass result. Missing signing/notary/npm
credentials fail; there is no unsigned or GitHub-only release fallback. npm
packages publish in dependency order with `--provenance`; a retry skips only an
already-published byte-identical package carrying provenance, while any version
collision fails. The GitHub Release is a draft until macOS and npm complete,
uploads only absent assets, rejects differing same-name bytes, and becomes
public as the final mutation. The workflow never edits a published release and
does not claim platform-enforced immutability. Version bumps still go through
changesets (`pnpm changeset` + `pnpm version-packages`, fixed lockstep group).
The decoded review attestation is an envelope with `schemaVersion: 2`, pinned
`keyId`, `algorithm: "Ed25519"`, signed `payload`, and base64 `signature`.
Schema 1, unsigned, unknown-key, and tampered inputs are rejected. The payload
contains exact `candidateSha`, `candidateTree`, `packetManifestSha256`,
`evidenceManifestSha256`, and the digest and terminal result of the full
deterministic gate. Its `panelLock`
uses the same `triad`, `scope`, `candidate_sha`, `candidate_tree`, and
`packet_manifest_sha256` fields as the pre-created panel lock. `slots` contains
the two Tier 1 slots, all three exact triad slots, and exact scope slot with
route, requested/observed model, applicable effort, terminal status, result,
and per-slot telemetry/result/artifact digests. `decision.status` must be
`passed`, `blockingFindings` must be zero, and `openBlockers` must be empty.
Both Tier 1 slots and scope must pass; the triad keeps the accepted quorum of
two. Do not hand-author this JSON. Run
`scripts/seal-release-review-attestation.mjs` with the sealed packet, exact
terminal reviewer directories, full-gate receipt, external 0600 private key,
tracked `release/review-attestation-authority.json`, and an external output
path. The sealer refuses incomplete or inconsistent artifacts and can emit the
base64 transport with `--base64-out`. Never put raw transcripts, the private
key, or secrets in the repository or workflow input.
The pre-tag triad/scope review uses `scripts/triad-scope-review.mjs` with the
exact source-pinned models. It requires the sealed packet, full candidate SHA
and tree, the packet manifest's expected SHA-256 digest, and a panel-lock path
outside the candidate worktree. Create and validate that lock first with a
separate `--prepare-panel-lock` invocation; a normal review refuses a missing
or mismatched lock before creating output or making network calls. The three
triad slots and required scope slot then start concurrently.
`TRIAD_MAX_PACK_BYTES` may reduce supplemental context
only. It never authorizes a model substitution or a scoped/truncated cumulative
diff.

Release review is cumulative and SHA-bound. First commit a clean candidate,
then freeze its exact tree and evidence packet. Start both required Tier 1
critics, all three exact triad slots, and the required scope reviewer in one
parallel wave against that same sealed evidence, as described in
`docs/CHECKLISTS.md`. Any tracked mutation makes every result stale and starts
a new freeze. Staged-diff review is not release authority, so the old
per-commit script and hook installer have been removed rather than retained as
a competing workflow.

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
  automatically); otherwise it falls back to the `node` on `PATH`.
- If the Xcode Command Line Tools `swift-package` crashes with a dyld llbuild
  symbol error, use a Swiftly-managed toolchain
  (`PATH="$HOME/.swiftly/bin:$PATH" swift build`).
- `claudexor doctor` surfaces a non-gating advisory when the running Node is an
  at-risk Homebrew build on macOS; set `CLAUDEXOR_NODE_BIN` (or put a notarized
  Node first on `PATH`) to silence it.

### Deterministic / hermetic testing

Tests and local smokes must never touch real user state:

- Isolate global config, the daemon (token/socket/jobs/logs), trust files, and
  run artifacts by pointing `CLAUDEXOR_CONFIG_DIR` at a temp dir; isolate host
  plugin files by pointing `HOME` at a temp dir.
- Managed secrets always use the daemon-owned v2 0600 file store, so a
  disposable `CLAUDEXOR_CONFIG_DIR` fully contains test secret I/O. The public
  CLI cannot select a storage backend.
- Setup-job/runner tests inject filesystem, clock, launcher, process identity,
  signal, and timer dependencies and use temp roots only. They checksum the
  legacy registry before/after, exercise PID reuse and symlink/path fences, and
  never open Terminal or write `~/.claudexor`.
- The `fake-*` harnesses are the offline, keyless, deterministic fixtures
  (`--harness fake-success`, etc.); they are only selectable by explicit id and
  never enter auto/reviewer/orchestrate pools. `fake-implement` additionally writes a
  real worktree file and emits a schema-valid orchestration plan, so the
  create / write→apply / orchestrate chains are exercisable with no real harness.
- Read-only run lookups (`inspect`, `apply`) connect to an already-running daemon
  but never auto-start one (a typo'd run id reports `no such run`); only acting
  paths (`agent`/`best-of`/`create`, `decision`) auto-start it. `daemon start` blocks
  until the daemon is actually ready, so a follow-up `status`/run can't race it.
- Real-harness dogfood lives in `scripts/real-harness-battery.mjs` and runs only
  against disposable repos under `~/.claudexor/dogfood`. It asserts engine-owned
  artifacts, quarantines repeated host/network transient failures as ENV, and
  must not target the Claudexor repo for harness writes.
- Runtime retry/review knobs are user-global config (`runtime.transient_retry`
  and `runtime.reviewer_timeout_ms`) with env overrides
  `CLAUDEXOR_TRANSIENT_RETRY_MAX`,
  `CLAUDEXOR_TRANSIENT_RETRY_INITIAL_DELAY_MS`,
  `CLAUDEXOR_TRANSIENT_RETRY_MAX_DELAY_MS`, and
  `CLAUDEXOR_REVIEWER_TIMEOUT_MS`.

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

Do not fork contracts in UI code, CLI parsing, adapter output, or docs.

## Boundaries

- Adapters translate I/O only. They never orchestrate.
- Surfaces call the engine/control plane. They do not create app-only semantics.
- Routing and capability decisions come from Gateway/doctor/capability data.
- Discovery can describe static capabilities and auth source availability, but
  readiness comes from doctor status, enabled intents, and smoke/conformance
  checks. Do not route, mark Auth UI ready, or select reviewers from source
  availability alone.
- A native-login success assertion requires the journaled hash-bound vendor
  result, a fresh source-targeted probe, and an isolated same-harness capability
  smoke on the exact native route; process exit, browser confirmation, manifest
  capability, another provider, or an API key alone is insufficient. Readiness
  mapping
  is stable across adapters: absent/logged-out = `unavailable + not_run`, probe
  failure = `unknown + not_run`, and present-but-unusable = `available + failed`.
- Native session transport remains vendor-owned. Codex uses a
  Claudexor-dedicated `CODEX_HOME` with the vendor's file credential store forced,
  never the operator's ordinary Codex home or OS Keychain. Claude uses the vendor config plus macOS
  Keychain, and Cursor uses its Keychain-backed state. Do not read or copy those
  credential files/tokens into Claudexor state or an envelope. API keys and the
  Claude setup-token are separate secret-store/env routes with separate typed
  source evidence.
- Browser MCP is an exact production dependency of `@claudexor/core`. App
  packaging uses `pnpm deploy --legacy --prod` to place that pinned runtime
  beside the daemon and runs its help entrypoint under the app's bundled Node
  with an empty environment. Do not restore runtime `npx`, `@latest`, or a
  package-manager override.
- Diffs come from git in the target workspace or envelope.
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
