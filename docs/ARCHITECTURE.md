# Claudexor v0.7.0 Architecture Reference

This document is the current codebase map: package boundaries, run flow,
artifact layout, and invariants. It describes what is implemented now, not a
future wish list.

Read this with [`../CLAUDEXOR_BIBLE.md`](../CLAUDEXOR_BIBLE.md). The Bible is the
compact constitution; this file is the operational map. Contributor workflow,
release gates, and integration notes live in
[`DEVELOPMENT.md`](DEVELOPMENT.md), [`CHECKLISTS.md`](CHECKLISTS.md), and
[`INTEGRATIONS.md`](INTEGRATIONS.md). Public rationale lives in
[`WHITEPAPER.md`](WHITEPAPER.md).

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
  control DTOs, mode ids, config shapes, `RunTelemetry`.
- `packages/util`: shared helpers (ids, time, hashing, redaction, config dirs,
  safe file IO).
- `packages/core`: adapter interface, shared CLI run loop, process helpers,
  doctor runner, typed errors. Default write modes are orchestrator/envelope
  paths, not direct live-tree execution.
- `packages/orchestrator`: Ask, Explore, Agent, Best-of-N, convergence, Plan,
  Create, and Read-only Audit orchestration; owns run telemetry and policy
  gates (trust, risk, protected paths).
- `packages/gateway`: harness discovery, capability gating, default available
  harness resolution.
- `packages/harness-codex|claude|cursor|opencode|raw-api|fake`: adapters that
  translate native CLI/API streams into typed `HarnessEvent`s.
- `packages/workspace`: git worktree envelopes, scoped harness homes/config dirs,
  diff capture, cleanup with path-safe dispose.
- `packages/review`: deterministic gates, review, revalidation, convergence
  predicate, readiness ledger.
- `packages/arbitration`, `packages/synthesis`, `packages/budget`: evidence
  ranking, synthesis decision/prompting, spend/quota ledger + portfolio router
  with loop detection.
- `packages/policy`: typed risk classification, protected-path/human-approval
  rules, workspace path guard.
- `packages/context`: scope atlas + lazy ContextPack for read-only modes.
- `packages/config`: layered config loading (global, project, user-level trust).
- `packages/secrets`: OS Keychain/file-backed secret store and secret resolution.
- `packages/delivery`: patch check/apply/commit/branch/PR delivery and the
  single-owner apply gate.
- `packages/artifact-store`, `packages/event-log`: run artifact tree and
  append-only event log writers.
- `packages/control-api`: loopback HTTP/SSE facade over daemon and run artifacts.
- `packages/daemon`: durable local Unix-socket queue and job registry.
- `packages/interview`: spec interview engine for Plan/draft flows.
- `packages/cli`, `packages/mcp-server`, `packages/acp-server`: thin surfaces.
- `benchmarks/runner`: benchmark scaffolds (SWE-bench Verified et al.).
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

External context is a typed policy, not a prompt heuristic. `TaskContract`
records `requested_profile` and `effective_profile` under `access`, plus
`external_context.policy` (`off | auto | cached | live`), `web_required`,
`effective_mode`, and `tool_permission_policy`. CLI passes `--web` into the same
contract that Control API and macOS use. Web policy is a manifest capability
(`web_policy: native | tools | uncontrolled | none`): `native` is a config
surface (codex), `tools` is permissioned tools (claude), `uncontrolled` means
the harness can reach the web but exposes no enforceable switch (cursor,
opencode today) and is excluded from BOTH `off` and web-required runs, while
`none` means no web at all — trivially compatible with `off`, excluded from
web-required runs. Harnesses that cannot enforce the effective per-route policy
(including a per-harness `web` default upgrading a run-level `auto`) are
excluded from the pool, and explicitly selecting one fails loudly. Per-route
upgrades (Claude has no cached web index, so `cached` runs as `live`) are
disclosed via `policy.web.upgraded` events and recorded in telemetry. Adapters map the policy to native surface controls: Claude Code gets
explicit `WebSearch`/`WebFetch` allow/deny arguments, while Codex gets
`web_search` config. Command/network sandboxing remains separate.

`access=full` (unsandboxed) additionally requires `allow_full_access: true` in
the USER-LEVEL trust config (`~/.claudexor/trust/<repo-hash>.yaml`); versioned
repo config can never self-grant it, and the violation is a loud routing error,
not a silent downgrade. Per-harness engine defaults
(`harnesses.<id>.enabled/default_model/effort/web/max_usd/max_turns/max_rounds/
tools_allow/tools_deny/fallback_model` in the global config) gate pool
membership and seed per-route run specs; knobs a manifest does not support are
disclosed as `ignored_settings` on `harness.started`, never silently dropped.
Candidate diffs additionally pass a typed policy gate: protected-path changes
and critical-risk diffs escalate as `NEEDS_HUMAN` findings that block the run.

`auto` is evidence-driven: it permits web tools where the harness supports them
and records whether the harness actually attempted web. If a web tool is
attempted and its `tool_result` errors, the attempt is `web-unsatisfied` until a
later successful web result proves recovery. Read-only Ask/Audit can route
fallback to another eligible harness and emits `route.fallback.started`,
`route.fallback.completed`, or `route.fallback.exhausted`.

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

Ask also tracks normalized tool lifecycle. `tool_result.is_error === true`
preserves redacted detail in the event payload and blocks claimed success unless
verified recovery exists. When web evidence is unsatisfied and another eligible
read-only route exists, Ask falls back before terminal failure. If no fallback
can satisfy the policy, the run is `blocked` with a partial unverified output
artifact when one exists.

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

Envelope semantics are strict. Project runs execute under
`.claudexor/workspaces/<task>/<attempt>/tree`, and the harness `cwd` is the
envelope worktree. Proven work product is the git diff in that worktree, a
declared run artifact, or an explicitly verified host side-effect. Absolute
`/tmp/...` writes are host side effects and are not project diffs; project tmp
requests default to `tmp/...` inside the project/envelope or to run artifacts.

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
- `POST /runs/:id/control`
- `GET /harnesses`, `POST /harnesses/setup`
- `GET /setup/jobs`, `POST /setup/jobs`, `GET /setup/jobs/:id`,
  `GET /setup/jobs/:id/events`, `POST /setup/jobs/:id/confirm`,
  `POST /setup/jobs/:id/cancel`
- `GET|POST /settings`
- `GET|POST /secrets`, `DELETE /secrets/:name`
- `POST /spec/questions`, `POST /spec/freeze`

`GET /healthz` is the only unauthenticated route; it is loopback-host guarded
and returns liveness only.

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
helper sends a cooperative interrupt with hard-kill fallback. Live input
forwarding into a running harness is not a v0.7 surface; the former
`/runs/:id/input` endpoint and `RunInput` DTO were removed rather than left as
an always-`unsupported` stub.

A run blocked by `NEEDS_HUMAN` findings (reviewer escalation, protected-path
change, critical-risk diff) is a terminal `blocked` state whose findings appear
in the Review Queue. In v0.7 the queue is a read-only projection: there is no
server endpoint yet to accept/override a NEEDS_HUMAN finding and unblock the
run, so the human decision path is "review the findings, then re-run with the
decision reflected" (for example narrower scope or explicit gates). A typed
decision endpoint is future work; UI must not fake local accept/unblock state.

Budget caps: the engine enforces `max_usd` per run (explicit run input, then
surface defaults, then the global `budget.max_usd_per_run`). The configured
`budget.max_usd_per_day` is a display/threshold value for budget UI (engine-side
day ledgers require persistent cross-run spend tracking, which does not exist
yet); it must not be presented as an enforced engine cap.

Run detail includes terminal state and output-ready state. `summary.state` is the
daemon terminal/lifecycle state. `summary.outputReadyState` is
`pending | finalizing | ready | diagnostic` and is derived from primary output
and failure artifacts. `summary.webEvidence` and tool-error rollups are
projections of the engine-owned `final/telemetry.yaml` (the orchestrator is the
single evidence owner); runs that predate that artifact report
`available: false` instead of recomputed guesses. Timeline projections include
tool name, target/domain/path, error summary, severity, harness, attempt, and
raw event reference, and are capped with an explicit truncation marker.

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
final/telemetry.yaml
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
plans/<harness>.md?           (plan mode)
attempts/aNN/events.jsonl?    (read-only modes)
```

`final/telemetry.yaml` (`RunTelemetry` in the schema) is the single engine-owned
record of per-attempt web evidence (requested/effective mode, attempted,
satisfied, status), unrecovered tool errors, statusless results, and dropped
native events. Surfaces project it; they never recompute evidence from raw
events or model prose.

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
