# Claudexor v0.6.0 Architecture Reference

This document is the current codebase map: package boundaries, run flow,
artifact layout, and invariants. It describes what is implemented now, not a
future wish list.

Read this with [`../CLAUDEXOR_BIBLE.md`](../CLAUDEXOR_BIBLE.md). The Bible is the
compact constitution; this file is the operational map. Contributor workflow,
release gates, and integration notes live in
[`DEVELOPMENT.md`](DEVELOPMENT.md), [`CHECKLISTS.md`](CHECKLISTS.md), and
[`INTEGRATIONS.md`](INTEGRATIONS.md).

## 1. System Shape

Claudexor is a local-first control plane over external coding harnesses:
Codex CLI, Claude Code, Cursor CLI, OpenCode, raw APIs, and future adapters.
A harness is not a role. Roles are intents (`explain`, `plan`, `implement`,
`repair`, `review`, `compare`, `synthesize`, `audit`).

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
- `agent` - default `claudexor run`; one primary-biased orchestrator/envelope route.
- `best_of_n` - isolated candidate envelopes, review, synthesis, arbitration.
- `max_attempts` - convergence loop with explicit attempt cap.
- `until_clean` - convergence loop with no fixed cap; stops on clean review/gates,
  budget/quota exhaustion, cancellation, or no-progress stall.
- `plan` - read-only multi-harness planning; writes `final/plan.md`.
- `create` - create-from-scratch path, currently sharing the race pipeline.
- `readonly_audit` - one selected read-only `audit` route; writes `final/report.md`.

Old mode ids (`daily`, `until_convergence`, `readonly_swarm`) are not aliases.

## 3. Package Map

- `packages/schema`: Zod schemas, TypeScript types, generated JSON Schema,
  control DTOs, mode ids, config shapes.
- `packages/core`: adapter interface, process helpers, typed errors, and legacy
  single-harness utility code. Default write modes are orchestrator/envelope
  paths, not direct live-tree execution.
- `packages/orchestrator`: Ask, Explore, Agent, Best-of-N, convergence, Plan,
  Create, and Read-only Audit orchestration.
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

Single-route read-only modes (`ask`, `readonly_audit`) choose one route from the
eligible pool, primary first. `Agent` is a one-candidate envelope run. `explore`
expands a bounded read-only pool (default width 4, capped at 8). Best-of-N
expands the eligible pool over N candidates. Convergence rotates compatible
harnesses when a stall signature persists.

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
Manifest `auth_modes` and `capability_profile.auth.preferred_source` describe
possible source availability only. They are not readiness. UI, routing, and
reviewer selection use doctor status, enabled intents, and smoke/conformance
checks; a key/session source that fails doctor remains degraded or unavailable.

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
empty synthetic directory at `~/.cache/claudexor/no-project`, while artifacts live
in the user-level store `~/.claudexor/runs/<run_id>/`. If routing or the harness
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

`claudexor run` defaults to `agent`. It is a one-candidate orchestrator/envelope
run: the harness works in an isolated workspace, Claudexor captures the git diff,
emits artifacts, and live project mutation happens only through explicit
delivery/apply.

Convergence modes also default to isolated envelopes. The CLI-only `--in-place`
is reserved for explicit stateful external adapters, such as Terminal-Bench
containers where runtime state is the deliverable and cannot be merged from a
patch. It is not surfaced in the macOS app and is not the default mutation path.

### Best-of-N / Create

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
- `GET /harnesses`, `POST /harnesses/setup`
- `GET /setup/jobs`, `POST /setup/jobs`, `GET /setup/jobs/:id`,
  `GET /setup/jobs/:id/events`, `POST /setup/jobs/:id/cancel`
- `GET|POST /settings`
- `GET|POST /secrets`, `DELETE /secrets/:name`
- `POST /spec/questions`, `POST /spec/freeze`

`POST /harnesses/setup` owns setup preparation. It validates typed setup
actions, rejects inline secrets, and returns only server-side allowlisted
commands, official guide URLs, and redacted setup log metadata.
`/setup/jobs` owns execution lifecycle for install/login/doctor setup work:
jobs have state, risk flags, command preview, log path, cancel, and an SSE
status projection. Native clients may open the job's Terminal handoff or show
the returned command; they do not construct setup commands locally.

Every endpoint is loopback + bearer-token guarded. Apply endpoints read
`final/patch.diff`; read-only modes without a patch return a real error instead
of local fake apply state.

`POST /runs/:id/control` is capability-based. The implemented minimum is
cancel/interrupt: daemon abort closes the active harness stream and the process
helper sends a cooperative interrupt with hard-kill fallback. Live steering or
input forwarding through `POST /runs/:id/input` is not wired into active runs in
v0.6.0; it must return `unsupported` unless a future route binds the request to a
state-preserving surface such as Codex app-server or Claude stream-json stdin.

## 8. Artifact Layout

Canonical output lives under `.claudexor/runs/<run_id>/`:

```text
events.jsonl
context/task.yaml
context/context_pack.yaml?
attempts/aNN/attempt.yaml
attempts/aNN/patch.diff
reviews/*.yaml
reviews/*-reviewers/reviewer-progress.jsonl
reviews/*-reviewers/evidence/DIFF.patch
reviews/*-reviewers/evidence/DIFF_SUMMARY.md
reviews/*-reviewers/evidence/metadata.json
reviews/*-reviewers/<reviewer>/metadata.json
reviews/*-reviewers/<reviewer>/raw-normalized-stream.jsonl
reviews/*-reviewers/<reviewer>/transcript.md
reviews/*-reviewers/<reviewer>/parsed-json-blocks.json
reviews/*-reviewers/<reviewer>/parse-error.json?
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

Review prompts are file-backed: the full candidate patch is written to the
candidate evidence packet as `DIFF.patch` with `DIFF_SUMMARY.md` and digest
sidecars. The process prompt is concise and points the reviewer to those files;
it must not embed large full diffs in argv. Per-reviewer telemetry records
requested model/effort, observed model/source, route proof, timing, raw
normalized stream or transcript, parsed JSON blocks, and parse errors. These
artifacts are local/redacted run evidence, not public documentation.

Files are the source of truth. UI and terminal output are projections. The
control API also projects `primaryOutput`, `timeline`, and `budget` from these
files/events so clients do not have to guess which artifact is the main result or
show fake zero spend/quota values.

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
- sidebar Operations contains live Budget and Harness Doctor;
- run detail has explicit `Outcome`, `Timeline`, `Plan`, `Candidates`, `Diff`,
  `Review`, and `Diagnostics` tabs; completed runs open on Outcome, active runs
  on Timeline, and failures without output on Diagnostics;
- Review Queue uses an adaptive solid SwiftUI grid with stable row metrics; it
  must not force the app window to a very wide minimum size;
- budget cap editing uses validated currency text fields, never a money slider;
- hover help is required on compact/non-obvious controls, modes, harness chips,
  route proof, auth/setup actions, budget controls, and dangerous actions;
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
- Keep `README.md`, `CLAUDEXOR_BIBLE.md`, this file, `docs/INTEGRATIONS.md`, and
  app docs aligned when behavior changes.
- Keep contributor process in `docs/DEVELOPMENT.md` and `docs/CHECKLISTS.md`,
  not in runtime architecture sections.
