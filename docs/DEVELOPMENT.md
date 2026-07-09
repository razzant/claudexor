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
split is intentional, do not "reconcile" them.

macOS app checks:

```bash
cd apps/macos/ClaudexorKit && swift test
cd ../ClaudexorApp && swift build
```

Release verification is wrapped by:

```bash
pnpm release:verify
```

It runs Node/schema checks, Swift build/test checks, and unsigned app packaging.
The pre-tag triad/scope review uses `scripts/triad-scope-review.mjs` (reviewer
models come from `TRIAD_MODELS`/`SCOPE_MODEL` or a pinned local
`.adversarial-review/PANEL.lock`); when the release diff is too large for a
remote reviewer, set `TRIAD_MAX_PACK_BYTES` to reduce supplemental context
only. Do not use that as a reason to downgrade or substitute the pinned review
panel.

The PER-COMMIT review gate reviews the staged diff before it lands:

```bash
node scripts/commit-review.mjs      # or: bash scripts/install-hooks.sh (opt-in hooks)
```

PRIMARY route: `claudexor review --diff` against an index-snapshot worktree
(engine reviewer machinery, file-backed evidence, fail closed on inconclusive
panels). FALLBACK route: an OpenRouter triad-lite — this is the SECOND
sanctioned prompt-transport diff reviewer (alongside triad-scope-review.mjs),
allowed because it is the no-primary emergency path: strict finding-shape
quorum, per-reviewer telemetry under `.claudexor/logs/commit-review/`, and an
oversized-diff refusal instead of truncation. Its lower assurance relative to
the engine panel is an accepted, recorded tradeoff. Blocking findings, quorum failures, secret-like
diffs, and missing routes BLOCK the commit; `SKIP_COMMIT_REVIEW="<reason>"` is
the audited bypass (logged to `review-bypass.jsonl` + echoed into the commit
body). The panel lives in the committed `.claudexor/review-panel.yaml` and is
read from HEAD — a staged panel change cannot weaken the gate reviewing it.

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
- `CLAUDEXOR_SECRETS_BACKEND=file` (or `claudexor secrets --backend file`) forces
  the 0600 file store so secret reads/writes never hit the real macOS login
  Keychain — which `CLAUDEXOR_CONFIG_DIR` alone cannot redirect because the
  Keychain is not path-scoped.
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
