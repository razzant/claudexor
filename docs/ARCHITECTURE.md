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
A harness is not a role. Roles are intents (`explain`, `plan`, `implement`,
`repair`, `review`, `compare`, `synthesize`, `audit`).

```text
surface -> schema/control DTO -> orchestrator/core -> gateway -> harness adapter -> native tool/API
        <- typed events/artifacts/reviews/budget/WorkProduct <-
```

Surfaces stay thin. Business logic belongs in core/orchestrator/control-plane
packages, never in macOS or CLI-specific state.

## 2. Canonical Modes

`ModeKind` lives in `packages/schema` and is the single source of truth. v0.9
collapsed the nine v0.8 ids into FIVE intents-on-a-thread; engine strategies
became flags, not modes:

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
  plan over the six-tool belt (`start_run`, `race`, `status`, `answer_question`,
  `apply`, `review`) and writes `final/orchestration.md`. With one verified
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
- `portfolio` is recorded in `TaskContract.budget.portfolio`, default
  `subscription-first`.

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
intent for the selected mode (`explain` for Ask, `audit` for Explore/Audit,
`implement` for Agent/repair paths, `plan`, etc.), and support read-only when
the mode requires it. Surfaces show unavailable/degraded harnesses with reasons,
but gate them out of launch and routing.

Harness manifests include both compatibility booleans and a structured
`capability_profile`: execution surface, session/resume support, output/event
shape, auth sources, and access-control proof. Capabilities are data-driven and
declared by the adapter: `effort_levels` (a shared normalizer clamps a requested
hint onto the nearest supported level) and `known_models` + `models_authoritative`
(a shared `validateModel` rejects an unknown model when the list is authoritative,
else WARNS and passes it through, since the vendor CLI is the final authority).
`doctor` validates each harness's CONFIGURED default model this way, so a broken
default (e.g. a model the CLI cannot run) is reported honestly instead of masked
by a smoke that used a different model. UI and future RunControl behavior
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
In the macOS app, Ask may run with no Current Project. The harness cwd is an
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

### Explore

Runs a bounded read-only swarm (`intent: audit`, default width 4, cap 8). Each
explorer writes a per-attempt event stream and a findings markdown artifact.
Orchestrate runs write `final/orchestration.md` (the brain's markdown plan)
plus `final/orchestration.yaml` — the TYPED `OrchestratePlan` artifact extracted
from the report's fenced JSON block and validated against the tool belt; a
missing/invalid block writes `final/orchestration_parse_error.md` and is
disclosed in the summary. Explore final artifacts include `final/explore.md`, `final/explore-findings.yaml`,
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

Thread turns (v0.10) run IN-PLACE: an agent turn executes directly in the
execution tree (the live project for an `in_place` thread, or the thread's
persistent worktree for an `isolated` thread; `RunInput.executionRoot`), so the
routed harness resumes its own native CLI session and the next turn sees the
work — no `session.rebound` for these. A best-of-N race still runs candidates in
throwaway envelopes from the tree's current state and AUTO-ADOPTS the winner's
patch into the execution tree (`git apply --3way`, disclosed via
`work_product.adopted`); a conflict leaves `adopted:false` and offers a manual
apply, never losing work. Blockers (NEEDS_HUMAN / non-clean terminal) stop
adoption. An isolated thread's accumulated worktree diff is delivered to the
project on demand via `POST /threads/:id/apply`.

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

Runs eligible planners read-only with an explicit "plan, do not implement"
instruction wrapped around the goal (so the model produces a plan instead of
trying to build it and dumping code when writes are blocked), stores per-harness
plans, cross-reviews when reviewers are available, and writes `final/plan.md` —
an honest `# Plan` document (goal, per-planner plans, ALL review findings with
severity so a BLOCK like "feature not delivered" is visible, open questions). It
also writes `final/work_product.yaml` with `result_kind: plan` and a null
diffstat, so a surface reports "plan only — no files changed" rather than a green
"succeeded" over nothing. A follow-up turn implements it via the `planRunId`
field (the engine prefixes the approved plan into the next agent turn's prompt).
The spec interview is Plan/draft-owned, not a permanent top-level app sidebar
concept.

### Read-only Audit

Runs one selected compatible harness read-only with `intent: audit` and writes
`final/report.md`.

## 7. Control API

The daemon is the durable scheduler. The HTTP control API is a live viewport and
artifact/delivery facade:

- `POST /runs`
- `GET /runs`, `GET /runs/:id`, `GET /runs/:id/events`
- `GET /events` (global live-only run-event multiplex)
- `POST /threads`, `GET /threads`, `GET /threads/:id` (the chat/session-first
  conversation SSOT; threads carry run lineage + native harness sessions). A
  thread declares a `workspace.mode`: `in_place` (default) mutates the live
  project tree; `isolated` keeps a persistent git worktree per thread. It also
  carries sticky routing — `primaryHarness` and `eligibleHarnesses` — that its
  turns inherit.
- `PATCH /threads/:id` (rename / archive a thread: title + open/closed state;
  switch the sticky `primaryHarness` / `eligibleHarnesses`)
- `POST /threads/:id/turns` (a follow-up turn: enqueues a run anchored to the
  thread. Agent turns run IN-PLACE in the execution tree — the live project for
  an in-place thread, or the thread's worktree for an isolated thread — so the
  routed harness resumes its own native CLI session and the next turn sees the
  work. A best-of-N race runs candidates in isolated envelopes and auto-applies
  the winner to the execution tree (a typed `session.rebound` disclosure covers
  those isolated candidates). A `planRunId` body field implements an approved
  plan from an earlier turn; a `specPath` body field Implements against a frozen
  SpecPack — the agent runs against that contract instead of a bare prompt)
- `POST /threads/:id/apply` (deliver an isolated thread's accumulated worktree
  diff to the project; in-place threads write the project directly and never
  need this)
- `POST /runs/:id/decision` (typed operator decision on a blocked run:
  `accept_risk` / `override_needs_human` persist an auditable patch-hash-bound
  `arbitration/operator_decision.yaml` honored by the apply gate;
  `accept_clean_patch` delivers; `rerun_with_feedback` enqueues a follow-up;
  `revert_run` restores the live in-place tree to the turn's pre-turn snapshot —
  a server-owned, tree-SHA divergence-fenced revert that refuses (fail loud) if
  the tree has diverged from the recorded post-turn state)
- `POST /runs/:id/interactions/:id/answer` (deliver a waiting_on_user answer)
- `GET /runs/:id/artifacts`, `GET /runs/:id/artifacts/<path>`
- `GET /runs/:id/produced`, `GET /runs/:id/produced/<path>` (project OUTPUTS — the repo `artifacts/` dir — for the Canvas, vs the run tree above)
- `POST /runs/:id/apply/check`, `POST /runs/:id/apply`
- `POST /runs/:id/control`
- `GET /harnesses`, `GET /harnesses/:id/models`
- `GET /setup/jobs`, `POST /setup/jobs`, `GET /setup/jobs/:id`,
  `GET /setup/jobs/:id/events`, `POST /setup/jobs/:id/confirm`,
  `POST /setup/jobs/:id/cancel`
- `GET|POST /settings`
- `GET|POST /secrets`, `DELETE /secrets/:name`
- `POST /spec/questions`, `POST /spec/freeze`

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

### Interactive runs (waiting_on_user)

Harnesses with the `interactive` capability (Claude Code via its bidirectional
stream-json control protocol) can raise typed user questions mid-run. The
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
forwarding into a running harness is not a v0.7 surface; the former
`/runs/:id/input` endpoint and `RunInput` DTO were removed rather than left as
an always-`unsupported` stub.

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
evidence never reads as "tests passed". Cross-family verification requires each
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

Reviewer selection is schema-owned. The automatic selector uses provider-family
diversity plus optional per-family `reviewerModels` / `reviewerEfforts` hints.
For release and dogfood gates, `ControlRunStartRequest.reviewerPanel` carries an
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
quota/rate-limit signals, not a `$`/day ledger.

Runtime resilience is typed. Adapters translate native transient failures
(network lookup failures, stream disconnects, retryable HTTP statuses, timeouts)
into `HarnessEvent.transient`; the orchestrator may retry only within the bounded
global `runtime.transient_retry` policy and only when the failed attempt produced
no deliverable. Reviewer panels use `runtime.reviewer_timeout_ms` (default 10
minutes). A timed-out reviewer still records any observed model/route proof that
streamed before timeout.

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
final/orchestration_progress.yaml? (orchestrate: per-step executor progress, auto_safe/auto_full)
plans/<harness>.md?           (plan mode)
attempts/aNN/events.jsonl?    (read-only modes)
```

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

The macOS app is a native control surface over the control API:

- the app is chat-first: ONE screen — the thread list (glass sidebar), the
  conversation (turns), and the always-live floating composer — with the selected
  run's detail in the trailing `.inspector`; there is no Home, Tasks, or
  Review-Queue screen;
- the default composer intent is `Agent` on a project thread; a no-project thread
  is `Ask`-only (project-aware intents are hidden until a project is picked, and
  Ask can run without one);
- the composer's `ProjectChip` picks the working directory (MRU recents +
  Browse…) and is the ONLY place project selection lives; the composer exposes
  intent (`ask`/`plan`/`audit`/`agent`, plus Race as an agent strategy and
  **Spec**; `orchestrate` is CLI-only), the eligible pool, the sticky primary
  harness, a **per-turn model picker** for the primary harness (enumerated ids
  when the harness can enumerate, else honest free-text; empty = harness/global
  default), a per-turn budget cap, access profile, web policy, project-context
  depth, isolated-workspace toggle, explicit reviewer panels, typed
  protected-path approvals for auto-protected gate/test paths, and agent repair
  strategies (until-clean / max-attempts). Portfolio and deterministic gate
  commands are engine/Settings concerns, not per-turn composer controls;
- **Spec** is a macOS UI intent, not a wire run mode: it drives the server-owned
  spec flow client-side (`POST /spec/questions` → answers → `POST /spec/freeze`)
  and then sends a normal agent turn carrying the returned `specPath` to
  Implement against the frozen SpecPack. The read-only grounding plan uses ONLY the
  composer's eligible pool (with each harness's default model); the per-turn
  model/budget/access/web/repair options the user set do NOT affect grounding — they
  are captured and applied to the write Implement turn. It maps to the engine's
  read-only `plan`/spec endpoints, not a new `ModeKind`;
- while a turn is running, the composer's **Send button swaps to Stop** (a
  server-owned cancel of the running turn), since a new turn cannot start over a
  live native session;
- a terminal turn that FAILED with no answer/transcript renders an **inline
  failure card** with the engine's honest failure reason, instead of reading as
  idle next to a red status pill;
- Settings is a real macOS `Settings` scene (`Cmd+,`) with grouped preferences;
- Settings edits app preferences and engine defaults exposed by `/settings`,
  including appearance/motion, routing/model defaults, budget, auth status, and
  secret refs; per-harness defaults auto-save (no Save button). Settings does
  NOT own project selection — there is no Current Project field; the working
  directory is picked only in the chat composer's `ProjectChip`;
- Budget and the Harness Doctor are Settings tabs (not a sidebar Operations
  section); the chat-first main window is the thread list + conversation, with run
  detail in the trailing inspector;
- the trailing region is a **Workbench** with a `[Run Detail | Canvas]` switch.
  Run Detail (a run's tabs) has explicit `Outcome`, `Timeline`, `Plan`,
  `Candidates`, `Diff`, `Review`, `Artifacts`, and `Diagnostics` tabs; completed
  runs open on Outcome, active runs on Timeline, and failures without output on
  Diagnostics. **Canvas** hosts the artifacts gallery — the project's PRODUCED
  outputs (the repo `artifacts/` dir) via `GET /runs/:id/produced`, images inline,
  distinct from Run Detail's `/runs/:id/artifacts` orchestration tree — and a
  user-driven mini-browser (`WKWebView` via `loadFileURL`: the project's
  `index.html`, localhost dev-server previews, arbitrary URLs) on solid surfaces;
- review/findings and diff/apply are INLINE per turn (on the turn that produced
  them and in the inspector's Review/Diff tabs), not a separate Review-Queue
  screen; their rows use stable solid metrics and must not force the app window to
  a very wide minimum size;
- budget cap editing uses validated currency text fields, never a money slider;
- hover help is required on compact/non-obvious controls, modes, harness chips,
  route proof, auth/setup actions, budget controls, and dangerous actions;
- Settings uses flat grouped sections and avoids floating black cutout shadows;
- onboarding is native-first auth plus optional API-key fallback and guided
  install/login/smoke-test actions;
- the composer accepts **attachments** (images/files) via a paperclip picker and
  a **Capture** button (system `screencapture` region select), gated by the
  primary harness's `capability_profile.image_input` (Cursor/OpenCode gate off
  rather than silently swallow an image the model never sees). Attachments forward
  to the harness in its NATIVE shape (Codex `-i/--image`, Claude base64 image
  block on the stream-json transport, raw-api `image_url` data URL) and persist in
  a scoped dir OUTSIDE any worktree — bytes never enter `jobs.json` or `git add -A`;
- the **Spec** interview is multi-tier (`/spec/questions` carries accumulated
  `priorDecisions`): each round goes DEEPER on prior answers ("Ask deeper") until
  the model surfaces no further decisions, or the user freezes ("Enough — freeze").
  The multi-harness `plan` relay cross-shares each planner's plan into the next
  planner's prompt so they converge on one aligned plan instead of planning blind.
- the composer can arm an **agent-driven browser** (a per-turn `browser` toggle,
  offered only where a pooled harness reports the `browser_tool` capability). The
  adapter injects Microsoft's Playwright MCP — codex via stateless `-c
  mcp_servers.browser.*` overrides, claude via `--mcp-config` inline JSON — so the
  agent gets `browser_navigate` / `browser_take_screenshot` / `browser_snapshot`
  tools. It is LIVE EGRESS: never injected under `external_context_policy:off`,
  and it requires **full access** (codex's workspace-write sandbox cancels the
  navigation — live-verified), which the toggle discloses and sets. The browser
  runs HEADED so the user watches the real window; navigation snapshots land in the
  run artifact tree. Cursor/OpenCode/raw-api report `browser_tool:false` (honest —
  no injector wired) and the toggle is hidden for them.

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
