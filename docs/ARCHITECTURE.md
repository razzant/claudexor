# Claudexor Architecture Reference

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
A harness is not a role. Roles are intents (`explain`, `plan`, `spec`,
`implement`, `create_from_scratch`, `repair`, `review`, `verify`,
`synthesize`, `audit`, `orchestrate`).

```text
surface -> schema/control DTO -> orchestrator/core -> gateway -> harness adapter -> native tool/API
        <- typed events/artifacts/reviews/budget/WorkProduct <-
```

Surfaces stay thin. Business logic belongs in core/orchestrator/control-plane
packages, never in macOS or CLI-specific state.

## 2. Canonical Modes

`ModeKind` lives in `packages/schema` and is the single source of truth. In
v0.9 the nine v0.8 ids were collapsed into FIVE intents-on-a-thread; engine
strategies became flags, not modes:

- `ask` - one selected read-only `explain` route; writes `final/answer.md`.
- `plan` - read-only multi-harness planning; writes `final/plan.md`.
- `audit` - read-only audit/map (`final/report.md`); with `--swarm` (the old
  `explore`) a bounded research swarm writing `final/explore.md`,
  `final/explore-findings.yaml`, and `final/omissions.md`.
- `agent` - default `claudexor run`; one primary-biased envelope route. Flags
  select the strategy on the SAME mode: `--n N` (best-of-N race with isolated
  candidate envelopes, review, synthesis, arbitration), `--attempts N`
  (convergence loop with an explicit cap), `--until-clean` (convergence loop
  with no fixed cap; stops on clean review/gates, budget/quota exhaustion,
  cancellation, or no-progress stall), `--create` (create-from-scratch intent).
- `orchestrate` - the autonomous brain: routed like reviewers (doctor-ok +
  `orchestrate` capability + quota headroom), it produces a typed orchestration
  plan over the six-tool vocabulary (`start_run`, `race`, `status`,
  `answer_question`, `apply`, `review`) — the DEFAULT tool belt is five:
  `answer_question` is deliberately not offered by default (safe sub-runs are
  non-interactive; a caller can add it to a custom `tool_belt`) — and writes
  `final/orchestration.md`. With one verified
  harness it plans single-route; with two or more it may plan cross-family
  race/review. `--autonomy suggest|auto_safe|auto_full` controls how much of
  that plan the executor runs without confirmation. Risk is data-driven (the
  `TOOL_RISK` SSOT, fail-closed): SAFE steps (`start_run`/`race`/`status`/
  `answer_question`/`review`) provably never mutate the live tree — they run as
  isolated envelope sub-runs (asserted `inPlace=false`) or pure reads; `apply`
  is the only RISKY (mutating) step.
  - `suggest` (default) plans only; the human executes the plan.
  - `auto_safe` runs the SAFE steps and then BLOCKS at the first risky `apply`
    step (terminal `blocked`), awaiting a human decision.
  - `auto_full` also applies, sending the risky step through the single shared
    delivery gate (`validateApplyGate` + `deliver`) — it can mutate the live
    project. Per-step progress is persisted to
    `final/orchestration_progress.yaml`.
  The executor's budget is AGGREGATE and WHOLE-CAP: the brain's own settled
  spend seeds the aggregate, and sequential sub-runs AND review-step reviewer
  panels all charge the same cap (each step gets the remaining headroom;
  exhausted headroom ends the run with the failure-shaped `exhausted`
  terminal — failure.yaml + run.failed, never a clean success), and
  `--max-tool-calls` (control-api `maxToolCalls`) caps the plan
  steps. Both knobs apply only to `orchestrate` — any other mode refuses them
  loudly (CLI usage error / control-api 400) rather than carrying a silent
  no-op knob.

Old mode ids (`best_of_n`, `max_attempts`, `until_clean`, `explore`, `create`,
`readonly_audit`, plus pre-v0.8 `daily`/`until_convergence`/`readonly_swarm`)
are NOT aliases: they hard-error at every wire boundary.

## 3. Package Map

- `packages/schema`: Zod schemas, TypeScript types, generated JSON Schema,
  control DTOs, mode ids, config shapes, `RunTelemetry`.
- `packages/util`: shared helpers (ids, time, hashing, redaction, config dirs,
  safe file IO).
- `packages/core`: adapter interface, shared CLI run loop, process helpers,
  doctor runner, typed errors. Default write modes are orchestrator/envelope
  paths, not direct live-tree execution.
- `packages/orchestrator`: the five canonical mode pipelines (ask, plan, audit,
  agent, orchestrate) with strategy flags (race width, attempt caps,
  until-clean, swarm, create); owns run telemetry and policy gates (trust,
  risk, protected paths), typed transient retry policy, and no-progress outcomes.
- `packages/gateway`: harness discovery, capability gating, default available
  harness resolution.
- `packages/harness-codex|claude|cursor|opencode|raw-api|fake`: adapters that
  translate native CLI/API streams into typed `HarnessEvent`s. The `fake-*` kinds
  are deterministic offline test fixtures (incl. `fake-implement`, which writes a
  real worktree file and emits an orchestrate plan); they are explicit-`--harness`
  only and never enter auto/reviewer/brain pools.
- `packages/workspace`: git worktree envelopes, scoped harness homes/config dirs
  (for write envelopes AND read-only routes via `readOnlyHomeEnv`, so plan files,
  session rollouts, and transcripts never escape into the operator's real home),
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
- `packages/cli`: thin command surface plus local host-integration lifecycle
  (`claudexor plugin`) for generated Claude Code/Codex/Cursor/OpenCode
  skill/MCP artifacts and command artifacts where hosts support them. Plugin
  lifecycle state is user-level local setup state, not a schema/control-api
  contract.
- `packages/mcp-server`, `packages/acp-server`: thin protocol surfaces.
- `benchmarks/runner`: benchmark scaffolds (SWE-bench Verified et al.).
- `apps/macos`: native app; displays/edits what the engine exposes.

Adapters translate native I/O into `HarnessEvent`s. They do not select winners,
manage budgets, decide review policy, or orchestrate.

Host integrations are generated translational artifacts: Claude Code, Codex,
Cursor, and OpenCode files point at the local CLI/MCP server and carry ownership
markers for safe repair/uninstall. They do not route work or duplicate
orchestration logic.

## 4. Routing

Routing is `Pool + Primary + Portfolio`:

- selected harness ids are the eligible pool;
- `primaryHarness` is a bias/ordering hint, not a privileged semantic role;
- `portfolio` is recorded in the `TaskContract` budget (its `portfolio`
  field), default `subscription-first`.

Single-route read-only modes (`ask`, `audit`) choose one route from the
eligible pool, primary first. `Agent` is a one-candidate envelope run. `audit
--swarm` (the old `explore`) expands a bounded read-only pool (default width 4,
capped at 8). Best-of-N expands the eligible pool over N candidates. Convergence rotates compatible
harnesses when a stall signature persists.

A thread carries sticky routing so the chat surface stays a thin gateway: a
`Thread` persists `primary_harness` (which harness answers in chat) and
`eligible_harnesses` (the pool Race runs — one candidate per harness, so its N is
the pool size). A turn inherits both unless its request overrides them
(`POST /threads/:id/turns` accepts `primaryHarness` / `harnesses`); precedence is
**turn body > thread sticky > engine default** (config `routing.primary_harness`,
auto-pool of doctor-ok harnesses). All ordering/validation stays in the engine —
`primaryHarness` is only pinned first, and an EXPLICITLY-selected primary outside
the selected pool fails loudly (the engine rejects it). An INHERITED sticky
primary that no longer fits the pool is instead dropped by the thin gateway
before the turn is enqueued (so a stale bias never forces routing). Surfaces just
set the sticky values (`POST /threads`, `PATCH /threads/:id`) and send DTOs; they
never route.

Harness availability is determined by discovery + doctor + capabilities:
`available` alone is not enough. A harness must be `ok`, expose the required
intent for the selected mode (`explain` for Ask, `audit` for Audit and its
swarm,
`implement` for Agent/repair paths, `plan`, etc.), and support read-only when
the mode requires it. Surfaces show unavailable/degraded harnesses with reasons,
but gate them out of launch and routing.

Harness manifests carry capability booleans the engine consumes (intent
gating, knob support, the interactive-channel gate) and a small structured
`capability_profile` limited to what is actually read: auth sources and
credential transports, isolation containment, the honest readonly mechanism,
and vision `image_input` (the never-consumed execution-surface/session/output
subtrees were deleted in the v0.15 triage — a declared capability with no
consumer is a staged field). Capabilities are data-driven and declared by the
adapter: `effort_levels` (a shared normalizer clamps a requested hint onto the
nearest supported level; a requested effort on an EMPTY ladder is disclosed
via `ignored_settings`, never silently dropped) and `known_models` (+ the
`known_models_verified_against` freshness note) as the manifest model truth
source under the STRICT semantics described in the model-governance section
above — there is no warn-and-pass-through tier. `doctor` validates each
harness's CONFIGURED default model against the truth source, so a broken
default (e.g. a model the CLI cannot run) is reported honestly instead of
masked by a smoke that used a different model, and the same verdict rides
the harness status DTO (`configuredModelCheck`) into the Settings UI.
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
repo config can never self-grant it, and the violation is a loud routing error
naming the resolved trust path, not a silent downgrade. `claudexor trust` is
the writer for that file (`--allow-full-access`, `--revoke-full-access`,
`--access-default readonly|workspace_write`). Per-harness engine defaults
(`harnesses.<id>.enabled/default_model/effort/web/max_usd/max_turns/max_rounds/
tools_allow/tools_deny/fallback_model` in the global config) gate pool
membership and seed per-route run specs; knobs a manifest does not support are
disclosed as `ignored_settings` on `harness.started`, never silently dropped.

Model choice is harness-scoped end to end. A run carries a per-harness
`models` map (harness id → model id); the scalar `model` convenience expands
to the RESOLVED PRIMARY only and is rejected when no primary is resolvable —
it never fans out to a pool. The resolved map is recorded on the TaskContract
(`routing_models`), which route-spec building reads; per-attempt overrides
(budget downgrade to `fallback_model`, fallback retry) sit on top. Every
explicit model — per-run, settings default, fallback, reviewer — must pass
the harness's model truth source (live `models()` inventory, else manifest
`known_models`; a harness with neither refuses explicit models): enforced at
settings write (400), run preflight (typed failure with artifacts before any
CLI spawns), and both reviewer-panel paths. `/harnesses/:id/models` reports
the truth source honestly (`source: api|manifest|none`, with the manifest's
`verifiedAgainst` CLI-version freshness note), and the model-hints-freshness
gate warns when the installed vendor CLI drifts from the verified version.
Candidate diffs additionally pass a typed policy gate: protected-path changes
and critical-risk diffs escalate as `NEEDS_HUMAN` findings that block the run;
explicit per-run `protected_path_approvals` can narrow only the auto-protected
gate/test path portion of that policy. Frozen SpecPacks and repo config cannot
carry approvals; they may declare protected paths, but operator approval is
always supplied on the current run.

`auto` is evidence-driven: it permits web tools where the harness supports them
and records whether the harness actually attempted web. If a web tool is
attempted and its `tool_result` errors, the attempt is `web-unsatisfied` until a
later successful web result proves recovery. Read-only Ask/Audit can route
fallback to another eligible harness and emits `route.fallback.started`,
`route.fallback.completed`, or `route.fallback.exhausted`.

## 5. Auth And Secrets

Native harness auth is preferred. API-key fallback uses `packages/secrets`:
Keychain where available, otherwise a `0600` file under the user config dir.
`CLAUDEXOR_SECRETS_BACKEND` (`file|keychain|auto`) overrides the platform default
and an invalid value fails loudly, so a sandboxed run/test can force the `0600`
file store and never touch the real login Keychain (which is not path-scoped).
The routing/auth policy is subscription/native first where that route is
readiness-proven; API-key refs are fallback secret refs. Cursor keeps normal
non-scoped `auto` runs on the native session when it is available, and only lets
scoped/envelope `auto` prefer the API-key route after the adapter smoke-proves
that key. When a scoped `auto` run selects API-key while native Cursor auth is
also available, the adapter emits a typed `route.fallback.auth_switched`
disclosure with reason `readiness_preferred`, preventing a silent paid-route
switch. Native/subscription runs scrub provider API-key env vars unless the run
chooses an API-key source, preventing accidental API billing.
Adapters declare the physical credential transport they support (`config_file`,
`env_var`, `oauth_token_env`, `os_keychain`, `http_header`, or `none`) plus the
containment strategy that keeps it honest. Codex routes seed `auth.json` into a
scoped `CODEX_HOME`; Claude API-key routes inject `ANTHROPIC_API_KEY`; Cursor
declares an OS-keychain native route plus `CURSOR_API_KEY` fallback. On macOS,
only routes whose declared transport/containment requires it (Cursor today)
bridge the user's `~/Library/Keychains` directory into the scoped HOME so native
Security-framework probes keep working while `.cursor` state still lands in the
disposable scoped home.

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
In the macOS app, Ask may run with no project selected. The harness cwd is an
empty synthetic directory at `~/.cache/claudexor/no-project`, while artifacts live
in the user-level store `~/.claudexor/runs/<run_id>/`. If routing or the harness
fails, the run still writes inspectable failure artifacts
(`context/context_error.md`, `final/failure.yaml`, `final/summary.md`) and emits
`run.failed`.

Ask also tracks normalized tool lifecycle. `tool_result.is_error === true`
preserves redacted detail in the event payload and blocks a green verified claim
unless verified recovery exists, but a produced deliverable can still be terminal
success with warnings. When web evidence is unsatisfied and another eligible
read-only route exists, Ask falls back before terminal failure. If no fallback
can satisfy the policy, the run is `blocked` with a partial unverified output
artifact when one exists.

### Audit --swarm (research swarm)

Runs a bounded read-only swarm (`intent: audit`, default width 4, cap 8; the
CLI verb `claudexor explore` maps here). Each explorer writes a per-attempt
event stream and a findings markdown artifact. Swarm final artifacts include
`final/explore.md`, `final/explore-findings.yaml`, and `final/omissions.md`.
Partial explorer failures are recorded as omissions when at least one explorer
succeeds; if all explorers fail, the run emits `run.failed` with
`final/failure.yaml`.

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

Write modes need a git boundary for that isolation. A NON-GIT project folder is
initialized automatically before any candidate spawns: `.gitignore` is seeded
with `.claudexor/` first, then `git init` plus a deterministic baseline commit
(author `Claudexor`) make worktree diffs honest from the first run. The action
is announced via a `project.git.initialized` run event in the timeline — never
a refusal (comparator: Codex CLI refuses outside git; Claudexor creates the
boundary itself), never a silent mutation. Read-only modes and `--in-place`
stateful targets are untouched.

Convergence modes also default to isolated envelopes. The CLI-only `--in-place`
is reserved for explicit stateful external adapters, such as Terminal-Bench
containers where runtime state is the deliverable and cannot be merged from a
patch. It is not surfaced in the macOS app and is not the default mutation path.

Chat thread turns run IN-PLACE: an agent turn executes directly in the
execution tree (the live project for an `in_place` thread, or the thread's
persistent worktree for an `isolated` thread — the orchestrator's internal
run-input carries this as `executionRoot`), so the
routed harness resumes its own native CLI session and the next turn sees the
work — no `session.rebound` for these. A best-of-N race still runs candidates in
throwaway envelopes from the tree's current state and AUTO-ADOPTS the winner's
patch into the execution tree (`git apply --3way`, disclosed via
`work_product.adopted`); a conflict leaves `adopted:false` and offers a manual
apply, never losing work. Blockers (NEEDS_HUMAN / non-clean terminal) stop
adoption. An isolated thread's accumulated worktree diff is delivered to the
project on demand via `POST /threads/:id/apply`.

### Agent --n (race) / --create

Each candidate gets its own `WorkspaceEnvelope`. The orchestrator reserves
budget, runs the harness, captures diff from git, runs deterministic gates,
reviews/revalidates findings, optionally synthesizes a new checked candidate,
and arbitrates. `--create` runs the same envelope pipeline with the
create-from-scratch intent (the CLI verb `claudexor create` maps here).

### Agent --attempts / --until-clean

One envelope is carried forward across repair attempts. `--attempts` stops at
the explicit cap. `--until-clean` has no fixed iteration cap and stops on
convergence, cancellation, budget/quota exhaustion, or no-progress stall after
eligible harness rotation.

### Plan

Runs eligible planners read-only with an explicit "plan, do not implement"
instruction wrapped around the goal (so the model produces a plan instead of
trying to build it and dumping code when writes are blocked), stores per-harness
plans, cross-reviews when reviewers are available, and writes `final/plan.md` —
an honest `# Plan` document (goal, per-planner plans, ALL review findings with
severity so a BLOCK like "feature not delivered" is visible, open questions).
The multi-harness relay cross-shares each earlier planner's plan into the next
planner's prompt, so planners converge on one aligned plan instead of planning
blind. It
also writes `final/work_product.yaml` with `result_kind: plan` and a null
diffstat, so a surface reports "plan only — no files changed" rather than a green
"succeeded" over nothing. A follow-up turn implements it via the `planRunId`
field (the engine prefixes the approved plan into the next agent turn's prompt).
The spec interview is Plan/draft-owned, not a permanent top-level app sidebar
concept.

### Audit (single report)

Runs one selected compatible harness read-only with `intent: audit` and writes
`final/report.md`.

## 7. Control API

The daemon is the durable scheduler. The HTTP control API is a live viewport and
artifact/delivery facade. The canonical endpoint inventory below is generated
from the control-api server source (`node scripts/gen-endpoints-doc.mjs`);
README and INTEGRATIONS link here instead of maintaining duplicates.

<!-- BEGIN GENERATED ENDPOINTS (node scripts/gen-endpoints-doc.mjs; do not edit by hand) -->
- `GET /events`
- `GET /harnesses`
- `GET /harnesses/:id/models`
- `GET /healthz`
- `GET /runs`
- `POST /runs`
- `GET /runs/:id`
- `POST /runs/:id/apply`
- `POST /runs/:id/apply/check`
- `GET /runs/:id/artifacts`
- `GET /runs/:id/artifacts/<path>`
- `POST /runs/:id/control`
- `POST /runs/:id/decision`
- `GET /runs/:id/events`
- `POST /runs/:id/interactions/:id/answer`
- `GET /runs/:id/produced`
- `GET /runs/:id/produced/<path>`
- `GET /secrets`
- `POST /secrets`
- `DELETE /secrets/:id`
- `GET /settings`
- `POST /settings`
- `GET /setup/jobs`
- `POST /setup/jobs`
- `GET /setup/jobs/:id`
- `POST /setup/jobs/:id/cancel`
- `POST /setup/jobs/:id/confirm`
- `GET /setup/jobs/:id/events`
- `POST /spec/freeze`
- `POST /spec/questions`
- `GET /threads`
- `POST /threads`
- `GET /threads/:id`
- `PATCH /threads/:id`
- `POST /threads/:id/apply`
- `POST /threads/:id/turns`
<!-- END GENERATED ENDPOINTS -->

Endpoint semantics beyond the inventory:

- Threads are the chat/session-first conversation SSOT (run lineage + native
  harness sessions). A thread declares a `workspace.mode`: `in_place` (default)
  mutates the live project tree; `isolated` keeps a persistent git worktree per
  thread. It also carries sticky routing — `primaryHarness` and
  `eligibleHarnesses` — that its turns inherit; `PATCH /threads/:id` renames /
  archives a thread (title + open/closed state) and switches the sticky
  routing.
- `POST /threads/:id/turns` enqueues a follow-up run anchored to the thread.
  Agent turns run IN-PLACE in the execution tree — the live project for an
  in-place thread, or the thread's worktree for an isolated thread — so the
  routed harness resumes its own native CLI session and the next turn sees the
  work. A best-of-N race runs candidates in isolated envelopes and auto-applies
  the winner to the execution tree (a typed `session.rebound` disclosure covers
  those isolated candidates). A `planRunId` body field implements an approved
  plan from an earlier turn; a `specPath` body field Implements against a
  frozen SpecPack — the agent runs against that contract instead of a bare
  prompt. `POST /threads/:id/apply` delivers an isolated thread's accumulated
  worktree diff to the project; in-place threads write the project directly and
  never need it.
- `POST /runs/:id/decision` records a typed operator decision on a blocked run:
  `accept_risk` / `override_needs_human` persist an auditable patch-hash-bound
  `arbitration/operator_decision.yaml` honored by the apply gate;
  `accept_clean_patch` delivers; `rerun_with_feedback` enqueues a follow-up;
  `revert_run` restores the live in-place tree to the turn's pre-turn snapshot —
  a server-owned, tree-SHA divergence-fenced revert that refuses (fail loud) if
  the tree has diverged from the recorded post-turn state.
- `GET /runs/:id/produced` and `GET /runs/:id/produced/<path>` serve the
  project's PRODUCED outputs — the repo `artifacts/` dir, the macOS Canvas
  source — distinct from the run-internal `GET /runs/:id/artifacts` tree.
- `GET /events` is the global live-only run-event multiplex (see the streaming
  contract below).

`GET /healthz` is the only unauthenticated route; it is loopback-host guarded
and returns liveness only.

### Spec flow (interview → frozen SpecPack → Implement)

The server owns the interactive spec interview; a surface is a thin driver.
`POST /spec/questions` runs a read-only grounding `plan` over the prompt, with a
grounding instruction that asks the harness to end its plan with a structured
`## Open Questions` block; the server parses that into multiple-choice
`InterviewQuestion`s (`single`/`multi` with `options`, or free-text `text`) and
returns them (`planRunId`, `planDir`, `questions`). Parsing is tolerant for
backward compatibility: a plain untagged bullet under the heading (no `[kind]`
tag, no `::` options) degrades to a free-text question. The surface renders the
choices and collects answers (selected `option_ids` and/or free `text`), then
`POST /spec/freeze` freezes a
SpecPack and persists it, returning `specId`, `specDir`, `specPath` (the frozen
SpecPack file), `specHash`, and `changes`. An Implement run is then a normal
agent thread turn: `POST /threads/:id/turns` carrying that `specPath`, so the
agent runs against the frozen SpecPack contract rather than a bare prompt. The
interview is multi-tier (`priorDecisions` carries earlier answers into the next
question round), while the frozen SpecPack remains single-commit in v1 — one
freeze, no post-freeze spec-version ladder.

### Event streaming contract (snapshot-then-subscribe)

Every `RunEvent` carries a monotonic per-run `seq` stamped by the engine's
EventLog at emit time (control-api audit appends continue the same sequence).
`GET /runs/:id` returns the snapshot together with `lastSeq` — the highest seq
already reflected in that snapshot — so a client subscribes to
`GET /runs/:id/events` with `Last-Event-ID: <lastSeq>` and applies deltas with
no gaps and no duplicates. The per-run stream replays from the canonical
`events.jsonl` (legacy pre-seq lines fall back to line-number ids) and is
push-driven by the daemon's in-process run-event bus, with a file-tail poll as
fallback; `output.ready` is guaranteed to precede the terminal
`run.completed|run.failed|run.blocked` event in every mode, so a client that
has applied the terminal event provably has the output. `GET /events` is the
global LIVE-ONLY multiplex (events tagged with `run_id`, no replay): on
reconnect a client re-snapshots `/runs` first and uses per-run streams where it
needs gap-free state.

A QUEUED job's per-run stream does not 404: `GET /runs/:id/events` opens the
SSE response immediately, heartbeats while the job waits for a slot, and binds
to the run directory when it materializes — a client can subscribe at enqueue
time and never race the scheduler. `claudexor follow` rides the same contract
with bounded reconnects (`Last-Event-ID` resume) and exits 1 with "stream
lost" when the stream ends without a terminal event.

### Daemon lifecycle (signals, orphans, crash GC)

`claudexord` shuts down gracefully on SIGTERM/SIGINT (same path as the
`claudexor.shutdown` RPC: abort in-flight runs, bounded wait, persist state).
While running it snapshots its live harness child process groups to
`daemon/pids.json`; the NEXT startup reaps recorded orphans that survived a
crash (pid liveness + command-name recycling guard) and sweeps workspace
debris under daemon-known project roots: orphaned envelopes (with their
seeded-credential homes), dead per-attempt `claudexor/<task>/<attempt>`
branches, leaked `claudexor/verify-*` branches, and stale
`claudexor-ro-*`/`claudexor-verify-*` tmp dirs. Envelopes whose creating
process is STILL ALIVE survive the sweep: `WorkspaceManager.create()` records
an owner marker (pid + kernel start time — recycling-proof) that the sweeper
honors, so in-process CLI/MCP/ACP runs are never garbage-collected by a daemon
starting mid-flight. One bounded exception: when start-time proof is
unavailable on either side (`ps`-less or sandboxed environment, legacy
marker), a live pid keeps the envelope only while its working dirs are fresh
(24h window over the newest mtime of the envelope base, owner marker, and
a bounded recursive walk of tree/home) — a recycled pid must not pin a
seeded-credential home forever. A second daemon refuses to start while a live daemon
holds the socket — checked BEFORE crash GC so a racing start can never reap
the live daemon's children. `claudexor daemon rotate-token` rotates the local
auth token (refused while the daemon is live; takes effect on next start),
and the daemon socket is `chmod 0600`.

### Interactive runs (waiting_on_user)

Harnesses with the `interactive` capability (Claude Code via its bidirectional
stream-json control protocol) can raise typed user questions mid-run; the
orchestrator OFFERS the interaction channel only to routes whose manifest
declares `interactive`. The
engine emits `interaction.requested` (questions, options, timeout deadline),
parks ONLY that attempt, and the daemon registry exposes the pending question
via `GET /runs/:id` (`pendingInteractions`, `summary.waitingOnUser`). Answers
arrive via `POST /runs/:id/interactions/:id/answer` and are delivered into the
live session (`interaction.answered`); an unanswered question times out after
the configurable `interaction_timeout_ms` (default 15 min) into a benign
decline (`interaction.timeout`) — the model continues with stated assumptions
and the run never hangs forever. Declined/timed-out interactive flow-control
tools are benign timeline events, never blocking tool errors.

`/setup/jobs` (create / status / confirm / cancel) is the only supported setup
surface; it owns the execution lifecycle for install/login/doctor setup work.
Jobs validate typed setup actions, reject inline secrets, and expose only
server-side allowlisted commands, official guide URLs, and redacted log
metadata, plus state, risk flags, command preview, log path, cancel, and an SSE
status projection. Native clients may open the job's Terminal handoff or show
the returned command; they do not construct setup commands locally.

Every endpoint is loopback + bearer-token guarded. Apply endpoints read
`final/patch.diff`; read-only modes without a patch return a real error instead
of local fake apply state.

`POST /runs/:id/control` is capability-based. The implemented minimum is
cancel/interrupt: daemon abort closes the active harness stream and the process
helper sends a cooperative interrupt with hard-kill fallback. Live input
forwarding into a running harness is not a supported control surface; the
former `/runs/:id/input` endpoint and `RunInput` DTO were removed in v0.7
rather than left as an always-`unsupported` stub.

A run blocked by `NEEDS_HUMAN` findings (reviewer escalation, protected-path
change, critical-risk diff) is a terminal `blocked` state whose findings surface
inline on the blocking turn and in the run inspector's Review tab (there is no
separate Review Queue screen). Since v0.9 the human decision is a TYPED server action:
`POST /runs/:id/decision` records `accept_risk` / `override_needs_human` as an
auditable, patch-hash-bound `arbitration/operator_decision.yaml` that the
single-owner apply gate honors on BOTH surfaces (Control API and `claudexor
apply`); `accept_clean_patch` delivers through the gate and
`rerun_with_feedback` enqueues a follow-up run. A mutated patch invalidates the
override. UI must not fake local accept/unblock state. The CLI resolves a run from
any cwd (project store, user Ask store, or — only when a daemon is already running —
the daemon registry); read-only lookups (`inspect`/`apply`) never auto-start a
daemon, while acting paths (`run`/`race`/`create`, `decision`) do.

A run is applyable only at `succeeded`/decision `success` (or a `blocked` run
unblocked by the typed override above). A clean CROSS-FAMILY VERIFIED review is
sufficient verification even without a deterministic test gate;
`DecisionRecord.verification_basis` (`cross_family_review | both`)
discloses what backed an applyable outcome, so a no-test run adopted on review
evidence never reads as "tests passed". Before adoption/apply eligibility, an
otherwise-adoptable ENVELOPE-produced patch — race winner or convergence
result — also passes the FINAL VERIFIER (D12): the patch is applied onto a
FRESH worktree at its own base sha and the deterministic gates re-run there,
recorded as `DecisionRecord.final_verify`
(attempted/applied_cleanly/gates_passed/reason). In-place turns are exempt
(their diff was produced against the LIVE tree; a bare snapshot worktree has
no gitignored deps and would false-block green work), and the re-run is only
meaningful for gates that are HERMETIC to the checkout — a gate that depends
on non-committed state (e.g. an installed `node_modules`) will fail on the
verify tree and block the run until made hermetic or overridden.
A failure BLOCKS the run with a typed `verification` failure; the apply gate
refuses a patch that failed to apply on the verify tree outright (no override
can make an unappliable patch deliverable), while failed verify GATES can be
overridden through the same accept_risk path as any blocked run. The verifier
FAILS CLOSED on its own infrastructure errors (`applied_cleanly: null` after
an attempt — worktree add failure, git timeout, unwritable tmp): the run
blocks exactly like a proven failure, and because it is an infra failure
rather than a proven conflict, accept_risk on the blocked run may override
it. Risk overrides are honored ONLY on blocked runs, everywhere.
Deterministic-first: the verifier spends no model tokens. Cross-family verification requires each
reviewer family's route proof to be OBSERVED, not an argv echo: claude reports
its model in the stream, and codex (whose `--json` stream omits the model)
recovers the model it actually ran from its own session rollout transcript
(`observed_model_source: "transcript"`). An unobserved reviewer stays
`accepted_model_arg` and does not satisfy the cross-family gate. For `ungated` /
`review_not_run` outcomes the apply gate states the real path forward (add a gate
or obtain a verified review) — the risk override applies only to `blocked` runs.
`TaskContract.constraints.protected_paths` contains spec/config-owned protected
globs, while `TaskContract.constraints.auto_protected_paths` is derived from
configured deterministic gates. Existing auto-protected gate/test path edits
block unless the run carries a typed `protected_path_approvals` entry for the
matching glob (CLI: `--allow-protected-path`). Those approvals are scoped only to
`auto_protected_paths`; they do not suppress spec/config-owned protected paths or
built-in critical/security path gates such as `.github/workflows`. They are
accepted only from the run request surface, not from frozen SpecPack constraints.

### Live-tree mutation paths

Every path that can mutate the live project tree is enumerated here with its
fence (Bible INV-113); an unlisted mutation path is a release blocker:

1. **Envelope delivery/apply** — `POST /runs/:id/apply` and CLI
   `claudexor apply` both go through the single-owner apply gate
   (`validateApplyGate` in `packages/delivery`): terminal success or a typed
   patch-hash-bound operator decision, a patch WorkProduct, and the original
   verified repo root are required before `deliver` touches the tree.
2. **Orchestrate `auto_full` apply step** — the executor's only RISKY tool call
   sends the referenced run's patch through the SAME `validateApplyGate` +
   `deliver` path (plus a secret-like-token scan on the patch); the gate
   refusing means no mutation.
3. **In-place thread turns** — a write turn executes directly in the thread's
   execution tree. Fences: a pre-turn snapshot is taken at turn start and a
   post-turn snapshot at turn end (the per-turn diff base, so prior dirty state
   is never attributed to the turn), and the server-owned `revert_run` decision
   can restore the pre-turn state while the tree still matches the recorded
   post-turn snapshot (divergence-fenced, below).
4. **Race winner adoption** — a best-of-N thread race runs candidates in
   isolated envelopes and applies the winner's patch to the execution tree ONLY
   on a clean terminal (success or ungated); blockers stop adoption. Adoption
   runs the PROTECTED apply path (`git apply --check` first, restore on a
   `--3way` failure): `adopted:false` guarantees the tree is byte-identical,
   and a failed restore is disclosed as `tree_mutated` on the adoption event
   instead of hidden (INV-114).
5. **Thread apply** — `POST /threads/:id/apply` delivers an isolated thread's
   accumulated worktree diff. Fences: a HEAD-RUN STATE GATE (a thread whose
   head run is blocked or failed 409s unless a typed operator decision covers
   that run — the audited `control.rejected` event records the refusal; D4),
   a secret-like-token scan refuses the patch, a project-HEAD-moved check is
   disclosed as an advisory, and delivery reuses the shared protected
   `deliver` path (`--check` first, restore on failure, honest
   `treeMutated`).
6. **Automatic git init** — a NON-GIT project folder is initialized before any
   write candidate spawns (`.gitignore` seeded with `.claudexor/`, `git init`,
   deterministic baseline commit). Fence: the mutation is announced via a typed
   `project.git.initialized` run event — never silent.
7. **`revert_run`** — the server-owned in-place revert restores a turn's
   pre-turn snapshot ONLY when the current tree's content-stable tree SHA still
   matches the recorded post-turn snapshot; a diverged tree is refused loudly
   and left untouched.

Reviewer selection is schema-owned. The automatic selector uses provider-family
diversity plus optional per-family `reviewerModels` / `reviewerEfforts` hints.
For release and dogfood gates, the `reviewerPanel` field on
`ControlRunStartRequest` carries an
ordered list of explicit `{ harness, model?, effort? }` entries. That panel is
used verbatim: repeated harness ids are allowed for multi-model Cursor passes,
no provider-family dedupe is applied, and unknown/unavailable/disabled/fake-only
or review-incompatible harnesses fail the run before review starts. If an
adapter can enumerate models, an explicit reviewer model must be present in that
inventory, and an empty/unavailable inventory is treated as unverifiable for
that explicit model. If an adapter cannot enumerate models, the explicit model
must match the harness manifest's non-authoritative known-good hints; otherwise
the run fails loudly with a `claudexor models --harness` hint instead of letting
the native CLI fail later as unparseable review output.
Same-family panels are allowed for diagnostics and repeated-model comparison,
but they do not make a clean verified review gate by themselves: the gate still
requires at least two distinct observed provider families. CLI
`--reviewer-panel` is the primary operator surface for this field; UI clients may
send the same DTO but must not invent reviewer readiness outside doctor/status
and declared intent.

Budget caps: the engine enforces `max_usd` per run (explicit run input, then
surface defaults, then the global `budget.max_usd_per_run`). There is no daily
`$`/day cap — `budget.max_usd_per_day` was removed; the only enforced money cap
is per-run. Subscription/quota pressure is respected through the harness-reported
quota/rate-limit signals, not a `$`/day ledger. Parallel race waves reserve a
per-candidate estimate floor (`budget.estimate_usd_floor`, default $0.05) for
every slot after the first, so concurrent in-flight candidates count against
the cap BEFORE usage streams; a slot whose estimate does not fit remaining
headroom is a typed `estimate_headroom` lease denial (already-granted work
continues — only a tripped hard cap stops everything).

Quota is a TYPED event, never scraped prose (D7): codex reports its own
rate-window record (`token_count.rate_limits` in the rollout transcript, the
same native source route proof uses) as `HarnessEvent.quota{used_percent,
resets_at}`; claude has no machine-readable subscription-quota surface, so it
honestly emits nothing. The budget layer maps quota to a native-quality
`used_percent` observation; `headroom()` consumes it, pool ordering multiplies
by it, and the run log discloses `budget.quota_pressure` at >=50% window burn.
Portfolio routing runs on REAL metrics: per-harness EMA averages of settled
attempt cost/duration persisted under the config dir
(`telemetry/harness-metrics.json`; one producer — attempt settlement) fill
`costPerCall`/`latencyMs`, and operator-declared per-family priors
(`routing.quality_priors`, 0..1) fill `qualityForIntent` — so
cheapest/strongest/balanced genuinely differentiate.

Structured output (D10): routes whose manifest declares `json_schema_output`
receive `HarnessRunSpec.output_schema` — today the orchestrate BRAIN passes
the OrchestratePlan JSON Schema computed from the live Zod shape, strictified
for vendor strict modes (every object: `required` = all keys,
`additionalProperties: false`; inline root — both live-verified: codex
`--output-schema <FILE>` written into the scoped CODEX_HOME, claude
`--json-schema <inline JSON>`). Plan parsing is structured-first (a bare-JSON
final message parses directly; fenced JSON stays the fallback for
non-capable routes). Live plan checklists (D14) ride typed
`HarnessEvent.plan_progress` (codex `todo_list` items; claude
TaskCreate/TaskUpdate accumulation — TodoWrite kept for older CLIs), forwarded
as last-wins `plan.progress` run events and projected on the run detail as
`planProgress`; per-candidate evidence cards (D13) are projected on the run
detail as `candidates` from attempt/review/decision artifacts.

Per-commit review gate for this repository (D18): `claudexor review --diff
<file>` reviews a diff through the engine's reviewer machinery (fail-closed:
the pass bar is cross-family healthy AND verified with no
INSUFFICIENT_EVIDENCE); `scripts/commit-review.mjs` runs it against an
INDEX-SNAPSHOT worktree with a secret fence and a HEAD-read panel config
(`.claudexor/review-panel.yaml` — versioned, chooses reviewers only), falling
back to an OpenRouter triad-lite with strict finding-shape quorum; bypasses
are audited (`review-bypass.jsonl` + commit-body disclosure). Hooks are
opt-in via `scripts/install-hooks.sh`.

Runtime resilience is typed. Adapters translate native transient failures
(network lookup failures, stream disconnects, retryable HTTP statuses, timeouts)
into typed `transient` `HarnessEvent`s; the orchestrator may retry only within the bounded
global `runtime.transient_retry` policy and only when the failed attempt produced
no deliverable. Reviewer panels use `runtime.reviewer_timeout_ms` (default 10
minutes). A timed-out reviewer still records any observed model/route proof that
streamed before timeout. Candidate/planner/read-only harness streams carry an
INACTIVITY watchdog (`runtime.harness_inactivity_timeout_ms`, default 20
minutes; env `CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS`): no events for the
window means the vendor CLI is wedged — the stream is aborted (process-group
kill) and the attempt fails with a typed message instead of parking the run in
`running` forever. The timer resets on every harness event, so long runs are
fine as long as they keep talking; a tool call that streams nothing for the
whole window is indistinguishable from a hang and is killed.

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
final/orchestration.md?            (orchestrate: human-readable orchestration summary)
final/orchestration.yaml?          (orchestrate: the typed orchestration plan)
final/orchestration_parse_error.md? (orchestrate: plan-block extraction failure detail)
final/orchestration_progress.yaml? (orchestrate: per-step executor progress, auto_safe/auto_full)
plans/<harness>.md?           (plan mode)
attempts/aNN/events.jsonl?    (read-only modes)
```

`final/orchestration.yaml` is the TYPED `OrchestratePlan` artifact: it is
extracted from the fenced JSON block in the brain's report and validated
against the tool belt. A missing or invalid block writes
`final/orchestration_parse_error.md` and is disclosed in the summary.

`final/telemetry.yaml` (`RunTelemetry` in the schema) is the single engine-owned
record of per-attempt web evidence (requested/effective mode, attempted,
satisfied, status), unrecovered tool errors, non-blocking tool-warning counts,
attempt outcome dimensions, statusless results, adapter-declared transient
failures, and dropped native events.
Surfaces project it; they never recompute evidence from raw events or model prose.

Convergence can also finish as `stuck_no_progress`: the same candidate diff was
produced repeatedly while a required deterministic gate still failed. That state
is terminal, non-applyable, and diagnostic; it tells the operator to inspect the
stable patch and gate output rather than burning more identical repair attempts.

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

The UI behavioral and visual contract — the one-screen chat shell, the
composer, the Workbench (`Run Detail | Canvas`), Settings, and every
interaction rule — lives in [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md), the macOS
UI/UX SSOT. This section keeps only the engine-facing facts.

- The app is a thin native control surface over the control API (§7). It
  consumes: threads and turns (`/threads`, `/threads/:id`, `/threads/:id/turns`,
  `/threads/:id/apply`), runs and events (`/runs`, `/runs/:id`,
  `/runs/:id/events`, `/events`), run-internal artifacts (`/runs/:id/artifacts`)
  and produced project outputs (`/runs/:id/produced` — the Canvas source),
  delivery, decisions, and control (`/runs/:id/apply/check`, `/runs/:id/apply`,
  `/runs/:id/decision`, `/runs/:id/control`,
  `/runs/:id/interactions/:id/answer`), harness status (`/harnesses`,
  `/harnesses/:id/models`), setup jobs (`/setup/jobs`), settings and secrets
  (`/settings`, `/secrets`), and the server-owned spec flow
  (`/spec/questions`, `/spec/freeze`; the app's Spec intent is a thin driver
  over these endpoints, not a new `ModeKind`).
- The app must not invent server state: delivery, decisions, review verdicts,
  routing readiness, setup progress, and budget truth are projections of
  control-api DTOs and run artifacts, never app-local logic. Read-only modes
  expose no patch/apply controls.
- Attachments are an engine contract the composer merely feeds: upload bytes
  are sunk to a scoped store OUTSIDE any worktree before a daemon job is queued
  (bytes never enter `jobs.json` or `git add -A` scope), forwarded to the
  harness in its NATIVE shape (codex `-i/--image`, claude base64 image block on
  the stream-json transport, raw-api `image_url` data URL), and vision-gated:
  an image-bearing run routes only to harnesses declaring
  `capability_profile.image_input`, else it is refused pre-flight. Direct
  non-thread `POST /runs` accepts only non-empty absolute existing file paths
  for attachments; inline base64 is accepted only through thread/composer turn
  creation.
- The agent-driven browser is an engine capability the app merely arms: the
  adapter injects Microsoft's Playwright MCP (codex via stateless
  `-c mcp_servers.browser.*` overrides, claude via `--mcp-config` inline JSON —
  the agent gets the Playwright navigate / screenshot / snapshot browser
  tools) only when the run opted in, the harness declares
  `browser_tool`, web policy is not `off`, and the run has **full access**
  (codex's workspace-write sandbox cancels the navigation — live-verified).
  The injection is disclosed, the browser runs HEADED, and navigation
  snapshots land in the run artifact tree. Cursor/OpenCode/raw-api report
  `browser_tool: false` (honest — no injector wired).

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
