# Claudex v0.4.0 Architecture Reference

This document is the current codebase map: package boundaries, run flow,
artifact layout, and invariants. It describes what is implemented now, not a
future wish list.

Read this with [`../CLAUDEX_BIBLE.md`](../CLAUDEX_BIBLE.md). The Bible is the
compact constitution; this file is the operational map. Contributor workflow,
release gates, and integration notes live in
[`DEVELOPMENT.md`](DEVELOPMENT.md), [`CHECKLISTS.md`](CHECKLISTS.md), and
[`INTEGRATIONS.md`](INTEGRATIONS.md).

## 1. System Shape

Claudex is a local-first control plane over external coding harnesses:
Codex CLI, Claude Code, Cursor CLI, OpenCode, raw APIs, and future adapters.
A harness is not a role. Roles are intents (`explain`, `plan`, `implement`,
`repair`, `review`, `compare`, `synthesize`, `audit`, `benchmark`).

```text
surface -> schema/control DTO -> orchestrator/core -> gateway -> harness adapter -> native tool/API
        <- typed events/artifacts/reviews/budget/WorkProduct <-
```

Surfaces stay thin. Business logic belongs in core/orchestrator/control-plane
packages, never in macOS or CLI-specific state.

## 2. Canonical Modes

`ModeKind` lives in `packages/schema` and is the single source of truth:

- `ask` - one selected read-only `explain` route; writes `final/answer.md`.
- `explore` - bounded read-only research swarm; writes per-explorer findings,
  `final/explore.md`, `final/explore-findings.yaml`, and `final/omissions.md`.
- `agent` - default `claudex run`; one primary-biased direct-edit route.
- `best_of_n` - isolated candidate envelopes, review, synthesis, arbitration.
- `max_attempts` - convergence loop with explicit attempt cap.
- `until_clean` - convergence loop with no fixed cap; stops on clean review/gates,
  budget/quota exhaustion, cancellation, or no-progress stall.
- `plan` - read-only multi-harness planning; writes `final/plan.md`.
- `create` - create-from-scratch path, currently sharing the race pipeline.
- `readonly_audit` - one selected read-only `audit` route; writes `final/report.md`.
- `benchmark` - benchmark-oriented best-of-N path.

Old mode ids (`daily`, `until_convergence`, `readonly_swarm`) are not aliases.

## 3. Package Map

- `packages/schema`: Zod schemas, TypeScript types, generated JSON Schema,
  control DTOs, mode ids, config shapes.
- `packages/core`: adapter interface, process helpers, typed errors, minimal
  single-harness `ExecutionEngine` used by `agent`.
- `packages/orchestrator`: Ask, Explore, Agent, Best-of-N, convergence, Plan,
  Create, Read-only Audit, and Benchmark orchestration.
- `packages/gateway`: harness discovery, capability gating, default available
  harness resolution.
- `packages/workspace`: git worktree envelopes, scoped harness homes/config dirs,
  diff capture, cleanup.
- `packages/review`: deterministic gates, review, revalidation, convergence
  predicate, readiness ledger.
- `packages/arbitration`, `packages/synthesis`, `packages/budget`: evidence
  ranking, synthesis decision/prompting, spend/quota routing.
- `packages/secrets`: OS Keychain/file-backed secret store and secret resolution.
- `packages/delivery`: patch check/apply/commit/branch/PR delivery.
- `packages/control-api`: loopback HTTP/SSE facade over daemon and run artifacts.
- `packages/daemon`: durable local Unix-socket queue and job registry.
- `packages/cli`, `packages/mcp-server`, `packages/acp-server`: thin surfaces.
- `apps/macos`: native app; displays/edits what the engine exposes.

Adapters translate native I/O into `HarnessEvent`s. They do not select winners,
manage budgets, decide review policy, or orchestrate.

## 4. Routing

Routing is `Pool + Primary + Portfolio`:

- selected harness ids are the eligible pool;
- `primaryHarness` is a bias/ordering hint, not a privileged semantic role;
- `portfolio` is recorded in `TaskContract.budget.portfolio`, default
  `subscription-first`.

Single-route modes (`ask`, `agent`, `readonly_audit`) choose one route from the
eligible pool, primary first. `explore` expands a bounded read-only pool
(default width 4, capped at 8). Best-of-N expands the eligible pool over N
candidates. Convergence rotates compatible harnesses when a stall signature
persists.

Harness availability is determined by discovery + doctor + capabilities:
`available` alone is not enough. A harness must be `ok`, expose the required
intent for the selected mode (`explain` for Ask, `audit` for Explore/Audit,
`implement` for Agent/repair paths, `plan`, etc.), and support read-only when
the mode requires it. Surfaces show unavailable/degraded harnesses with reasons,
but gate them out of launch and routing.

Harness manifests include both compatibility booleans and a structured
`capability_profile`: execution surface, session/resume support, output/event
shape, auth sources, and access-control proof. UI and future RunControl behavior
must prefer the structured profile and only derive flat booleans from it.

## 5. Auth And Secrets

Native harness auth is preferred. API-key fallback uses `packages/secrets`:
Keychain where available, otherwise a `0600` file under the user config dir.
The routing/auth policy is subscription/native first; API-key refs are fallback.
Native/subscription runs scrub provider API-key env vars unless the run
explicitly chooses an API-key source, preventing accidental API billing.

Run params are validated before daemon enqueue. Inline `env`, `secrets`,
`api_key`, `token`, `password`, or similar fields are rejected, so daemon
`jobs.json` never becomes a secret store. Secret-setting endpoints bypass job
persistence and write only to the secret store.

Scoped harness homes/config dirs live outside worktree `tree/`, so `git add -A`
cannot capture auth files, sqlite logs, plugin downloads, or transcripts into
`patch.diff`.

## 6. Main Execution Paths

### Ask

Creates a run directory, writes a `TaskContract`, runs one adapter with
`intent: explain`, `access: readonly`, writes `final/answer.md`,
`final/summary.md`, and a `report` WorkProduct. There is no patch/apply control.
In the macOS app, Ask may run with no Current Project. The harness cwd is an
empty synthetic directory at `~/.cache/claudex/no-project`, while artifacts live
in the user-level store `~/.claudex/runs/<run_id>/`. If routing or the harness
fails, the run still writes inspectable failure artifacts
(`context/context_error.md`, `final/failure.yaml`, `final/summary.md`) and emits
`run.failed`.

### Explore

Runs a bounded read-only swarm (`intent: audit`, default width 4, cap 8). Each
explorer writes a per-attempt event stream and a findings markdown artifact.
The final artifacts include `final/explore.md`, `final/explore-findings.yaml`,
and `final/omissions.md`. Partial explorer failures are recorded as omissions
when at least one explorer succeeds; if all explorers fail, the run emits
`run.failed` with `final/failure.yaml`.

### Agent

`claudex run` defaults to `agent`. It uses the minimal `ExecutionEngine`,
selects one primary-biased compatible harness, writes a contract and summary,
and lets the harness operate on the requested workspace access profile.

### Best-of-N / Create / Benchmark

Each candidate gets its own `WorkspaceEnvelope`. The orchestrator reserves
budget, runs the harness, captures diff from git, runs deterministic gates,
reviews/revalidates findings, optionally synthesizes a new checked candidate,
and arbitrates.

### Max Attempts / Until Clean

One envelope is carried forward across repair attempts. `max_attempts` stops at
the explicit cap. `until_clean` has no fixed iteration cap and stops on
convergence, cancellation, budget/quota exhaustion, or no-progress stall after
eligible harness rotation.

### Plan

Runs eligible planners read-only, stores per-harness plans, cross-reviews when
reviewers are available, and writes `final/plan.md`. The spec interview is
Plan/draft-owned, not a permanent top-level app sidebar concept.

### Read-only Audit

Runs one selected compatible harness read-only with `intent: audit` and writes
`final/report.md`.

## 7. Control API

The daemon is the durable scheduler. The HTTP control API is a live viewport and
artifact/delivery facade:

- `POST /runs`
- `GET /runs`, `GET /runs/:id`, `GET /runs/:id/events`
- `GET /runs/:id/artifacts`, `GET /runs/:id/artifacts/<path>`
- `POST /runs/:id/apply/check`, `POST /runs/:id/apply`
- `POST /runs/:id/control`, `POST /runs/:id/input`
- `GET /harnesses`
- `GET|POST /settings`
- `GET|POST /secrets`, `DELETE /secrets/:name`
- `POST /spec/questions`, `POST /spec/freeze`

Every endpoint is loopback + bearer-token guarded. Apply endpoints read
`final/patch.diff`; read-only modes without a patch return a real error instead
of local fake apply state.

`POST /runs/:id/control` is capability-based. The safe implemented minimum is
cancel/interrupt; live steering or input forwarding must be rejected unless the
adapter proves a compatible state-preserving surface.

## 8. Artifact Layout

Canonical output lives under `.claudex/runs/<run_id>/`:

```text
events.jsonl
context/task.yaml
context/context_pack.yaml?
attempts/aNN/attempt.yaml
attempts/aNN/patch.diff
reviews/*.yaml
arbitration/decision.yaml
arbitration/pairwise.yaml
arbitration/synthesis.yaml
final/patch.diff?
final/work_product.yaml
final/summary.md
final/failure.yaml?
final/answer.md?
final/explore.md?
final/explore-findings.yaml?
final/omissions.md?
final/report.md?
final/plan.md?
```

Files are the source of truth. UI and terminal output are projections.

## 9. macOS App

The macOS app is a native control surface over the control API:

- default composer mode is `Ask`;
- Home and the full composer expose a Current Project picker; project-aware
  modes are disabled until a project is selected, while Ask can run without one;
- composer exposes mode, eligible pool, primary harness, portfolio, model hint,
  budget, access profile, and deterministic gates;
- Settings is a real macOS `Settings` scene (`Cmd+,`) with grouped preferences;
- Settings edits app preferences and engine defaults exposed by `/settings`,
  including appearance/motion, Current Project, routing/model defaults, budget,
  auth status, and secret refs;
- sidebar Operations contains live Budget, Harness Doctor, and Benchmarks;
- run detail has explicit `Answer` and `Diagnostics` tabs backed by artifacts;
- Review Queue is table-first;
- Settings uses flat grouped sections and avoids floating black cutout shadows;
- onboarding is native-first auth plus optional API-key fallback and guided
  install/login/smoke-test actions.

The app must not invent local accept/rebut/apply state. Delivery and artifact
actions come from server endpoints.

## 10. Change Rules

- Change data shapes in `packages/schema` first, regenerate JSON Schema, then
  update consumers.
- Change routing/orchestration in `packages/orchestrator` or `packages/core`.
- Change adapter parsing in `packages/harness-*`.
- Change delivery in `packages/delivery`.
- Change macOS UI only after the control DTO/API shape exists.
- Keep `README.md`, `CLAUDEX_BIBLE.md`, this file, `docs/INTEGRATIONS.md`, and
  app docs aligned when behavior changes.
- Keep contributor process in `docs/DEVELOPMENT.md` and `docs/CHECKLISTS.md`,
  not in runtime architecture sections.
