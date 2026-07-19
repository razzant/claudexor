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
- `agent` - default `claudexor agent`; one primary-biased envelope route. Flags
  select the strategy on the SAME mode: `--n N` (best-of-N race with isolated
  candidate envelopes, review, synthesis, arbitration), `--attempts N`
  (convergence loop with an explicit cap), `--until-clean` (convergence loop
  with no fixed cap; stops on clean review/gates, budget/quota exhaustion,
  cancellation, or no-progress stall), `--create` (create-from-scratch intent).
- `orchestrate` - the autonomous orchestrator: routed like reviewers (doctor-ok +
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
  The executor uses the same root paid-budget ledger as planner, candidates,
  synthesis, sub-runs, and review panels. There are no nested ledgers or scalar
  spend rollups. Exhausted headroom ends the run with a failure-shaped
  `exhausted`, `exhausted_overshoot`, or `cost_unverifiable` terminal
  (`failure.yaml` + `run.failed`, never a clean success), and
  `--max-tool-calls` (control-api `maxToolCalls`) caps the plan
  steps. Both knobs apply only to `orchestrate` — any other mode refuses them
  loudly (CLI usage error / control-api 400) rather than carrying a silent
  no-op knob.

Old mode ids (`best_of_n`, `max_attempts`, `until_clean`, `explore`, `create`,
`readonly_audit`, plus the older `daily`/`until_convergence`/`readonly_swarm`)
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
- `packages/gateway`: harness discovery and capability/intent gating (route
  selection itself lives in the budget router and orchestrator routing).
- `packages/harness-codex|claude|cursor|opencode|raw-api|fake`: adapters that
  translate native CLI/API streams into typed `HarnessEvent`s. The `fake-*` kinds
  are deterministic offline test fixtures (incl. `fake-implement`, which writes a
  real worktree file and emits an orchestrate plan); they are explicit-`--harness`
  only and never enter auto/reviewer/orchestrate pools.
- `packages/workspace`: git worktree envelopes and scoped harness homes/config
  dirs for write envelopes and read-only routes via `readOnlyHomeEnv`; these keep
  relocatable, route-local state outside both the worktree and the operator's
  home. A selected native Codex route uses its Claudexor-owned file-only profile;
  native Claude also uses a Claudexor-owned config dir and exposes only the
  narrow host Keychain bridge described in §5. The package also owns diff
  capture and path-safe disposal.
- `packages/review`: deterministic gates, review, revalidation, convergence
  predicate, readiness ledger.
- `packages/arbitration`, `packages/synthesis`, `packages/budget`: evidence
  ranking, synthesis decision/prompting, spend/quota ledger + routing-goal
  router with loop detection.
- `packages/policy`: typed risk classification, protected-path/human-approval
  rules, workspace path guard.
- `packages/context`: scope atlas + lazy ContextPack for read-only modes.
- `packages/config`: layered config loading (global, project, user-level trust).
- `packages/secrets`: v2 file-only 0600 secret store and secret resolution.
- `packages/delivery`: patch check/apply/commit/branch/PR delivery and the
  single-owner apply gate.
- `packages/artifact-store`, `packages/event-log`: run artifact tree and
  append-only event log writers.
- `packages/control-api`: loopback HTTP/SSE facade over daemon and run artifacts.
- `packages/journal`: the checksummed append-only journal primitive
  (frame codec, fsync ACK discipline) that the daemon's durable state rides on.
- `packages/daemon`: durable local Unix-socket queue and journal projections for commands, projects, and threads.
- `packages/cli`: thin command surface plus local host-integration lifecycle
  (`claudexor plugin`) for generated Claude Code/Codex/Cursor/OpenCode
  skill/MCP artifacts and command artifacts where hosts support them. Plugin
  lifecycle state is user-level local setup state, not a schema/control-api
  contract.
- `packages/claudexor`: the bare-name npm bin wrapper — `claudexor` and
  `claudexord` bins that import `@claudexor/cli`'s explicit entry exports;
  the intended global install (`npm install -g claudexor`, once the npm
  namespace is live) and the ONE owner of the global bin names.
- `packages/mcp-server`, `packages/acp-server`: thin protocol surfaces. The
  MCP server rides the official TypeScript SDK v2 (concurrent dispatch, era
  negotiation down to 2024-10-07, schema-validated arguments, elicitation);
  all five run modes enqueue through the daemon `/v2` control API. Until MCP
  Tasks stabilize, MCP returns a durable run handle and exposes explicit
  status/result/cancel/interaction tools; it does not hold a tool call open or
  advertise Tasks. ACP uses the official TypeScript SDK at stable protocol v1;
  its session IDs are daemon thread IDs and list/load/resume/close/prompt/cancel
  all project the same `/v2` thread authority. ACP images and embedded resources
  are finalized through the daemon attachment pipeline before a turn enqueues.
- `packages/canary`: canary golden stories — user-level E2E smokes over the
  BUILT CLI with offline fake harnesses, each pinned to a Bible invariant
  tag (`pnpm canary`; runs in CI on every PR).
- `benchmarks/runner`: the SWE-bench Verified benchmark runner (predictions
  via the Claudexor CLI; see `benchmarks/`).
- `apps/macos`: native app; displays/edits what the engine exposes.

Adapters translate native I/O into `HarnessEvent`s. They do not select winners,
manage budgets, decide review policy, or orchestrate.

Host integrations are generated translational artifacts: Claude Code, Codex,
Cursor, and OpenCode files point at the local CLI/MCP server and carry ownership
markers for safe repair/uninstall. They do not route work or duplicate
orchestration logic.

## 4. Routing

Routing is `Pool + Primary + Routing Goal`:

- selected harness ids are the eligible pool;
- `primaryHarness` is a bias/ordering hint, not a privileged semantic role;
- `routingGoal` is recorded as `TaskContract.budget.routing_goal`, default
  `auto`; the other goals are `quality` and `economy`. The v1 portfolio ids
  have no aliases and fail at every boundary.

Single-route read-only modes (`ask`, `audit`) choose one route from the
eligible pool, primary first. `Agent` is a one-candidate envelope run. `audit
--swarm` (the old `explore`) expands a bounded read-only pool (default width 4,
capped at 8). Best-of-N expands the eligible pool over N candidates. Convergence rotates compatible
harnesses when a stall signature persists.

A thread carries sticky routing so the chat surface stays a thin gateway: a
`Thread` persists `primary_harness` (which harness answers in chat) and
`eligible_harnesses` (the pool Best-of runs — one candidate per harness, so its N is
the pool size). A turn inherits both unless its request overrides them
(`POST /v2/threads/:id/turns` accepts `primaryHarness` / `harnesses`); precedence is
**turn body > thread sticky > engine default** (config `routing.primary_harness`,
auto-pool of doctor-ok harnesses). All ordering/validation stays in the engine —
`primaryHarness` is only pinned first, and an EXPLICITLY-selected primary outside
the selected pool fails loudly (the engine rejects it). An INHERITED sticky
primary that no longer fits the pool is instead dropped by the thin gateway
before the turn is enqueued (so a stale bias never forces routing). Surfaces just
set the sticky values (`POST /v2/threads`, `PATCH /v2/threads/:id`) and send DTOs; they
never route.

Harness availability is determined by discovery + doctor + capabilities:
`available` alone is not enough. A harness must be `ok`, expose the required
intent for the selected mode (`explain` for Ask, `audit` for Audit and its
swarm,
`implement` for Agent/repair paths, `plan`, etc.), and support read-only when
the mode requires it. Surfaces show unavailable/degraded harnesses with reasons,
but gate them out of launch and routing.

Read-only routing additionally re-derives the env-sensitive readiness
evidence in the run's own resolved context: a read-only run spawns inside a
scoped throwaway HOME, so the router resolves that context ONCE (a typed
`ResolvedRouteContext`), points a source-targeted readiness probe
(`gateway.routeStatus`) at each surviving candidate with the exact env/cwd
the run will receive, and the same context object then feeds `spec.env` at
spawn. Discovery and manifests stay host-level (`statusAll`); readiness
evidence gathered in an env the run never executes in is not evidence and
can no longer admit a route whose auth truth dies inside the scoped env.
Credential transports must be env-portable or honestly refused (INV-067):
claude.ai credentials live in the macOS login Keychain, which a scoped HOME
hides. Only the Claude child receives a disposable nested HOME with one
declared host bridge: `Library/Keychains` points at the user's login Keychain;
`CLAUDE_CONFIG_DIR` remains the exact Claudexor-owned default/profile config
dir, so Claude itself selects the correct independently-keyed credential item;
ordinary `~/.claude` is never used. The generic
envelope HOME (and every other harness) remains unbridged, all writable Claude
state stays in the disposable child HOME/config dir, and disposal removes the
bridge. No credential is read, copied, exported, or persisted by Claudexor.
The shared AccountsSurface's per-row `Log in` / `Manage` action is the sole
product UX and rides the daemon-owned Native setup job; the pre-existing
setup-token route is an advanced CI transport, not a separate account/setup
surface. Codex is
portable by construction (file-only `CODEX_HOME` seed, INV-061).

Harness manifests carry capability booleans the engine consumes (intent
gating, knob support, the interactive-channel gate) and a small structured
`capability_profile` limited to what is actually read: auth sources and
credential transports, isolation containment, the honest readonly mechanism,
and finite `attachment_inputs` declarations (the never-consumed execution-surface/session/output
subtrees were deleted in the stabilization triage — a declared capability with no
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
the USER-LEVEL trust config (`~/.claudexor/v2/trust/<repo-hash>.yaml`); versioned
repo config can never self-grant it, and the violation is a loud routing error
naming the resolved trust path, not a silent downgrade. `claudexor trust` is
the writer for that file (`--allow-full-access`, `--revoke-full-access`,
`--access-default readonly|workspace_write`). Per-harness engine defaults
(`harnesses.<id>.enabled/default_model/effort/web/max_turns/max_rounds/
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
gate/test path portion of that policy. Plans and repo config cannot carry
approvals; operator approval is always supplied on the current run.

Large synthesis inputs are file-backed: findings + full candidate diffs land
temporarily as `.claudexor-synthesis-input.md` inside the synthesis envelope,
the argv prompt only instructs the harness to read it, and the file is removed
before every diff/gate/review (including native retries). This prevents
`spawn E2BIG` without truncating evidence or polluting the candidate patch.

Disposable candidate envelopes also preserve bounded raster outputs before
cleanup (PNG/JPEG/WebP/GIF, 16 MiB each / 32 MiB total) under the attempt's
run-artifact tree. The winner's copies materialize at the run root so relative
markdown screenshot links remain inspectable after the worktree is disposed;
they remain INTERNAL run evidence until the patch is applied to the project,
preserving INV-051's two artifact planes.

`auto` is evidence-driven: it permits web tools where the harness supports them
and records whether the harness actually attempted web. If a web tool is
attempted and its `tool_result` errors, the attempt is `web-unsatisfied` until a
later successful web result proves recovery. Read-only Ask/Audit can route
fallback to another eligible harness and emits `route.fallback.started`,
`route.fallback.completed`, or `route.fallback.exhausted`.

## 5. Auth And Secrets

Native harness auth is preferred. API-key fallback uses the v2-owned `0600`
file store in `packages/secrets`. There is no System Keychain branch in this
store, so a disposable data root contains every managed-secret operation.
The routing/auth policy is subscription/native first where that route is
readiness-proven; API-key refs are fallback secret refs. `auto` probes the native
route first for Codex, Claude, and Cursor in host and scoped/envelope contexts;
only an unavailable or unusable native route (and, for Claude, no verified
setup-token source) permits the verified API-key fallback. Selecting that
fallback emits typed `route.fallback.auth_switched`
evidence with reason `readiness_preferred`, preventing a silent paid-route
switch. Native/subscription runs scrub provider API-key, token, cloud-route, and
endpoint-override env vars unless the selected route explicitly needs one,
preventing accidental API billing or source substitution.
Every Codex/Claude/Cursor doctor report is also a typed producer of
`auth_sources`: source material availability (`available | unavailable |
unknown`) and route verification (`passed | failed | not_run`) are independent.
Control API DTOs project the same array as `authSources`; setup verification,
CLI `auth status`, and macOS Auth UI consume it. Explicit `subscription` excludes
API-key smoke, explicit `api_key` excludes native fallback, and `auto` preserves
native-first fallback. A point probe may request `fresh` evidence, bypassing
adapter/doctor caches without clearing or replacing shared cached reports.
An absent/logged-out source is `unavailable + not_run`; a probe failure that
cannot decide source presence is `unknown + not_run`; present but wrong or
unusable source material is `available + failed`.
Adapters declare the physical credential transport they support (`config_file`,
`env_var`, `oauth_token_env`, `os_keychain`, `http_header`, or `none`) plus the
containment strategy that keeps it honest. Native-session state remains owned by
the vendor: Codex reads a Claudexor-dedicated `CODEX_HOME` with
`cli_auth_credentials_store="file"`, never the operator's ordinary Codex profile
or OS Keychain; Claude reads a Claudexor-owned config dir and its disposable
child HOME bridges only the macOS login Keychain; Cursor declares an
OS-keychain native route. Claude/Cursor expose only that narrow host Keychain
context; Codex keeps its separate vendor credential file outside every
envelope. No route copies a vendor
credential file into an envelope. Separate fallback routes may materialize only
their selected source: Codex API-key auth seeds a temporary scoped `auth.json`,
Claude injects either the stored setup token or `ANTHROPIC_API_KEY`, and Cursor
injects `CURSOR_API_KEY`. Cursor's scoped native route bridges the user's
`~/Library/Keychains` directory so Security-framework probes work while
`.cursor` state still lands in the disposable scoped home.

Run params are validated before daemon enqueue. Inline `env`, `secrets`,
`api_key`, `token`, `password`, or similar fields are rejected, so daemon
run requests never turn the command journal into a secret store. Secret-setting
endpoints bypass command persistence and write only to the secret store.

Scoped harness homes/config dirs live outside worktree `tree/`, so `git add -A`
cannot capture auth files, sqlite logs, plugin downloads, or transcripts into
`patch.diff`.

### Credential profiles (INV-135)

A credential profile is an ADDITIVE identity for one harness beyond its
engine-default credential ladder: `credential_profiles` in the global config
holds durable NON-SECRET entries `{profile_id, harness_id, display_name,
credential_kind, isolation_locator | secret_ref, enabled}`. `config_dir_login`
profiles point at a Claudexor-scoped vendor config dir
(`CLAUDE_CONFIG_DIR` / `CODEX_HOME`, canonical absolute path, NEVER the default
vendor store); `oauth_token`/`api_key` profiles point at a namespaced
secret-store name (`claude_oauth:work`, `anthropic:acc2`, …) — the namespace
is REQUIRED (the schema refuses a bare engine-default slot like `anthropic`,
which would silently alias the default credential), and each adapter binds the
ref's base to its own provider slot so one provider's key is never sent to
another. Readiness is the doctor's separate `CredentialProfileStatus`
projection (`GET /v2/credential-profiles`, `claudexor profiles`), never
durable config; every adapter's profile probe enforces the SAME slot binding
as its run route, so a misconfigured profile reads `unavailable` instead of
being admitted and refused mid-run.

The orchestrator is the ONE resolve owner: an explicit per-run
`credentialProfileId` becomes the typed `credential_profile` on every
`HarnessRunSpec` the run builds; unknown/disabled/harness-mismatched ids are a
typed refusal before spawn. An explicit profile is STRICT in the adapter —
exactly the profile's transport or a typed error event, never a fallback to
default credentials (claude: config-dir login / stored token non-bare / stored
key; codex: scoped `CODEX_HOME` login / scoped key `auth.json`; cursor,
opencode, raw-api: secret-ref keys only). Adapters stamp
`credential_profile_id` beside `credential_route` on stream events so quota
and retry evidence stays profile-attributable, and the run's `auth_route`
receipt carries `profile_id`. Vendor sessions record the profile they were
created under; resume never crosses profiles. `claudexor profiles login
<harness> <id>` runs the same vendor login command the setup jobs use,
interactively, scoped to the profile dir.

Removal is daemon-owned and mirrors registration: `DELETE
/v2/credential-profiles/:harness/:id` (CLI `claudexor profiles remove`) takes
the registry entry out through the same locked global-config owner, then
deletes the profile's OWN credential material — its confinement-checked scoped
login dir or its namespaced secret, NEVER the default vendor store. A failed
cleanup is disclosed on the receipt (`cleanupWarning`), never silent; removal
refuses with a typed 409 while a login job for that account is active. The same
daemon mutation clears every legacy scalar thread pin carrying that profile
id, marks matching harness/profile native-session caches stale, and removes
profile quota snapshots, so deletion cannot leave a route that fails on the
next turn or resurrect a session if the id is recreated. Dependent journal
invalidation happens before registry removal; any unhealthy project partition
returns typed 409/recovery-required, leaving the profile retryable.

Selection precedence is turn > thread-sticky > engine default: a turn's
explicit `credentialProfileId` (CLI `--profile`) beats the thread's durable
`credential_profile_id` (PATCH /v2/threads/:id), and null means the default
credential ladder. The app's Use action atomically makes the profile's harness
the primary and sole eligible pool member; external thread create/PATCH calls
with an explicit pool are rejected unless the profile id exists for every pool
lane. Run preflight probes the selected profile for every lane even when the
default harness doctor is already OK, before any adapter starts:
`verification: failed` refuses even with `availability: available`, while an
intentional presence-only API-key probe may remain `not_run` (shown unknown,
then adapter-enforced). Each harness
may declare ONE typed `profile_policy`
(`limit_action: fail|ask|rotate`, priority-ordered `rotation_eligible`,
`headroom_threshold`). Two separated signals drive it (never prose, never
plain network errors): `profile_headroom_preflight` — before spawn, the
selected profile's freshest quota window at/over the threshold emits typed
`route.profile.headroom_exceeded` evidence, and `rotate` swaps to the next
eligible profile with `route.profile.rotated` provenance; and
`vendor_limit_rejected` — a TYPED vendor rate-limit that terminated a
no-deliverable, no-mutation try (`rotation_retry_eligible`) rotates the next
try onto a NEW vendor session under the next profile, each profile at most
once per attempt. Credentials never change inside a running spawn; a
rotation INTO a spent profile is refused by the same headroom check. When no
target survives (all spent/excluded/wrong-kind), the engine emits typed
`route.profile.rotation_exhausted` with each rejected profile's reason and
headroom evidence; the UI surfaces the exhaustion instead of implying a switch.

The DEFAULT subject participates under the same opt-in policy (auto-balance):
with no pinned profile and `limit_action: rotate`, a fresh default-store
headroom breach starts the run on the next eligible SUBSCRIPTION profile
(`route.profile.rotated` with `from_profile_id: null`), and a typed vendor
limit on a profile-less attempt rotates only when the attempt's pre-spawn
route estimate was `vendor_native` — a metered default hitting a limit is a
budget fact, not a subscription to fail over from. The default subject never
rotates into an `api_key` profile (the cross-kind BLOCK generalized).
`fail`/`ask` leave default-user behavior untouched. The per-harness
`limit_action` is wire-patchable as `profileLimitAction` on
`GET/POST /v2/settings` (the app's auto-switch toggle); rotation order and
headroom keep their stored values.

## 6. Main Execution Paths

Every public CLI mode (`ask`, `plan`, `audit`, `agent`, `orchestrate`) and the
interactive REPL enters through the managed daemon and `/v2`; the CLI starts it
when needed and fails loudly if it cannot. There is no second in-process CLI
run/thread authority. The daemon remains the single scheduler and journal
writer while the mode pipelines below retain their distinct mutability.
`claudexor doctor`, `models`, and `auth status` are also thin projections of the
daemon's typed `/v2/harnesses` and `/v2/harnesses/:id/models` readiness services;
requested harness filters reach the producer instead of probing unrelated adapters.
`claudexor trust` and `secrets` likewise project `/v2/trust` and `/v2/secrets`;
only the daemon owns user-level trust files and the selected managed-secret backend.

### Ask

Creates a run directory, writes a `TaskContract`, runs one adapter with
`intent: explain`, `access: readonly`, writes `final/answer.md`,
`final/summary.md`, and a `report` WorkProduct. There is no patch/apply control.
In the macOS app, Ask may run with no project selected. The harness cwd is an
empty synthetic directory at `~/.cache/claudexor/no-project`, while artifacts live
in the user-level store `~/.claudexor/v2/runs/<run_id>/`. If routing or the harness
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

`claudexor agent` defaults to `agent`. It is a one-candidate orchestrator/envelope
run: the harness works in an isolated workspace, Claudexor captures the git diff,
emits artifacts, and live project mutation happens only through explicit
delivery/apply.

Envelope semantics are strict. Project runs execute under
`~/.claudexor/v2/projects/<project-sha256>/workspaces/<task>/<attempt>/tree`, and
the harness `cwd` is the envelope worktree. Proven work product is the git diff in that worktree, a
declared run artifact, or an explicitly verified host side-effect. Absolute
`/tmp/...` writes are host side effects and are not project diffs; project tmp
requests default to `tmp/...` inside the project/envelope or to run artifacts.

Write modes need a git boundary for that isolation. A NON-GIT project folder is
initialized automatically before any candidate spawns: `git init` plus a
deterministic baseline commit (author `Claudexor`) make worktree diffs honest
from the first run. Claudexor never creates or edits the project's `.gitignore`;
repo `.claudexor/` is user-owned config and runtime stays external. The action
is announced via a `project.git.initialized` run event in the timeline — never
a refusal (comparator: Codex CLI refuses outside git; Claudexor creates the
boundary itself), never a silent mutation. Read-only modes and `--in-place`
stateful targets are untouched.

Read-only turns provision a scoped harness HOME (no worktree) so native state —
plan files, session rollouts, transcripts — never lands in the operator's real
home. A one-shot ask/plan gets a DISPOSABLE throwaway home deleted after the
run. A read-only turn of a THREAD instead gets a DURABLE per-lane home under
`projects/<project-sha256>/lanes/<threadId>/<harness>-<profileOrDefault>/home`
(a lane = thread + harness + credential profile), a sibling of `workspaces/`
and outside every worktree (INV-063). The lane home persists across turns so
the harness's recorded native session is reachable for `codex exec resume` /
`claude --resume` on the next lane turn (INV-034); it is removed only by thread
purge, credential-profile deletion, or the orphan-lane retention sweep.

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
throwaway envelopes from the tree's current state and may auto-adopt a verified
winner through the shared preimage-bound protected apply path. It first runs
`git apply --check`, then a plain all-or-nothing apply; stale or conflicting
targets leave `adopted:false` without destructive rollback. Blockers
(NEEDS_HUMAN / non-clean terminal) stop
adoption. An isolated thread's accumulated worktree diff is delivered to the
project on demand via `POST /v2/threads/:id/apply`. The isolated workspace is
pinned by a persistent `claudexor/thread-*` branch (not a dangling commit);
successful delivery advances that branch. Trash retains the thread and its
branch for 30 days and exposes explicit restore/purge routes.

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
field: Implement freezes the plan (sha256 recorded on the turn) and delivers it
to the executor as a server-owned file reference. The plan lifecycle — typed
open questions, server-derived readiness, plan freeze on Implement — is
plan-owned, not a permanent top-level app sidebar concept.

### Audit (single report)

Runs one selected compatible harness read-only with `intent: audit` and writes
`final/report.md`.

## 7. Control API

The daemon is the durable scheduler. `DaemonServer` requires an injected durable
command authority and has no in-memory command-record fallback. The HTTP control API is a live viewport and
artifact/delivery facade. The canonical endpoint inventory below is generated
from the control-api server source (`node scripts/gen-endpoints-doc.mjs`);
README and INTEGRATIONS link here instead of maintaining duplicates. The same
generator emits the machine-readable endpoint map for external agents at
`docs/reference/endpoints.json` — method, path, mutating flag, and
request/response/error schema names referencing the generated JSON Schemas in
`packages/schema/generated/` (null when a handler hand-builds its JSON).
Field-level semantics live in the schemas themselves: every control DTO
carries `.describe()` documentation that lands in the generated JSON Schema
files.

<!-- BEGIN GENERATED ENDPOINTS (node scripts/gen-endpoints-doc.mjs; do not edit by hand) -->
- `GET /healthz`
- `GET /v2/agent-capabilities`
- `GET /v2/credential-profiles`
- `POST /v2/credential-profiles`
- `DELETE /v2/credential-profiles/:harness/:profileId`
- `GET /v2/global/events`
- `POST /v2/handshake`
- `GET /v2/harnesses`
- `POST /v2/harnesses/:id/auth-readiness`
- `GET /v2/harnesses/:id/models`
- `POST /v2/maintenance/gc`
- `GET /v2/operations`
- `GET /v2/projects`
- `POST /v2/projects`
- `GET /v2/projects/:id/events`
- `POST /v2/projects/:id/relink`
- `GET /v2/quota`
- `POST /v2/quota`
- `GET /v2/recovery/partitions/:id`
- `POST /v2/recovery/partitions/:id/export`
- `POST /v2/recovery/partitions/:id/quarantine`
- `POST /v2/recovery/partitions/:id/validate`
- `GET /v2/runs`
- `POST /v2/runs`
- `GET /v2/runs/:id`
- `POST /v2/runs/:id/apply`
- `POST /v2/runs/:id/apply/check`
- `GET /v2/runs/:id/artifacts`
- `GET /v2/runs/:id/artifacts/<path>`
- `POST /v2/runs/:id/control`
- `POST /v2/runs/:id/decision`
- `GET /v2/runs/:id/events`
- `POST /v2/runs/:id/interactions/:id/answer`
- `GET /v2/runs/:id/produced`
- `GET /v2/runs/:id/produced/<path>`
- `POST /v2/runs/:id/retry`
- `GET /v2/runs/:id/run-again`
- `GET /v2/secrets`
- `POST /v2/secrets`
- `DELETE /v2/secrets/:id`
- `GET /v2/settings`
- `POST /v2/settings`
- `GET /v2/setup/jobs`
- `POST /v2/setup/jobs`
- `GET /v2/setup/jobs/:id`
- `POST /v2/setup/jobs/:id/cancel`
- `GET /v2/setup/jobs/:id/events`
- `POST /v2/setup/jobs/:id/extend`
- `POST /v2/setup/jobs/:id/reconcile`
- `GET /v2/setup/jobs/:id/snapshot`
- `GET /v2/threads`
- `POST /v2/threads`
- `GET /v2/threads/:id`
- `PATCH /v2/threads/:id`
- `POST /v2/threads/:id/apply`
- `POST /v2/threads/:id/purge`
- `POST /v2/threads/:id/restore`
- `POST /v2/threads/:id/trash`
- `POST /v2/threads/:id/turns`
- `POST /v2/threads/:id/turns/:id/retry`
- `GET /v2/trust`
- `POST /v2/trust`
- `POST /v2/uploads`
- `DELETE /v2/uploads/:id`
- `GET /v2/uploads/:id`
- `PUT /v2/uploads/:id/bytes`
- `POST /v2/uploads/:id/finalize`
<!-- END GENERATED ENDPOINTS -->

Endpoint semantics beyond the inventory:

- Threads are the chat/session-first conversation SSOT (run lineage + native
  harness sessions). A thread declares a `workspace.mode`: `in_place` (default)
  mutates the live project tree; `isolated` keeps a persistent git worktree per
  thread. It also carries sticky routing — `primaryHarness` and
  `eligibleHarnesses` — that its turns inherit; `PATCH /v2/threads/:id` renames /
  archives a thread (title + open/closed state) and switches the sticky
  routing.
- `POST /v2/threads/:id/turns` enqueues a follow-up run anchored to the thread.
  Agent turns run IN-PLACE in the execution tree — the live project for an
  in-place thread, or the thread's worktree for an isolated thread — so the
  routed harness resumes its own native CLI session and the next turn sees the
  work. A best-of-N race runs candidates in isolated envelopes and auto-applies
  the winner to the execution tree (a typed `session.rebound` disclosure covers
  those isolated candidates). A `planRunId` body field implements an approved
  plan from an earlier turn: Implement freezes that plan (sha256 recorded on the
  turn) and delivers it to the executor as a server-owned file reference, so the
  agent runs against the frozen plan rather than a bare prompt. `POST /v2/threads/:id/apply` delivers an isolated thread's accumulated
  worktree diff to the project; in-place threads write the project directly and
  never need it.
- Refused turns are honest end-to-end: when a turn's run dies BEFORE it starts
  (the trust gate refusing `access: full`, preflight validation, an enqueue
  throw), the daemon persists the reason on the turn (`ThreadTurn.enqueue_error`,
  projected as `enqueueError`) so every surface renders the refusal inline
  instead of an eternally-empty bubble. `POST /v2/threads/:id/turns/:turnId/retry`
  creates a new command attempt for that SAME turn by replaying the immutable
  original command params through fresh preflight (no duplicate turn); a
  successful run binding clears the error, a repeat refusal replaces it.
  Turn create and Exact Retry require `Idempotency-Key`; the same key/request
  returns the original durable handles, while key reuse with another request
  returns typed `409 idempotency_conflict`. Retry refuses turns that already
  have a run, have no recorded refusal, or still have an active job (409).
- Run-level `POST /v2/runs/:id/retry` is Exact Retry for any settled run: it
  creates a new command/turn, links `retryOf`, reuses the immutable original
  request, and performs fresh normalization/preflight. `GET
  /v2/runs/:id/run-again` instead returns an editable draft and explicitly
  lists server-owned fields omitted from that draft. The CLI projects these as
  `claudexor retry` and `claudexor run-again`.
- `GET /v2/trust` + `POST /v2/trust` are the user-level trust surface: the GET
  enumerates per-repo trust files (`~/.claudexor/v2/trust/<repo-hash>.yaml`, each
  stamped with its `repo_root` provenance so the list is human-readable; legacy
  pre-provenance files show a null root), and the POST accepts `repoRoot` plus
  `allowFullAccess` and/or `accessDefault` (strict — unknown fields are 400) to
  update one repo. Versioned project test commands are canonical typed argv,
  never implicit shell text. Their external grant binds the project/config/
  command digests, resolved executable/script bytes, and access profile;
  changing any component prevents spawn. CLI trust commands use this same
  boundary (`trust --grant-test '["pnpm","test"]'`). This backs the macOS one-click remedy on a
  trust-refused turn and the Settings trust section (list + revoke).
- `POST /v2/runs/:id/decision` records a typed operator decision on a blocked run:
  `accept_risk` / `override_needs_human` append an auditable patch-hash-bound
  record to the owning global/project journal before ACK. The run artifact
  `arbitration/operator_decision.yaml` is only a compatibility projection for
  artifact-only CLI reads; the apply gate reads journal authority;
  `accept_clean_patch` delivers; `rerun_with_feedback` enqueues a follow-up;
  `revert_run` uses an immutable external content-addressed anchor and restores
  only recorded postimage bytes that still match; overlapping later user edits
  are refused instead of overwritten. The anchor remains reachable independently
  of Git garbage collection.
- `GET /v2/runs/:id/produced` and `GET /v2/runs/:id/produced/<path>` serve the
  project's PRODUCED outputs — the repo `artifacts/` dir, the macOS Canvas
  source — distinct from the run-internal `GET /v2/runs/:id/artifacts` tree.
- `claudexor settings show|set` is a thin client of `GET|POST /v2/settings`.
  Validation, persistence, cache invalidation, and the returned effective
  `ControlSettingsSnapshot` come from the daemon; the CLI has no second config
  writer or model/effort validator.

`GET /healthz` is the only unauthenticated route; it is loopback-host guarded
and returns liveness only.

### Plan lifecycle (typed open questions → readiness → Implement freezes the plan)

Ambiguity is plan-owned: a read-only `plan` run ends its report with a
structured `## Open Questions` block that the engine parses ONCE into
`final/questions.json` (multiple-choice `single`/`multi` with `options`, or
free-text `text`). Readiness is DERIVED from that artifact by one server-side
owner — `ready` (block parsed, zero open questions), `needs_answers` (open
questions remain), or `unverified` (no parseable block) — and every surface
consumes the projection; nothing re-parses plan text. Answers are ordinary
turns in the same conversation, not a separate session identity.

Implement is a normal agent thread turn that carries `planRunId`
(`POST /v2/threads/:id/turns`). The server FREEZES the referenced plan: it reads
the plan artifact, records its `sha256` on the turn (`plan_hash`), and hands the
executor a server-owned `planRef` (`{ runId, sha256, path }`) whose file is
materialized as `context/PLAN.md` OUTSIDE every worktree. The engine verifies
the hash before any harness spawns — a tampered or unreadable plan fails loudly
(`plan hash mismatch` / missing plan), never runs against altered intent. Exact
Retry replays the `planRef` verbatim, so a retried Implement can never silently
run without its plan. Implementing while open questions remain is an explicit,
recorded operator choice (`plan_readiness_overridden`), not a silent default;
plans and repo config never carry protected-path approvals — operator approval
is always supplied on the current run.

### Event streaming contract (snapshot-then-subscribe)

Every `RunEvent` carries a monotonic per-run `seq` stamped by the engine's
EventLog at emit time (control-api audit appends continue the same sequence).
In the daemon composition root, each emitted event is also appended to its
owning global/project journal partition before live bus publication; scoped
journal streams therefore replay run progress after restart. A journal sink
failure fails the producer/run instead of being swallowed as a live-only gap.
`GET /v2/runs/:id` returns the snapshot together with `lastSeq` — the highest seq
already reflected in that snapshot — so a client subscribes to
`GET /v2/runs/:id/events` with `Last-Event-ID: <lastSeq>` and applies deltas with
no gaps and no duplicates. The per-run stream replays from the rebuildable run
artifact projection `events.jsonl` (old pre-seq fixture lines fall back to
line-number ids) and is
push-driven by the daemon's in-process run-event bus, with a file-tail poll as
fallback; `output.ready` is guaranteed to precede the terminal
`run.completed|run.failed|run.blocked` event in every mode, so a client that
has applied the terminal event provably has the output.

`GET /v2/global/events` and `GET /v2/projects/:id/events` replay the durable
global or project journal partition and then tail it. Their `Last-Event-ID`
values are opaque, partition-scoped cursors: a cursor from another partition or
epoch is rejected so the client can re-snapshot that scope. The API does not
claim a total order across partitions. There is no live-only compatibility
multiplex in v2.

The global partition additionally carries `thread.head.updated` — a
content-free invalidation ping `{thread_id, project_id, revision}` emitted on
every thread mutation from any surface (create, rename, archive, turn-add,
run-terminal). Thread mutations persist to their owning partition, so this
ping is how a single global subscription learns that a thread summary went
stale; consumers refetch the authoritative summary rather than reading state
off the event. `revision` is monotonic per thread so duplicate or replayed
pings can be dropped.

A QUEUED job's per-run stream does not 404: `GET /v2/runs/:id/events` opens the
SSE response immediately, heartbeats while the job waits for a slot, and binds
to the run directory when it materializes — a client can subscribe at enqueue
time and never race the scheduler. `claudexor follow` rides the same contract
with bounded reconnects (`Last-Event-ID` resume) and exits 1 with "stream
lost" when the stream ends without a terminal event.

### Daemon lifecycle (signals, orphans, crash GC)

Every shutdown trigger — SIGTERM/SIGINT, the `claudexor.shutdown` socket RPC,
a startup failure — enters ONE state machine (`DaemonRuntimeShutdown
.beginShutdown(reason)`): abort in-flight runs, complete their journaled
terminal transitions, close the journal, under a shared bounded escalation
ladder (hung-stop deadline, then a post-stop leaked-handle sweep, every rung
disclosed in the log). A hung participant cannot immortalize the daemon
whichever trigger asked it to die. The daemon records its birth identity in
the writer lease at startup; `claudexor daemon stop` then CONFIRMS death
(released lease, gone pid, or identity-verified SIGKILL escalation — a
recycled pid is never signalled) before reporting success, so scripts and
test disposers can trust its exit code. Stdio bridges (`mcp serve`/`acp
serve`) bound their life to their host's with a reparent watchdog — a dead
host whose pipe stays open (inherited fds) no longer leaves an idle bridge.
No-project command state, setup, and the project registry
are frames in the checksummed global journal. Each registered project's commands,
threads, turns, and vendor-session cache live in `project:<stable-project-id>`;
one corrupt project partition does not make healthy projects unreadable. The
socket returns an enqueue ACK only after append + `fsync`. Create idempotency is
scoped by client, partition, operation, and key. A restart maps every accepted
nonterminal command to `interrupted_unknown`; mutating commands are never
auto-replayed.
The deliberately empty-on-v2-start registry is global. `GET/POST /v2/projects`
list/register canonical local roots and
`POST /v2/projects/:id/relink` moves an existing stable project id. The CLI
projects the same surface as `claudexor project list|register|relink` and
auto-registers the current root before a run; no v1 config, thread, or run path
is imported as a project registration. Relink updates project-thread root
projections without changing their partition identity.
The daemon also owns DISK RETENTION (W3.6): a bounded GC pass over
engine-owned runtime artifacts — per-project run trees and standalone
`.claudexor/reviews/diff-*` debris — scheduled once after ownership+ready
(never blocking boot) and exposed as the schema-first control op
`POST /v2/maintenance/gc` (dry-run first-class, typed receipt disclosing
every deletion AND why every survivor survived); `claudexor gc` is its thin
client. It deletes ONLY terminal, unreferenced, non-actionable trees past
the configured age (`retention.*` in the global config: runs 30d, reviews
14d, newest N per project always survive): live/blocked records, runs
referenced by any non-purged thread's lineage, undelivered/applyable
patches, and trees with no terminal evidence are protected fail-closed. A
reclaimed run leaves a tombstone projection behind, so its artifacts answer
with a typed 410 `run_expired_by_retention` — never a mysterious 404.
While running it snapshots its live harness child process groups to
`daemon/pids.json`; the NEXT startup reaps recorded orphans that survived a
crash (pid liveness + command-name recycling guard) and sweeps workspace
debris under daemon-known project roots: orphaned envelopes (with their
seeded-credential homes), dead per-attempt `claudexor/<task>/<attempt>`
branches, leaked `claudexor/verify-*` branches, and stale
`claudexor-ro-*`/`claudexor-verify-*` tmp dirs. Envelopes whose creating
process is STILL ALIVE survive the sweep: `WorkspaceManager.create()` records
an owner marker (pid + kernel start time — recycling-proof) that the sweeper
honors, so a workspace whose owner is still active is never garbage-collected
by a daemon starting mid-flight. One bounded exception: when start-time proof is
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
parks ONLY that attempt, and the daemon journals the pending projection in the
run's global or `project:<id>` partition before exposing it via
`GET /v2/runs/:id` (`pendingInteractions`, `summary.waitingOnUser`). Answers
arrive via `POST /v2/runs/:id/interactions/:id/answer` and are delivered into the
live session only after the resolution is journaled (`interaction.answered`).
After daemon restart an unresolved question becomes interrupted rather than
resurrecting a dead in-process continuation. An unanswered question times out after
the configurable `interaction_timeout_ms` (default 15 min) into a benign
decline (`interaction.timeout`) — the model continues with stated assumptions
and the run never hangs forever. Declined/timed-out interactive flow-control
tools are benign timeline events, never blocking tool errors.

`/v2/setup/jobs` (create / status / snapshot / events / cancel / reconcile / extend)
is the native-login setup surface for Codex, Claude, and Cursor. Readiness and
secret writes remain in their existing doctor/auth-readiness and secret services;
setup does not duplicate them as jobs. Jobs expose a required typed phase, coarse state (including
`timed_out` and `interrupted_unknown`), deadline, and typed terminal outcome.
`GET /v2/setup/jobs` accepts schema-validated `harness`, `action`, `active`, and
`limit` filters. Setup SSE carries complete authoritative job snapshots from the
global journal. Each event has an opaque cursor plus the exact request-relative
`previousCursor`; global sequence gaps are valid, while a broken cursor chain,
duplicate/regressive frame, malformed payload, or EOF without terminal evidence
requires a resnapshot.
`POST /v2/setup/jobs/:id/reconcile` clears an unconfirmed replacement fence only
after the daemon proves the recorded process group empty. Unknown or nonempty
state remains a typed refusal and cannot be bypassed by creating another job.

Native login specs are a shared `{binary,args,displayCommand}` contract for
Codex (`codex -c cli_auth_credentials_store=file login` in its dedicated
`CODEX_HOME`), Claude (`claude auth login --claudeai`), and Cursor
(`cursor-agent login`). The daemon writes a private runner manifest; Terminal
starts the bundled absolute Node + runner; the runner executes the absolute
vendor binary without a shell, inherits the TTY, scrubs provider credentials,
and atomically records PID/kernel-start/process-group and result sidecars. It
never receives or persists a vendor token or credential file. Vendor output is
not copied into durable logs, and Terminal stays open on the result until the
operator presses Return. The daemon fsyncs an immutable executable/argv
authorization and one-use permit before the detached runner may spawn. The
runner's hash-bound result is journaled before verification. For a
DEFAULT-store login, exit zero enters a fresh, source-targeted native probe
followed by an isolated same-harness capability smoke over the normal adapter
stream; only the exact `vendor_native` / `native_session` route may pass.
Another provider, an API key, tool use, external context, or workspace mutation
invalidates the receipt. No plan-tier, entitlement, quota, or zero-cost
inference is part of this proof. A PROFILE-targeted login (INV-135:
`profileId` on the create request; the sealed manifest carries the profile's
canonical scoped config dir, and the runner exports it as
`CLAUDE_CONFIG_DIR`/`CODEX_HOME`) verifies against the PROFILE's own doctor
probe instead — the same truth `claudexor profiles login` uses — and honestly
skips the capability smoke, which attests only the default route; the job
schema's success invariant is scoped accordingly.

Login launch has a 10-second watchdog and a 15-minute deadline. Extend adds 15
minutes without a cumulative limit. Duplicate create for the SAME target store
(default, or one profile) returns the same active action instead of launching
a second Terminal; a create naming a DIFFERENT target while a login is active
refuses with a typed 409, and a conflicting active mutating
action is refused. Cancel is asynchronous. Cancel/timeout sends TERM and, after
five seconds, KILL only when PID + kernel-start identity still matches; an
unproven identity is never signalled or called cancelled. Restart consumes an
existing result first and reconciles a still-live proven login runner. A
capability smoke with no durable completed receipt becomes
`interrupted_unknown` and is never auto-replayed. Terminal outcomes distinguish
`completed`, `not_supported`, `launch_failed`, `command_failed`,
`auth_not_ready`, `capability_verification_failed`,
`credential_route_mismatch`, `timed_out`, `cancelled_by_user`,
`cancelled_on_restart`, `interrupted_unknown`, and
`termination_unconfirmed`.

The checksummed, fsync-before-ACK global journal is the only setup lifecycle and
event authority. Per-job `0700` directories under the daemon data root contain
only runner manifest/state/result/permit/launcher artifacts. There is no
per-job `job.json`, `events.jsonl`, metadata snapshot, or imported v1 registry.
Corrupt journal state fails closed; operational artifacts cannot reconstruct or
override lifecycle truth.

Every endpoint is loopback + bearer-token guarded. Apply endpoints read
`final/patch.diff`; read-only modes without a patch return a real error instead
of local fake apply state.

`POST /v2/runs/:id/control` is capability-based. The implemented verb is `cancel`:
daemon abort closes the active harness stream and the process helper sends a
cooperative interrupt with hard-kill fallback. (The former `interrupt` control
kind was deleted as a fake knob — it mapped to the same daemon cancel.) Live
input forwarding into a running harness is not a supported control surface; the
former `/runs/:id/input` endpoint and `RunInput` DTO were removed as dead code
rather than left as an always-`unsupported` stub.

A run blocked by `NEEDS_HUMAN` findings (reviewer escalation, protected-path
change, critical-risk diff) is a terminal `blocked` state whose findings surface
inline on the blocking turn and in the run inspector's Review tab (there is no
separate Review Queue screen). Since v0.9 the human decision is a TYPED server action:
`POST /v2/runs/:id/decision` records `accept_risk` / `override_needs_human` as an
auditable, patch-hash-bound record in the owning journal. The single-owner
Control API apply gate reads that authority; the mirrored
`arbitration/operator_decision.yaml` remains a compatibility projection for
artifact readers. `accept_clean_patch` delivers through `verifyAndDeliver` and
`rerun_with_feedback` enqueues a follow-up run. A mutated patch invalidates the
override. UI must not fake local accept/unblock state. The CLI resolves a run from
any cwd (project store, user Ask store, or — only when a daemon is already running —
the daemon registry); read-only lookups (`inspect`/`apply`) never auto-start a
daemon, while acting paths (`agent`/`best-of`/`create`, `decision`) do.

A run is applyable only at `succeeded`/decision `success` (or a `blocked` run
unblocked by the typed override above). A clean CROSS-FAMILY VERIFIED review is
sufficient verification even without a deterministic test gate;
`DecisionRecord.verification_basis` (`cross_family_review | both`)
discloses what backed an applyable outcome, so a no-test run adopted on review
evidence never reads as "tests passed". Immediately before any envelope patch
mutation, the delivery-owned `verifyAndDeliver` service runs the FINAL
VERIFIER: the patch is applied onto a
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
`TaskContract.constraints.protected_paths` holds config-owned protected globs,
while `TaskContract.constraints.auto_protected_paths` is derived from configured
deterministic gates. Existing auto-protected gate/test path edits block unless
the run carries a typed `protected_path_approvals` entry for the matching glob
(CLI: `--allow-protected-path`). Those approvals are scoped only to
`auto_protected_paths`; they do not suppress config-owned protected paths or
built-in critical/security path gates such as `.github/workflows`. They are
accepted only from the run request surface — plans and repo config never carry
approvals.

### Live-tree mutation paths

Every path that can mutate the live project tree is enumerated here with its
fence (Bible INV-113); an unlisted mutation path is a release blocker:

1. **Envelope delivery/apply** — `POST /v2/runs/:id/apply` and CLI
   `claudexor apply` both go through the delivery-owned `verifyAndDeliver`:
   the shared apply gate authorizes the run, a fresh verifier checks the exact
   patch, and an unchanged target preimage is required before mutation.
2. **Orchestrate `auto_full` apply step** — the executor's only RISKY tool call
   sends the referenced run's patch through the SAME `verifyAndDeliver` path
   (plus a secret-like-token scan on the patch); the gate
   refusing means no mutation.
3. **In-place thread turns** — a write turn executes directly in the thread's
   execution tree. Fences: a pre-turn snapshot is taken at turn start and a
   post-turn snapshot at turn end (the per-turn diff base, so prior dirty state
   is never attributed to the turn), and the server-owned `revert_run` decision
   uses an external content-addressed pre/post anchor (overlapping later user
   edits are refused, below).
4. **Best-of winner adoption** — a best-of-N thread race runs candidates in
   isolated envelopes and applies the winner's patch to the execution tree only
   on a fully verified `success`; `ungated`, `review_not_run`, blocked,
   and failed results remain inspectable artifacts and never auto-adopt. Adoption
   runs the PROTECTED apply path (`git apply --check` first, then a plain
   all-or-nothing apply). A stale or concurrent target is refused and no
   destructive rollback is attempted; `adopted:false` reports whether the
   observed target remained unchanged (INV-114).
5. **Thread apply** — `POST /v2/threads/:id/apply` delivers an isolated thread's
   accumulated worktree diff. Fences: one per-thread mutation queue refuses
   apply as `thread_busy` while a mutating turn is queued/running; every run
   after the durable delivered-prefix watermark must be applyable (a later
   success cannot launder an earlier blocked contribution); a secret-like-token
   scan refuses the patch; delivery reuses `verifyAndDeliver` with a fresh
   verifier and exact target preimage. Success advances the persistent thread
   branch and watermark with journaled thread state.
6. **Automatic git init** — a NON-GIT project folder is initialized before any
   write candidate spawns (`git init`,
   deterministic baseline commit). Fence: the mutation is announced via a typed
   `project.git.initialized` run event — never silent.
7. **`revert_run`** — the server-owned in-place revert reads the immutable
   external patch anchor and reverses only bytes still equal to the recorded
   Claudexor postimage; a conflicting user edit is refused and left untouched.

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

Reviewer prompts carry a typed subject. A Plan reviewer evaluates the read-only
plan's feasibility/scope/risks/questions and is explicitly forbidden from
reporting absent implementation, tests, or screenshots as defects. Code review
retains the normal patch contract.

Paid budgets use an explicit tagged contract: `{kind: unlimited}` or
`{kind: finite, maxUsd >= 0}`. CLI `--max-usd N` is syntax sugar for the finite
form, including `--max-usd 0`; zero and null never mean unlimited. The default
comes from `budget.paid_budget_per_run`. A single root ledger grants leases to
planner, candidates, synthesis, nested orchestrate runs, and review, and settles
observed spend even when work errors. Every route carries cost knowledge
(`exact | estimated | unknown`), billing knowledge, source, and provenance.
Subscription token valuation is telemetry, not a cash debit — estimated OR
exact, for candidates and each reviewer route. Mixed review panels settle
native reviewers to valuation and API-key reviewers to cash independently;
their aggregate is never blindly charged as cash. Candidate and reviewer
retries classify EACH usage event by that event/current typed credential
route; a native→API-key retry cannot hide later metered spend under the first
native route, and an undisclosed route remains cost-unverifiable. `finite(0)` admits
only proven-zero or subscription-entitlement work; a positive finite cap permits
at most one unknown-cost paid unit in flight. A later exact charge above the cap
is retained and ends `exhausted_overshoot`; permanently unknown cost ends
`cost_unverifiable` rather than fabricating `$0`. Parallel race waves reserve a
per-candidate estimate floor (`budget.estimate_usd_floor`, default $0.05) after
the first slot, so concurrent estimated work counts against headroom before
usage streams.

Quota is typed and vendor-owned, never scraped from prose. Codex rollout
`token_count.rate_limits` preserves every reported window as an independent
constraint with usage, duration, reset, provenance, and freshness. The global
journal is authority; an elapsed reset marks a snapshot stale and requests a
refresh, never locally invents zero usage. Unknown usage remains `null`.
`auto` ranks by the binding `min(elapsed_fraction - used_ratio)` pacing slack,
`quality` uses only exact user-declared `{harness,model,effort}` tiers, and
`economy` minimizes known incremental cash spend with quality tiers only as a
tie-breaker. Credential transport alone never proves a route free. Typed rate
limits create cooldowns; unknown quota remains eligible and is never rendered
as full headroom.

Structured output: routes whose manifest declares `json_schema_output`
receive `HarnessRunSpec.output_schema` — today the orchestrate PLANNER passes
the OrchestratePlan JSON Schema computed from the live Zod shape, strictified
for vendor strict modes (every object: `required` = all keys,
`additionalProperties: false`; inline root — both live-verified: codex
`--output-schema <FILE>` written into the scoped CODEX_HOME, claude
`--json-schema <inline JSON>`). The two CLIs SATISFY the schema differently
(live-observed): codex constrains its FINAL MESSAGE to bare JSON
(structured-first parse path); claude materializes the schema as a
StructuredOutput TOOL — the constrained JSON rides the tool call while the
final message stays markdown, so the fenced-JSON path carries claude (and
every non-capable route). Structured output is also gated OFF when the spec
will ride the interactive stream-json transport — that vendor combination
is unverified; fenced parsing carries interactive runs. Live plan checklists ride typed
`HarnessEvent.plan_progress` (codex `todo_list` items; claude
TaskCreate/TaskUpdate accumulation — TodoWrite kept for older CLIs), forwarded
as last-wins `plan.progress` run events and projected on the run detail as
`planProgress`; per-candidate evidence cards are projected on the run
detail as `candidates` from attempt/review/decision artifacts.

Repository release review is cumulative and SHA-bound. Under the owner-review
protocol (INV-125, CHECKLISTS), at least two independent reviewer subagents
inspect the exact clean committed candidate against the checklists and docs in
at most three rounds; any tracked mutation invalidates every result and starts
a new freeze, and the signed schemaVersion-3 attestation binds the candidate
SHA/tree, gate receipt digest, and reviewer report digests + verdicts. (The
retired six-slot triad/scope panel's schemaVersion-2 attestations stay
verifiable for already-sealed releases.) The old per-commit staged-diff hook,
bypass log, and installer are removed so they cannot compete with or be
mistaken for release authority. Product command `claudexor review --diff
<file>` remains a normal engine capability; it is not this repository's
release attestation.

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

Canonical project output lives under
`~/.claudexor/v2/projects/<project-sha256>/runs/<run_id>/`; no-project Ask uses
`~/.claudexor/v2/runs/<run_id>/`:

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
extracted from the fenced JSON block in the orchestrator's report and validated
against the tool belt. A missing or invalid block writes
`final/orchestration_parse_error.md` and is disclosed in the summary.
Executed plans also persist required/optional, actual terminal source, and
evidence references per step. The parent reducer applies one fixed precedence
and reports success only when every required step succeeded; skipped optional
steps do not become a generic partial terminal. Delivery receipts, rather than
requested autonomy, determine the report WorkProduct's `read_only` value.

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
  consumes: threads and turns (`/v2/threads`, `/v2/threads/:id`, `/v2/threads/:id/turns`,
  `/v2/threads/:id/apply`), runs and events (`/v2/runs`, `/v2/runs/:id`,
  `/v2/runs/:id/events`, `/v2/global/events`), run-internal artifacts (`/v2/runs/:id/artifacts`)
  and produced project outputs (`/v2/runs/:id/produced` — the Canvas source),
  delivery, decisions, and control (`/v2/runs/:id/apply/check`, `/v2/runs/:id/apply`,
  `/v2/runs/:id/decision`, `/v2/runs/:id/control`,
  `/v2/runs/:id/interactions/:id/answer`), harness status (`/v2/harnesses`,
  `/v2/harnesses/:id/models`), setup jobs (`/v2/setup/jobs`), settings and secrets
  (`/v2/settings`, `/v2/secrets`), and journal recovery
  (`/v2/recovery/partitions/:id` and validate/export/quarantine actions). The
  plan lifecycle rides the normal thread/turn endpoints — a `plan` run surfaces
  typed open questions, and an Implement turn carries `planRunId`; there is no
  separate spec surface or `ModeKind`.
- The app must not invent server state: delivery, decisions, review verdicts,
  routing readiness, setup progress, and budget truth are projections of
  control-api DTOs and run artifacts, never app-local logic. Read-only modes
  expose no patch/apply controls.
- Attachments use a daemon-owned resource pipeline. `/v2/uploads` streams bytes
  to an external temporary file; finalize fsyncs, hashes, deduplicates the blob,
  atomically publishes it, and returns an immutable resource ID. `/v2/runs` and
  thread turns accept only resource IDs. Each adapter declares exact MIME classes,
  finite byte/count limits and a native transport in
  `capability_profile.attachment_inputs`; every explicitly selected lane must
  support every mandatory attachment. The daemon revalidates finalized bytes at
  enqueue and adapters recheck the digest immediately before vendor serialization.
- The agent-driven browser is an engine capability the app merely arms: the
  adapter injects the exact lockfile-pinned Microsoft Playwright MCP (codex via stateless
  `-c mcp_servers.browser.*` overrides, claude via `--mcp-config` inline JSON —
  the agent gets the Playwright navigate / screenshot / snapshot browser
  tools) only when the run opted in, the harness declares
  `browser_tool`, web policy is not `off`, and the run has **full access**
  (codex's workspace-write sandbox cancels the navigation — live-verified).
  `RequestRequirementsResolver` records `{eligible, requested, effective,
  reason, evidenceRefs}` for every selected lane. A mixed pool keeps an
  incapable lane participating without Browser (`effective=false`); zero
  effective Browser lanes produce a typed preflight refusal before a harness
  starts. The same receipts project through telemetry, Control API, CLI, and
  the macOS run inspector, so a missing Browser is never a silent null.
  The runtime is deployed inside the DMG/ZIP and its offline entrypoint is
  build-smoked; no `npx`, runtime package download, or provider credential is
  available to the browser child. The injection is disclosed, the browser runs
  HEADED, and navigation snapshots land in the run artifact tree. Cursor/OpenCode/raw-api report
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

## Design constraints

Deliberate engine-level boundaries. Each is a designed limit (not a defect):
code touching one of these areas must honor it or change it explicitly here.

- orchestrate's `answer_question` tool stays out of the default tool belt
  (safe sub-runs are non-interactive); it executes only where a live
  interaction registry is injected (daemon-tracked runs) and otherwise SKIPs
  honestly.
- Spec-interview grounding runs execute in-process in the daemon (synchronous
  request/response); they persist a normal run dir but are not daemon jobs —
  they do not appear in `GET /v2/runs` and cannot be cancelled via the run
  control endpoint.
- `--json` mode guarantees exactly one JSON object on stdout for run/ops
  verbs; interactive TTY question prompts (follow/agent Q&A) remain human-text
  affordances by design.
- `--json-stream` is the separate NDJSON machine surface on canonical run
  verbs: an early `run.started` frame (runId/runDir/jobId), one JSON line per
  run event (internally the shared follow pipeline in json mode), and the same
  terminal object `--json` prints as the LAST line. It never changes the
  `--json` exactly-one-object contract, and the retired `run` verb stays
  retired.
- Vendor-owned quota snapshots and typed rate-limit cooldowns persist in the
  checksummed global journal through `QuotaRegistry`; routing reads that
  cross-run authority rather than rediscovering pressure independently in each
  run. Codex uses its app-server. Claude subscription windows arrive from the
  `oauth/usage` endpoint as the PRIMARY source (since 2.1): the daemon's
  refresher reads each logged-in config dir's OAuth token transiently — the
  default native dir (subject null) plus every claude `config_dir_login`
  profile (subject = its profile id) — and a failing endpoint yields NO
  snapshot, never degraded auth. The user-scoped status-line payload
  (installed explicitly by the Claude host-plugin lifecycle) remains a
  SECONDARY source for the default subject only; its collector stores only
  allowlisted windows in the external v2 root and composes/restores any
  existing display command. Per-run budget observations remain run evidence,
  not quota authority.
- The `verify` intent is reserved: the shipped FinalVerifier is
  deterministic-only (fresh-tree apply + gates, no model), so no engine path
  requests verify-intent routing; the value stays for a future model-backed
  verifier.
- The staged-field gate is a token-level reference check, not data-flow
  analysis: any identifier occurrence in non-schema TS — including an
  adapter's own capability declaration — counts as a consumer.
- Arbitration's acceptance-coverage axis is inert: acceptance criteria were a
  spec-only producer (retired with the spec machinery), so every candidate now
  reports `acceptanceTotal: 0`. Convergence is driven by deterministic gates and
  cross-family review, not per-criterion acceptance evidence.
- Run-artifact writes are non-atomic by design: the engine is the single
  writer of a run directory; external writers into the external runtime
  namespace are unsupported.
- The plan lifecycle parses the planner's instructed `## Open Questions` block
  by delimiters (never as governance); output deviating from the instructed
  format degrades to free-text questions (or an `unverified` readiness when no
  block parses) instead of failing the plan run.
- Startup crash GC sweeps orphaned envelopes only under project roots recorded
  in the daemon command journal; envelopes created by CLI/MCP/ACP runs
  in roots the daemon never saw are reclaimed only by their own process.
- Under `--web auto`, "the harness attempted web" is the intent signal; a
  separate did-this-task-NEED-web resolver does not exist yet, so web-required
  enforcement applies only to explicit `cached`/`live` policies (the WHITEPAPER
  documents the rationale).
- READ-ONLY flows on non-git folders get a best-effort copied baseline for
  diffing (write modes auto-initialize git per INV-075); if the
  baseline copy or the `diff` tool fails, the run's diff is empty and
  reviewers read the live tree (diff output capped at 200 kB with an in-band
  truncation marker).
- Isolated-thread worktrees are pinned by persistent `claudexor/thread-*`
  branches. Journal SHA is a checked cache; successful apply advances the
  branch, and explicit trash/restore/purge owns its retention lifecycle.
- Explicit reviewer panels accept only doctor-OK routes: a degraded route (key
  present but unproven by isolated smoke) is refused even when the user names
  it — reviewer verdicts must ride proven routes, unlike candidates where
  explicit selection admits degraded.
- A credential profile cannot bootstrap a raw-API instance whose own key is
  absent: raw-API discovery is key-gated (an instance without its configured
  key is not a route, so no manifest exists for the profile probe to
  override). CLI harnesses (claude/codex/cursor/opencode) discover
  credential-neutrally, so their profile probes CAN admit a route past a
  logged-out default store; for raw-API, set the instance key (env or its
  managed slot) and use the profile for per-run key selection within the
  instance fence.
- Structured-output runs (`--output-schema`) route through a non-interactive
  lane (DT2.1-16): the daemon always arms an interaction channel, and the
  interactive-capable claude lane's `--json-schema` × stream-json combination
  is not live-verified — the refusal message names that reality instead of
  silently dropping the schema.
- Profile rotation never crosses credential kinds: a subscription→API-key
  swap mid-attempt would silently change the payment model, and the attempt's
  first-wins auth-route receipt would misvalue metered usage as subscription
  entitlement against a finite cash cap. `nextEligibleProfile` skips
  cross-kind candidates; rotate between accounts of the SAME transport only.
- `claudexor profiles login` deliberately spawns the vendor's own login
  command IN the operator's terminal (no daemon setup job): vendor OAuth
  needs the user's TTY/browser interactively, the mutated state is the
  VENDOR's own scoped config dir (never Claudexor-owned state, so there is
  no Claudexor receipt to journal), and the post-exit doctor probe against
  the profile dir is the verification truth (exit code non-zero unless the
  probe passes). The daemon-owned setup jobs remain the path for
  non-interactive/GUI-driven logins.
