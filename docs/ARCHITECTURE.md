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
`synthesize`, `audit`).

```text
surface -> schema/control DTO -> orchestrator/core -> gateway -> harness adapter -> native tool/API
        <- typed events/artifacts/reviews/budget/WorkProduct <-
```

Surfaces stay thin. Business logic belongs in core/orchestrator/control-plane
packages, never in macOS or CLI-specific state.

## 2. Canonical Modes

`ModeKind` lives in `packages/schema` and is the single source of truth. The
v3.0.0 collapse (BREAKING) reduced the surface to THREE conversation intents;
engine strategies are flags on a mode, never modes:

- `ask` - one selected read-only `explain` route; writes `final/answer.md`.
  `--deep-scan` widens it into the bounded multi-scout research sweep that used
  to be `audit --swarm` / `explore` (`intent: audit`), writing
  `final/report.md`, `final/explore-findings.yaml`, and `final/omissions.md`
  (see §6 for the synthesis reducer that produces `final/report.md`).
- `plan` - one read-only planner by default; `--council` enables the explicit
  multi-harness draft-and-merge strategy. Both write one `final/plan.md`.
- `agent` - default `claudexor agent`; one primary-biased envelope route. Flags
  select the strategy on the SAME mode: `--n N` (best-of-N race with isolated
  candidate envelopes, review, synthesis, arbitration), `--attempts N`
  (convergence loop with an explicit cap), `--until-clean` (convergence loop
  with no fixed cap; stops on clean review/gates, budget/quota exhaustion,
  cancellation, or no-progress stall), `--create` (create-from-scratch intent),
  `--delegate` (the delegation belt — see below).

### Delegation belt (`agent --delegate`, D32)

`--delegate` (agent-only) injects a SCOPED Claudexor MCP belt into the harness
sandbox — the generalized `HarnessRunSpec.extra_mcp_servers` seam translated per
adapter (claude `--mcp-config` inline JSON, codex `-c mcp_servers.<name>.*`).
The running daemon entry must itself dispatch `mcp serve-belt`; every in-repo
launcher preserves that executable-entry contract.
The harness decides when to spawn bounded, isolated sub-runs; the belt exposes
ONLY `claudexor_ask`, `claudexor_plan`, `claudexor_run` (isolated envelope
sub-run — forced envelope, forced no-thread), `claudexor_best_of`,
`claudexor_run_status`, `claudexor_run_result`. There is NO
apply/decision/thread/settings tool: the PARENT integrates results in its own
workspace. Policy is enforced SERVER-SIDE at the tool boundary (never trusting
the harness): nesting depth is 1 (the sub-runs a belt spawns carry no belt of
their own, so nesting cannot exceed 1 — the belt also refuses when observed at
depth>0), a max sub-run count per parent (default 8), and one live parent-owned
paid-budget authority shared by the parent and every child. Reservations and
settlements are global to that authority, while each child reports its own spend
and the parent reports the aggregate; exhaustion is a typed refusal, never a
silent independent or unlimited budget. `--delegate` is permission rather than
a promise that a child will run, so the parent keeps ordinary first-slot cost
evidence. Once server-owned `delegatedFromRunId` proves that a real child
overlaps the live parent, every child-side reservation uses the configured
estimate floor; settlement remains authoritative and insufficient shared
headroom still refuses the child with a typed budget cause. The daemon keeps that family authority
for the run lifetime: child admission is atomic and monotonic (pending starts
count toward the max of 8), parent cancellation closes admission before it
cascades, and the parent's terminal record waits for child drain. A bounded
broken-runner fail-safe financially fences a survivor and records a typed
failure; it never permits late child cash to appear after a successful parent
terminal. After the drain, the ledger rechecks the family terminal state and
reconciles the returned result plus `decision.yaml`; a late overshoot or
unverifiable child settlement replaces the prepared success with a typed budget
failure. Only adapters
whose `capability_profile.mcp_injection` is true (claude, codex) can host the
belt. `HarnessStatusDto` and the agent capability catalog carry one derived
`delegation` projection (`available`, typed `reason`, remediation, and the access
requirement), so CLI, Control API, and macOS consume the same readiness truth.
The flag is permission, not a child-count promise: current top-level summaries
record `delegation {requested,effective,used,reason,remediation}`; the field is
nullable when reading legacy artifacts that predate this receipt. A known pre-injection
runtime, manifest, or access incompatibility may continue as an ordinary Agent
run with `effective:false` and a durable warning. An MCP startup failure AFTER
the descriptor was injected is terminal and never silently degrades. An
unrecovered non-ok result from an exact injected belt tool likewise hard-fails
the Agent outcome; the Delegate receipt still says `used:true` because it records
which path ran, not whether that operation succeeded. An isolated-envelope
deliverable remains diagnostic and cannot be auto-adopted. If an explicitly
in-place lane already changed the live tree, the failure first emits a durable
`adopted:true`, `applied_review_blocked` WorkProduct with pre/post snapshots and
a revert anchor, then emits the failed terminal; this records unavoidable live
bytes honestly without treating them as reviewed success. A secret-bearing
in-place diff takes the INV-062 exception before any candidate artifact or Git
post-snapshot: the engine attempts an exact checked reverse apply from the
  transient diff after scanning immutable binary preimages/postimages and textual
  patch bytes. Non-Git binary stubs are scanned from a bounded no-follow live
  descriptor and fail closed. Git-backed in-place output remains `applied_review_blocked` plus
manual cleanup even after a successful worktree rollback because vendor-written
index/ref/object state cannot be disproved post hoc; the engine never persists
the patch or anchor and never claims false revertability. In a mixed
pool, a capable lane keeps the run `effective:true`, while any selected lane
that continued before injection makes the run reason `partially_degraded` and
keeps the prominent warning; per-lane requirement receipts preserve its cause.

Every belt child is scoped to the normalized original user-project root bound
by the engine. It never inherits the parent harness's isolated envelope as its
project, and a raw tool `repoPath` cannot redirect that server-owned boundary.
The descriptor starts with an empty fail-closed placeholder and the orchestrator
rebinds the exact root before injection. Every child also receives the real top-level `parentRunId` plus
`delegatedFromRunId`; only the latter establishes Delegate provenance. Parent
cancellation cascades to those children, and retry/run-again creates a fresh
top-level family rather than inheriting Delegate lineage or admission state.
Native Claude Code/Codex subagents do
not receive `delegatedFromRunId`, are not Claudexor children, and cannot satisfy
`used:true`. This replaces the former `orchestrate` mode (retired in v3);
ordinary `claudexor plan` covers the "suggest"-style use-case.

Old mode ids (`audit`, `orchestrate`, `best_of_n`, `max_attempts`,
`until_clean`, `explore`, `create`, `readonly_audit`, plus the older
`daily`/`until_convergence`/`readonly_swarm`) are NOT aliases: they hard-error
at every wire boundary.

## 3. Package Map

- `packages/schema`: Zod schemas, TypeScript types, generated JSON Schema,
  control DTOs, mode ids, config shapes, `RunTelemetry`, and the validated
  terminal `RunFacts` receipt.
- `packages/util`: shared helpers (ids, time, hashing, redaction, config dirs,
  safe file IO).
- `packages/core`: adapter interface, shared CLI run loop, process helpers,
  doctor runner, typed errors. Default write modes are orchestrator/envelope
  paths, not direct live-tree execution.
- `packages/orchestrator`: the canonical mode pipelines (ask, plan, agent) with
  separate schema-owned strategy controls; owns run telemetry and policy gates
  (trust, risk, protected paths),
  typed transient retry policy, no-progress outcomes, and the one terminal
  `RunFacts` projection from canonical run artifacts.
- `packages/gateway`: harness discovery and capability/intent gating (route
  selection itself lives in the budget router and orchestrator routing).
- `packages/harness-codex|claude|cursor|opencode|agy|raw-api|fake`: adapters that
  translate native CLI/API streams into typed `HarnessEvent`s. The `fake-*` kinds
  are deterministic offline test fixtures (incl. `fake-implement`, which writes a
  real worktree file); they are explicit-`--harness` only and never enter
  auto/reviewer pools.
- `packages/workspace`: disposable candidates use private shared-clone Git
  authority while persistent threads materialize git worktrees on their first
  mutating turn (read-only turns reuse one if present); scoped harness homes/
  config dirs for write envelopes and read-only routes via `readOnlyHomeEnv` keep
  relocatable, route-local state outside both the worktree and the operator's
  home. An in-place run normally keeps the native environment so its vendor
  session stays resumable; a run marked `execution.delegated` (started by an
  external orchestrator that owns the workspace) is scoped even in place, and
  refuses rather than starting a harness in the operator's home.
  A selected native Codex route uses its Claudexor-owned file-only profile;
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
  The fsync-before-ACK discipline is kernel-proven on POSIX only: win32
  directory-entry flushes are tolerated to fail (`fsyncDirectory`), so a Windows
  crash can resurrect a completed append's intent file and recovery will then
  discard that acknowledged frame (disclosed, loud in the journal record).
- `packages/daemon`: durable local queue (Unix socket on POSIX, named pipe on win32) and journal projections for commands, projects, and threads.
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
  all three run modes enqueue through the daemon `/v2` control API. Until MCP
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

### External-orchestrator workspaces and native access

`execution.delegated` marks a run whose external caller owns the mutable
workspace; it is independent of the `agent --delegate` belt. For a
project-scoped delegated Agent with `execution.isolation: live`, `scope.root`
is the stable project identity used for registration, configuration, trust,
TaskContract, artifacts, and history. `execution.workspaceRoot` is the
one-shot absolute existing directory used as the `executionRoot` field on
`RunInput`, so the
harness cwd and native Git operations happen only there. Every new mutating
delegated-live request must supply it and never falls back to `scope.root`.
Read-only requests may omit it. Exact Retry revalidates a frozen new-shape
workspace; the bounded legacy no-field replay retains its historical
`scope.root` execution semantics.

The active access profiles are `readonly`, `workspace_write`, `full`, and
`inherit_native`. Each adapter translates that request to its own native
permission mode; the generic run loop invokes the adapter command directly.
Claudexor adds no outer Seatbelt or other OS filesystem boundary. A scoped
`HOME` or named vendor profile selects credentials and keeps vendor-written
state separate, but it is not containment and does not prevent same-user host
access. New delegated attempt and candidate evidence records this deliberate
absence with null mechanism/proof fields. Historical proven Seatbelt evidence
and the retired `external_sandbox_full` literal remain decoder-only so old
runs stay inspectable.

An exact idempotency replay is resolved before current access or filesystem
admission: if the daemon already accepted the historical command, the same
handle is returned. Only an absent replay may refuse retired
`external_sandbox_full` with `retired_access_profile`. Run Again removes that
value and requires an explicit active replacement; a historical sticky thread
likewise requires an active PATCH or turn override. Browser and Delegate use
the selected adapter's existing native MCP-injection access requirement:
Claude can host Browser or the belt under `workspace_write`, while Codex needs
explicit trusted `full`; no access rewrite hides that difference.

## 4. Routing

Routing is `Pool + Primary + Routing Goal`:

- selected harness ids are the eligible pool;
- `primaryHarness` is a bias/ordering hint, not a privileged semantic role;
- one explicitly selected harness becomes the effective primary when no explicit
  primary is supplied; an explicit primary must belong to the selected pool;
- `routingGoal` is recorded as `TaskContract.budget.routing_goal`, default
  `auto`; the other goals are `quality` and `economy`. The v1 portfolio ids
  have no aliases and fail at every boundary.

The single-route read-only mode (`ask`) chooses one route from the eligible
pool, primary first. `Agent` is a one-candidate envelope run. `ask --deep-scan`
(the old `audit --swarm` / `explore`) expands a bounded read-only pool (default
width 4, capped at 8). Best-of-N expands the eligible pool over N candidates. Convergence rotates compatible
harnesses when a stall signature persists.

Route resolution is honest about membership. An EXPLICITLY selected lane that
becomes ineligible (unavailable, no manifest, wrong access profile, incompatible
web policy, unsupported attachment, or unable to perform the intent) is a loud
typed refusal at preflight that names the lane and the gap — never a silent
substitution. An AUTO pool may drop such a lane, but the resolver NEVER refills a
dropped lane's slot by duplicating a surviving harness (the self-race class that
faked Best-of diversity): effective width clamps to distinct survivors and the
omission is disclosed once via a `route.pool.degraded` event carrying the
requested-vs-effective harnesses/width and every dropped lane's typed stage. A
pool smaller than `N` with NO drops is still a legitimate best-of-N on the
available harness(es); deep-scan likewise repeats a surviving harness for scout
coverage, since its width is distinct slices, not distinct harnesses.

A thread carries sticky routing so the chat surface stays a thin gateway: a
`Thread` persists `primary_harness` (which harness answers in chat) and
`eligible_harnesses` (the pool Best-of runs — one candidate per harness, so its N is
the pool size). A turn inherits both unless its request overrides them
(`POST /v2/threads/:id/turns` accepts `primaryHarness` / `harnesses`); precedence is
**turn body > thread sticky > engine default** (config `routing.primary_harness`,
auto-pool of doctor-ok harnesses). All ordering/validation stays in the engine —
`primaryHarness` is only pinned first, and an EXPLICITLY-selected primary outside
the selected pool fails loudly (the engine rejects it). A single-item explicit
pool infers itself as the primary (no duplicate `--primary-harness` needed); a
MULTI-harness pool whose CONFIGURED default primary is absent, with no primary
pinned, is a structured ambiguity refusal that names the pool, the missing
primary, and the exact `--primary-harness` flag to add (GH #25) — never a silent
reroute. An INHERITED sticky
primary that no longer fits the pool is instead dropped by the thin gateway
before the turn is enqueued (so a stale bias never forces routing). Surfaces just
set the sticky values (`POST /v2/threads`, `PATCH /v2/threads/:id`) and send DTOs; they
never route.

Harness availability is determined by discovery + doctor + capabilities:
`available` alone is not enough. A harness must be `ok`, expose the required
intent for the selected mode (`explain` for Ask, `audit` for Ask's `--deep-scan`
sweep,
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
adapter: `effort_levels` + `model_effort_levels` (+ the
`effort_levels_verified_against` freshness note) and `known_models` (+ the
`known_models_verified_against` freshness note) as the manifest model truth
source under the STRICT semantics described in the model-governance section
above — there is no warn-and-pass-through tier.

Reasoning effort is an OPEN vocabulary, mirroring the vendors: codex types its
own `ReasoningEffort` as any non-empty value the model advertises, and Claude
Code's ladder belongs to the INSTALLED binary (2.1.89 stops at `max`; 2.1.165
adds `xhigh`). So `EffortHint` is a bounded lowercase slug rather than an
enum, and the ORDERING AUTHORITY is the vendor's own advertised sequence —
there is no static rank table. Vendors return their levels already ordered
weakest→strongest (codex `app-server` `model/list` →
`supportedReasoningEfforts` per model; the `--effort` line of `claude --help`),
so a model's ladder is its own ordered list, a harness's ladder is the
positional merge of its models' lists (`mergeEffortLadders`; the Swift
`EffortLadder` merges the manifest's already-ordered arrays the same way), and
a level's rank is its position in that merged order — which is what lets a
brand-new vendor level sort correctly with no code change. Should two models
ever advertise genuinely contradictory orders, the merge flags it and
cross-model clamping is refused rather than an order invented. Adapters
discover what is really advertised at discovery time and fall back to a
recorded snapshot (stamped vendor data, kept in its captured order) when a
probe cannot answer, so a probe failure costs freshness, never the run; both
probes are cached, and `scripts/model-hints-freshness.mjs` WARNS when the live
ladders disagree with the snapshot. Effort ceilings are per MODEL, not per
harness (gpt-5.6-sol takes `ultra`, gpt-5.4 stops at `xhigh`), so
`effortLevelsForModel` narrows the harness-wide merged ladder for the routed
model. The shared normalizer then passes an ADVERTISED level through verbatim,
clamps an unadvertised one onto the nearest advertised level INSIDE the merged
vendor order, and refuses a level that order has never seen, disclosed via
`ignored_settings` rather than silently downgraded. WHICH LAYER clamps is part
of the contract: `discover()` probes the DEFAULT native harness home, so the
manifest carries the default account's ladders, while codex advertises per
ACCOUNT and every credential profile and API-key route runs under its own
`CODEX_HOME`. Run preflight (`governRouteEffort`) therefore only DISCLOSES a
level the harness's merged ladder does not know and forwards everything else
verbatim; the adapter, which has resolved the profile env the child will
actually run in, is the single layer that clamps. Reviewer efforts have no
adapter-side disclosure channel, so the panel resolvers refuse a level the
SELECTED reviewer does not advertise — against the named model's own ladder
when the entry resolves one, else the harness-wide merged ladder — instead of
forwarding it to be dropped. The CLI help, the MCP tool
schema and the macOS picker's ordering all derive from that single source. `doctor` validates each
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
opencode today) and is incompatible only with strict `off`, while `none` means
no web at all and is compatible with every policy. Ordinary run construction
stores `web_required=false`: `auto`, `cached`, and `live` are optional
preferences, so a route may use web, lack it, or have a native approval deny it
without becoming ineligible or failing the run. Only `off + uncontrolled` is
excluded from the pool; explicit selection fails before the harness starts and
tells the caller to enable web or choose an off-enforceable harness. Per-route
upgrades (Claude has no cached web index, so `cached` runs as `live`) are
disclosed via `policy.web.upgraded` events and recorded in telemetry. Adapters
map the policy to native controls: Claude Code gets explicit
`WebSearch`/`WebFetch` allow/deny arguments, Codex gets `web_search` config, and
managed Cursor readonly uses Ask + `--force` + sandbox enabled for non-off
policies while `off` and `inherit_native` receive no injected force.
Command/network sandboxing remains separate.

`access=full` (unsandboxed) additionally requires `allow_full_access: true` in
the USER-LEVEL trust config (`~/.claudexor/v3/trust/<repo-hash>.yaml`); versioned
repo config can never self-grant it, and the violation is a loud routing error
naming the resolved trust path, not a silent downgrade. `claudexor trust` is
the writer for that file (`--allow-full-access`, `--revoke-full-access`,
`--access-default readonly|workspace_write`). Per-harness engine defaults
(`harnesses.<id>.enabled/default_model/effort/web/max_turns/max_rounds/
tools_allow/tools_deny/fallback_model` in the global config) gate pool
membership and seed per-route run specs; knobs a manifest does not support are
disclosed as `ignored_settings` on `harness.started`, never silently dropped —
the Control timeline projection carries the list (the `ignoredSettings` field on
`ControlTimelineEvent`) and lifts the row to `warning`, and human CLI `follow`
appends a warning suffix, so an ignored cost/safety bound is never an invisible
benign start.

Model choice is harness-scoped end to end. A run carries a per-harness
`models` map (harness id → model id); the scalar `model` convenience expands
to the RESOLVED PRIMARY only and is rejected when no primary is resolvable —
it never fans out to a pool. At initial normalization the engine FREEZES each
known lane's config-derived `default_model` and `effort` into the resolved
route exactly like an explicit input, so the TaskContract records them
(`routing_models` + `routing_efforts`) instead of leaving `{}` that a later
retry would re-resolve against changed settings. Exact Retry replays those
frozen values, so a run made on a settings default stays reproducible after
the default changes (QA-035); the resolved map is what route-spec building
reads; per-attempt overrides
(budget downgrade to `fallback_model`, fallback retry) sit on top. Every
explicit model — per-run, settings default, fallback, reviewer — must pass
the harness's model truth source (live `models()` inventory, else manifest
`known_models`; a harness with neither refuses explicit models): enforced at
settings write (400), run preflight (typed failure with artifacts before any
CLI spawns), immediately before each routed spawn against that attempt's exact
profile, state, cwd, and auth preference, and both reviewer-panel paths. A pinned
profile answers its OWN inventory through the same route resolver the run path
uses, so preflight and spawn always name one account. A profile-less automatic
route is enumerated with the same `auto` the adapter will resolve and the spec
reaches the adapter unrewritten: the gate reads the run's identity, it never
decides it, and an undecidable route is the vendor's refusal to make, not the
gate's.
Thread ask/plan readiness and inventory use the same durable lane HOME as the
eventual spawn, while non-thread read-only runs retain disposable state.
`/harnesses/:id/models` reports
the truth source honestly (`source: api|manifest|none`, with the manifest's
`verifiedAgainst` CLI-version freshness note), and the model-hints-freshness
gate warns when the installed vendor CLI drifts from the verified version.
Candidate diffs additionally pass a typed policy gate: protected-path changes
and critical-risk diffs escalate as `NEEDS_HUMAN` findings. An accepted
escalation blocks the run only when it belongs to the WINNING candidate
(winner-only): a losing candidate's findings stay disclosed as run evidence
without vetoing a clean winner, and a winner with no review evidence record at
all fails closed into the same needs-decision block instead of proceeding as
clean. Explicit per-run `protected_path_approvals` can narrow only the
auto-protected gate/test path portion of that policy. Plans and repo config
cannot carry approvals; operator approval is always supplied on the current
run.

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

Browser-produced media is written below one envelope-owned child,
`.claudexor-artifacts/<envelope-id>/`, never into a shared Claudexor-owned
project namespace. A persisted ownership marker outside the project binds the
exact child used by Browser output, candidate-media collection, diff exclusion,
secret scanning, and cleanup. A pre-existing `.claudexor-artifacts` root and
every sibling remain ordinary project/user state: they are captured when
changed and are never recursively removed by run disposal. The envelope owner
record also persists the original envelope id and whether the workspace is
in-place, so crash/startup disposal reconstructs the same marker identity and
removes the same child before deleting recovery evidence. An artifact marker
without valid recovery identity refuses cleanup rather than orphaning the child
by deleting its only proof.

`auto`, `cached`, and `live` permit web tools where the harness supports them
and record whether web was attempted and at what verification strength. For
ordinary contracts, web is optional: unused, denied, unavailable, or errored
activity remains warning/evidence telemetry and neither decides terminal
success nor starts route fallback. Only an explicitly persisted
`web_required=true` compatibility contract can become `web-unsatisfied` and
use the existing read-only fallback path.

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
Claude's native `auth status` probe keeps that distinction under transient
child-process or Keychain transport failure: concurrent reads of one exact
`(binary, config-dir)` store share one bounded probe, a retry stays inside the
original ten-second budget, and a positive result may be reused only as a
typed, process-local stale observation for at most one minute. Claudexor-handled
logout, login, profile, or secret mutations clear that observation (including
an in-flight probe); an external vendor login/logout may remain visible for the
bounded grace window. Stale evidence is never reported as a fresh passed login
and does not alter profile selection or paid-route policy: an already explicit
pin or durable thread binding may keep its exact config-dir route alive for
this bounded grace, while unpinned pool/rotation selection remains fresh-only.
This absorbs a probe failure only; it does not claim to serialize the vendor's
OAuth refresh or to repair a revoked credential.
Adapters declare the physical credential transport they support (`config_file`,
`env_var`, `oauth_token_env`, `os_keychain`, `http_header`, or `none`) plus the
containment strategy that keeps it honest. A transport may be platform-scoped;
the same auth declaration also carries the effective profile policy (identity
scope, relocation owner, enabled-row cardinality, and cleanup owner) and the
managed-login stdin class. Current capability producers project that declaration
through vendor-binary readiness and the host terminal resolver as
`setupLogin: null | {mode: in_app | external_terminal}` on both harness status
and the agent capability catalog. An in-app terminal login is advertised only
after the exact helper/backend probe succeeds. Native-session state remains owned by
the vendor: Codex reads a Claudexor-dedicated `CODEX_HOME` with
`cli_auth_credentials_store="file"`, never the operator's ordinary Codex profile
or OS Keychain; Claude reads a Claudexor-owned config dir and its disposable
child HOME bridges only the macOS login Keychain; Cursor declares a single
`config_file` native route — the vendor's own file credential store scoped to
an account row's Claudexor-owned HOME. The host Cursor OS-Keychain login is a
retired transport (INV-135 unified accounts): it is never probed, bridged, or
claimed as a route, and a cursor native session is probed only in an env that
explicitly selects the vendor file store. Claude exposes only its narrow
host Keychain context; Codex keeps its separate vendor credential file outside
every envelope. Antigravity uses the named HOME on every profile. On Darwin
the adapter prepares a private profile-local
`Library/Keychains/login.keychain-db` before the vendor child; an unsafe
profile path refuses the child before it can trigger SecurityAgent, while an
operational setup miss leaves the vendor's config-file fallback available.
The implementation creates the DB first under a neutral bootstrap filename
and adopts the canonical name, avoiding Apple's user search-list side effect
for a direct `create-keychain .../login.keychain-db` call. It never bridges the
host Keychain or copies credential bytes.
Linux keeps the config-file/HOME route.
On Windows the credential is an OS-user-scoped vendor Keychain item: the named
HOME scopes mutable vendor state without claiming an independent Google
identity. No route copies a vendor
credential file into an envelope. Separate fallback routes may materialize only
their selected source: Codex API-key auth seeds a temporary scoped `auth.json`,
Claude injects either the stored setup token or `ANTHROPIC_API_KEY`, and Cursor
injects `CURSOR_API_KEY` (its isolated key smoke runs unbridged so it can never
silently authenticate with a host login).

Run params are validated before daemon enqueue. Inline `env`, `secrets`,
`api_key`, `token`, `password`, or similar fields are rejected, so daemon
run requests never turn the command journal into a secret store. Secret-setting
endpoints bypass command persistence and write only to the secret store.

Scoped harness homes/config dirs live outside worktree `tree/`, so `git add -A`
cannot capture auth files, sqlite logs, plugin downloads, or transcripts into
`patch.diff`.

Every harness child — across all lane classes (read-only scoped home, isolated
envelope, in-place) — spawns with a normalized PATH from one producer: the
directory of the Node the daemon itself runs on (the notarized app-bundled
runtime in production) is prepended ahead of the guessed managed/system entries,
and no inherited entry is ever dropped. This keeps a vendor tool's inner
`/bin/bash -lc` grandchild — which re-sources login profiles (`path_helper`,
`brew shellenv`) — from resolving an ad-hoc Homebrew Node that macOS's
code-signing monitor SIGKILLs (`Killed: 9`); the daemon proved its own Node
runnable by executing on it. The prepend is skipped when that Node is itself an
at-risk Homebrew build, so a killable runtime never poisons the shell, and
`claudexor doctor` still surfaces the non-gating at-risk-Node advisory.

### Credential profiles (INV-135, unified account model)

Every routable credential binding of a harness is a named registry row; the
effective platform policy says whether that row represents a profile-isolated
identity or an OS-user-scoped binding:
`credential_profiles` in the global config holds durable NON-SECRET entries
`{profile_id, harness_id, display_name, credential_kind, isolation_locator |
secret_ref, enabled}`. There is no separate "default"/"CLI login" account
type. `config_dir_login` rows point at a Claudexor-owned scoped vendor-state
root (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / the Cursor file-store HOME / the agy
HOME, canonical absolute path); the effective platform policy may keep the
physical credential at OS-user scope. The Claudexor-owned LEGACY native dirs
are legal locators —
the startup migration registers a detected claude/codex default-store login as
the ordinary `claude-default`/`codex-default` row without moving bytes; the
vendor's ordinary host stores (~/.claude, ~/.codex, the host Cursor Keychain)
stay outside the owned root and are never locators.
`oauth_token`/`api_key` rows point at a namespaced
secret-store name (`claude_oauth:work`, `anthropic:acc2`, …) — the namespace
is REQUIRED (the schema refuses a bare engine-default slot like `anthropic`,
which would silently alias the engine-default secret), and each adapter binds
the ref's base to its own provider slot so one provider's key is never sent to
another. Two rows can never share one `isolation_locator`; that prevents two
rows from sharing Claudexor-owned state, but does not claim that an external
OS-user credential is independently relocatable. Readiness is the doctor's separate `CredentialProfileStatus`
projection (`GET /v2/credential-profiles`, `claudexor profiles`), never
durable config; every adapter's profile probe enforces the SAME slot binding
as its run route, so a misconfigured profile reads `unavailable` instead of
being admitted and refused mid-run.

**CONCEPT-CHANGE(INV-067, INV-135):** a registry row is the uniform product
account object, but its isolation and cleanup semantics are the adapter's
effective platform policy. Windows Antigravity exposes one OS-user credential,
so at most one row may be enabled. Create and enable enforce that bound inside
the locked config mutation; disable always remains available. A legacy config
with multiple enabled rows still loads, but targeted routing, setup, quota, and
pool `next_up` return the typed `credential_profile_ambiguous` state without
probing or choosing a row. Disabled rows whose effective policy binds one
shared OS-user credential stay visible as `unavailable + not_run` and are never
vendor-probed, so one shared credential cannot paint several rows as distinct
live accounts. Disabled rows with profile-isolated credentials remain outside
routing but retain their live readiness probe, so Accounts can show whether a
stored login is still usable before it is re-enabled.

The startup migration is a crash-recoverable per-harness state machine
persisted at `<config>/migration/accounts-unified.json` — deliberately outside
`config.yaml`, so a downgraded engine's strict parser never sees it. Phases
`reserved → registry_written → continuity_migrated → completed` are each
restart-idempotent; an INCOMPLETE record refuses that harness's runs typed
while other harnesses keep working. Continuity migrates as one unit (INV-137):
thread sessions and lane checkpoints rewrite from the null engine-default
subject onto the row id, durable lane homes rename, and the legacy null quota
subject retires with no replay alias. `native_credentials_enabled=false` maps
to `row.enabled=false`, and the deprecated key is kept mirrored for the
downgrade window (the row is the authority; its Enabled PATCH updates the
mirror). The supported downgrade path is the engine's own rollback —
`POST /v2/accounts-migration/rollback` / `claudexor profiles
rollback-migration` — run BEFORE installing an older engine whose
canonicalizers refuse the native locator. `claudexor auth login <harness>` is
bootstrap sugar: it ensures the `<harness>-default` row (claude/codex on their
native dirs; cursor on an isolated file-store dir) and signs into it; a
cancelled or failed login keeps the cold row with its Sign-in affordance.

Every Cursor account rides the vendor's own FILE credential store: a
`config_dir_login` cursor row selects `AGENT_CLI_CREDENTIAL_STORE=file`
inside its Claudexor-owned profile HOME (`~/.claudexor/profiles/cursor-<id>`),
where the CLI's auth store is keyed by `HOME`/`USERPROFILE` (macOS),
`XDG_CONFIG_HOME` (Linux), and `APPDATA` (Windows) — all pinned to the profile
HOME for the login, the status probe, and every profiled run. Mutable
config/session state relocates separately: `CURSOR_CONFIG_DIR` and
`CURSOR_DATA_DIR` stay in the run's lane/envelope HOME so two rows never
share chat/session state. No token is ever
copied between stores, no env ever receives a host-Keychain bridge, and
`CURSOR_API_KEY` is scrubbed from profiled native
runs — the named identity is exactly its file store or a typed refusal.
The Accounts-only Cursor probe receipt also carries an optional email parsed
from the CLI's narrow typed status grammar. Projections reuse
the status invocation they already need; no credential file is read, no raw
status output is persisted, and no extra subprocess is launched for identity.

The orchestrator is the ONE resolve owner. There is no user-settable "Active"
account — enabling/disabling a row is the only routing control. The
per-harness EFFECTIVE account is resolved by the owner-locked order (INV-135):
(1) an explicit per-run/per-thread pin (`credentialProfileId`) is STRICT — an
unknown/disabled/harness-mismatched id is a typed refusal before spawn, a
fresh exhausted quota window refuses typed (`subscription_window_exhausted`
with its reset time), and a pin never silently rotates. (2) An unpinned
THREAD turn stays on its durable bound account — the daemon derives the
binding from the thread's own lane evidence (latest live session, else lane
checkpoint, per harness) and hands it to the run as `threadAccountBindings`;
a binding whose row became disabled/deleted/revoked/exhausted moves to a pool
sibling with a typed `route.account.lane_switch` disclosure, never silently.
(3) Otherwise the quota-aware POOL of enabled+ready subscription rows selects
the account (`route.account.pool_selected`): fresh model-applicable headroom
descending, unknown/stale quota after known-positive headroom but before
exhausted (stale quota never authorizes routing), deterministic profile-id
tie-break; a row under an observed live block (a reactive vendor-limit
cooldown or spent window — the A4 reader) ranks exhausted with its release
instant. An empty or exhausted pool is a TYPED TERMINAL
(`route.account.pool_exhausted`, then `credential_pool_exhausted` with the
pool's earliest known reset — owner Q3=A): an unpinned run under `auto` or
explicit `subscription` waits for a window instead of silently taking the
paid route. Only the EXPLICIT `api_key` preference opts the exhausted pool
onto the paid API-key route (billing classifies it `managed_api_key`; the
adapter's typed key refusal is the backstop) — the same principle as the
kind-aware `limit_action: auto`, which resolves a metered subject to `fail`:
`auto` never silently spends money. Harnesses with NO registered rows keep
the legacy default-subject ladder (unmigrated stores); an excluded legacy
login (`native_credentials_enabled: false`) can only be served by the
explicitly-requested paid route — nothing ever silently falls back INTO a
disabled login. The resolved row
becomes the typed `credential_profile` on every `HarnessRunSpec` the run
builds and keys the lane's read-only home, so the resolution flows to the
spec, preflight, continuity, and session recording. An explicit profile is
STRICT in the adapter — exactly the row's transport or a typed error event,
never a fallback to
default credentials (claude: config-dir login / stored token non-bare / stored
key; codex: scoped `CODEX_HOME` login / scoped key `auth.json`; cursor: scoped
file-store HOME login / namespaced key; opencode, raw-api: secret-ref keys
only). Adapters stamp
`credential_profile_id` beside `credential_route` on stream events so quota
and retry evidence stays profile-attributable, and the run's `auth_route`
receipt carries `profile_id`; Control API projects it as `authRoute.profileId`
without re-deriving it. Vendor sessions record the profile they were
created under; resume never crosses rows — the engine boundary re-verifies
every cached session against the RESOLVED account, so a pool switch starts a
fresh vendor session with the thread's continuation packet instead of
resuming a sibling's. `claudexor profiles login
<harness> <id>` runs the vendor login with the named binding's exact scoped
environment: codex rides the SAME durable device-code setup job as the default
login (D-17); the other harnesses run the vendor command interactively in this
terminal. Credential custody remains an effective platform fact, so a scoped
HOME may select Claudexor-owned vendor state without representing a separate
OS-user credential.

Removal is daemon-owned and mirrors registration: `DELETE
/v2/credential-profiles/:harness/:id` (CLI `claudexor profiles remove`)
removes the binding's Claudexor-owned state or managed secret FIRST — its
confinement-checked scoped login dir (fenced to the `profiles/` tree PLUS exactly the migrated
row's recorded legacy native locator from the migration record, never a
general native-tree class) or its namespaced secret, NEVER the vendor's
ordinary host store — and only then takes the registry entry out through the
same locked global-config owner. `removed: true` therefore means the binding is
gone and its effective policy's Claudexor-owned state or managed secret has
been removed when present (D-U4). When the credential is vendor-owned at OS-user scope, the receipt
explicitly reports it `left_unchanged` while the Claudexor-owned HOME and row
are removed; this is not a logout claim. A cleanup failure is a typed RETRYABLE
error (`credential_cleanup_failed`, 503) that leaves the row registered for a
clean retry — never a removed-with-warning receipt the startup
auto-registration would resurrect (`cleanupWarning` survives in the schema as
a deprecated wire-compat field and is never emitted). Removal
refuses with a typed 409 while a login job for that account is active. The same
daemon mutation clears every legacy scalar thread pin carrying that profile
id, clears any harness's `rotation_eligible` entry at the deleted id, marks matching harness/profile
native-session caches stale, and removes profile quota snapshots; deleting a
MIGRATED row additionally retires its legacy aliases — the null quota
subject, the `<harness>-default` lane homes, and the migration record — in
the same lifecycle operation, so deletion
cannot leave a route that fails on the next turn or resurrect a session if the
id is recreated. Dependent journal
invalidation happens before registry removal; any unhealthy project partition
returns typed 409/recovery-required, leaving the profile retryable.

Selection precedence is turn > thread-sticky > thread binding > pool:
a turn's explicit `credentialProfileId` (CLI `--profile`) beats the thread's
durable `credential_profile_id` (PATCH /v2/threads/:id); when both are null,
the thread's lane-derived account binding resolves first and the quota-aware
pool serves unbound runs. The API-key fallback is a route, not a synthetic
account row or count. Accounts are SYMMETRIC: the
listing (`GET /v2/credential-profiles`, `claudexor profiles`) projects every
credential row with its `enabled` flag (the only routing
control) plus the additive `accountPools` key — the per-harness pool
authority whose `next_up` verdict says who an unpinned run would route to
next, computed by the same routing owner. Its `kind` is
`profile | api_key_route | none`. The pool authority is also served alone by
`GET /v2/account-pools`, whose catalog presence is the unified-accounts
feature marker old clients detect. The legacy `harnessAccounts` key stays on
the wire as `[]` for strict old clients, and its legacy `next_up` union never
receives new kinds (old decoders throw on unknown discriminators). This is
ONE projection so no surface re-derives the symmetry. Every row's `enabled`
toggle is `PATCH /v2/credential-profiles/:harness/:id` (CLI `profiles
enable|disable`); for a migrated row the PATCH also updates the deprecated
`native_credentials_enabled` mirror for the downgrade window.

Accounts has three location-scoped owners. Opening, connecting, and ordinary
registry mutations use the cacheable plain `GET /v2/credential-profiles` to
hydrate the rows plus stable identity and status fields; it may
probe on a cold server cache, but it never claims fenced quota or `next_up`
authority. A display-only `GET /v2/quota` owns the quota values shown to the
person. Explicit Refresh/Retry and exact post-login verification alone request
the atomic `GET /v2/credential-profiles` form with `snapshot=true`: one server-authored
epoch contains profiles, profile and harness readiness, Workspace Git
capability, decorated quota, `next_up`, and an opaque quota-event cursor.

The atomic response starts a dedicated observer at exactly that cursor. Its
quota marker or a rejected/lost cursor expires `next_up` authority, but keeps
last-known quota visible with a stale reason and observation time. Independently,
the always-on per-location global stream lets a live Accounts/Quota subscriber
coalesce a marker into one display-only quota read plus at most one trailing
read. With no subscriber the trigger is dropped and the next subscriber performs
its initial read. This is event-driven recovery, not a timer or an automatic
vendor resnapshot loop. Registry hydration, display hydration, and foreground
atomic refresh are separately single-flight and generation-fenced; a later
mutation may update stable registry fields without reviving old `next_up`.
A failed atomic refresh preserves rows, identity, Enabled, and last-known quota,
marks readiness non-authoritative, and exposes the failure plus Retry instead of
an empty projection.
External thread create/PATCH calls with an explicit pool are rejected unless
the profile id exists for every pool lane. Run preflight probes the selected profile for every lane even when the
default harness doctor is already OK, before any adapter starts:
`verification: failed` refuses even with `availability: available`, while an
intentional presence-only API-key probe may remain `not_run` (shown unknown,
then adapter-enforced). Each harness
may declare ONE typed `profile_policy`
(`limit_action: auto|fail|ask|rotate`, priority-ordered `rotation_eligible`,
`headroom_threshold`). `auto` is the STORED DEFAULT and resolves by the limit
subject's credential kind at decision time (`effectiveLimitAction`, ONE
resolver shared by the engine and every projection): `rotate` for a
subscription (`local_session`) subject, `fail` for a metered API-key or
unknown route — a spent subscription window fails over out of the box, while
a metered limit stays a budget fact. Explicitly persisted `fail`/`ask`/
`rotate` keep their exact meaning and stored files are never rewritten; only
the interpretation of an ABSENT key changed (this supersedes the earlier
"rotation is opt-in" default — CONCEPT-CHANGE(INV-135)). Two separated
signals drive it (never prose, never
plain network errors): `profile_headroom_preflight` — before spawn, the
selected profile's freshest quota window applicable to the effective model
at/over the threshold, or its own OBSERVED live block (a reactive rate-limit
cooldown or spent window judged by the schema's availability projection —
stale-but-live evidence included, since a cooldown instant is absolute clock
truth, and matched by the FULL subject key including `credential_route`, so
the api-key default and the native-session default of one harness never
conflate on their shared `subject_id=null`), emits typed
`route.profile.headroom_exceeded` evidence, and `rotate` swaps to the next
eligible profile with `route.profile.rotated` provenance; and
`vendor_limit_rejected` — a TYPED vendor rate-limit that terminated a
no-deliverable, no-mutation try (`rotation_retry_eligible`) rotates the next
try onto a NEW vendor session under the next profile, each profile at most
once per attempt. A third, STRUCTURAL branch of the same predicate
(`structural_pre_progress_failure`) rotates a try that ended in a terminal
NON-transient death before the agent demonstrably did any work — no typed
limit needed and never narrowed by error-text matching; agent progress is the
typed marker set (thinking/tool/file/patch/compaction — deliberately not
`message`/`error`, so vendor failure prose can never block it), transient-
retryable deaths stay with the same-profile retry machinery, and an observed
mutation (workspace diff or any `file_change` event) blocks every branch.
Adapters keep a failed result's prose out of answer material entirely: a
non-success terminal result rides a `status` event, never a `message`, and an
errored attempt with no typed final has no deliverable (`acceptedTryOutput`) —
the in-loop rotation evidence reads this same policy owner, so refusal prose
that legitimately flows as mid-stream `message` events (the claude
org-disabled incident shape) can never suppress failover on any adapter.
Credentials never change inside a running spawn; a
rotation INTO a spent or still-cooling profile is refused by the same
headroom-plus-cooldown check. When no
target survives (all spent/excluded/wrong-kind), the engine emits typed
`route.profile.rotation_exhausted` with each rejected profile's reason and
headroom or cooldown evidence (with its earliest known release instant); the
UI surfaces the exhaustion instead of implying a switch. Exhaustion is also a
TYPED terminal: a reactive rotation-eligible failure with nowhere to go
terminalizes the attempt on `credential_pool_exhausted` (category
`harness_unavailable` — nothing malfunctioned) only when the triggering
subject or a POOL-MEMBER row carries limit/unusable evidence — rows for
identities rotation could never select (wrong kind, outside policy, not
ready) never count, and an evidence-free structural death keeps its TRUE
failure — through NORMAL attempt
finalization, BEFORE the transient gate could burn same-profile retries on the
already-refused subject, and the run terminal lifts `code` + `resetsAt` onto
`final/failure.yaml` in every lane (race unanimity, convergence last-result,
read-only chain). `resetsAt` folds the EARLIEST known reset WITHIN the pool —
the triggering subject's own observed limit included; a limit-evidenced member
with an unknown reset makes it null — deliberately the within-pool opposite of
the across-candidates LATEST rule. At preflight under `rotate`, the selected
subject's OBSERVED live block with no eligible alternative refuses with the
same typed terminal before spawn; a bare headroom breach with no alternative
still proceeds (proximity is not proof the window is spent).

Rotation also tells "quota spent" apart from "credential DEAD" (the A7
differential probe): whenever a rotation-eligible failure triggers the
candidate-readiness probe, a SIBLING probe examines the CURRENT/triggering
subject — re-reading the quota poller's authenticated vendor observations,
the attempt's own typed non-retryable auth/entitlement refusals, and the
adapter's local doctor probe. It never spawns a harness or spends quota (a
config-dir login has no cheaper liveness test than spending quota on a
mini-run). A dead-credential verdict becomes a typed
`route.profile.credential_unusable` run event and a bounded, self-expiring
`CredentialUnusableObservation` in the daemon's in-memory
`CredentialUnusableLedger` (deliberately NOT the `QuotaAbsence` channel — the
registry hides an absence while any live snapshot covers the subject — and
deliberately not journaled: readiness is non-durable by contract and the
poller re-derives vendor rejections within a cycle after restart). The
clearing contract is threefold: bounded self-expiry (24h hard cap;
entitlement/probe verdicts expire within the hour), a served model response
for the same subject (wired where usage events already feed the quota
registry), and any credential-generation change (login/logout/profile
mutation). Consumption is one composition point: `readyProfilesForRotation`
refuses a candidate a live observation condemns (model-scoped observations
refuse only their own model), exhaustion rows name it typed
(`rejected: credential_unusable`, never hidden behind `not_ready`), and the
pool-exhausted terminal carries the subject's dead-credential provenance in
place of a quota-reset promise that would never help. The Accounts-surface
projection of these observations is deliberately deferred (owner scope 4=A:
run + rotation evidence now, UI as a separate issue).

Preflight headroom refusal applies to PINS only under the unified model
(rotation never moves a pin); reactive `vendor_limit_rejected`/structural
rotation moves POOL-SELECTED rows onto the next ready pool sibling, never a
pin and never across credential kinds. The LEGACY default subject (a harness
with no registered rows — an unmigrated store) participates under the same
policy (auto-balance): with a RESOLVED `rotate` (explicit, or `auto` on a
subscription route), a fresh default-store headroom breach starts the run on
the next eligible SUBSCRIPTION profile (`route.profile.rotated` with
`from_profile_id: null`), and a typed vendor limit on a profile-less attempt
rotates only when the attempt's pre-spawn route estimate was `vendor_native`
— a metered default hitting a limit is a budget fact, not a subscription to
fail over from (`auto` encodes exactly this: an api_key or unknown subject
resolves to `fail`). The default subject never rotates into an `api_key`
profile (the cross-kind BLOCK generalized). Explicit `fail`/`ask` leave
default-user behavior untouched. The per-harness `limit_action` is
wire-patchable as `profileLimitAction` on `GET/POST /v2/settings` (the app's
tri-state auto-switch control: Off=`fail` / Auto / On=`rotate`); rotation
order and headroom keep their stored values.

## 6. Main Execution Paths

Every public CLI mode (`ask`, `plan`, `agent`) and the
interactive REPL enters through the managed daemon and `/v2`; the CLI starts it
when needed and fails loudly if it cannot. There is no second in-process CLI
run/thread authority. The daemon remains the single scheduler and journal
writer while the mode pipelines below retain their distinct mutability.
By default, the daemon admits up to twelve regular jobs globally per data root.
Same-thread turns remain serialized, while one already validated Delegate child
may use the scheduler's single overflow lane to prevent a waiting parent from
deadlocking.
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
in the user-level store `~/.claudexor/v3/runs/<run_id>/`. If routing or the harness
fails, the run still writes inspectable failure artifacts
(`context/context_error.md`, `final/failure.yaml`, `final/summary.md`) and emits
`run.failed`.

Ask also tracks normalized tool lifecycle. `tool_result.is_error === true`
preserves redacted detail in the event payload and blocks a green verified claim
unless verified recovery exists, but a produced deliverable can still be terminal
success with warnings. Optional web denial/error is warning evidence and does
not trigger route fallback or terminal failure; a read-only route is judged on
its answer and the ordinary harness/contract axes.

### Ask --deep-scan (research sweep)

Runs a bounded read-only swarm (`intent: audit`, default width 4, cap 8; the
CLI `claudexor ask --deep-scan` maps here). Each explorer writes a per-attempt
event stream and a findings markdown artifact (`findings/<attempt>.md`). Sweep
final artifacts include `final/report.md`, `final/explore-findings.yaml`, and
`final/omissions.md`. Partial explorer failures are recorded as omissions when
at least one explorer succeeds; if all explorers fail, the run emits
`run.failed` with `final/failure.yaml`.

**Synthesis reducer (#27 / D-6).** When two or more scouts succeed, the sweep
does NOT concatenate their reports. After the scouts finish, ONE bounded
synthesis reducer runs — a single `intent: synthesize` attempt on a
synthesize-capable scout route. It is read-only and file-backed: the raw scout
report files are pointed at by absolute path (the argv-size law — reports ride a
file, never argv), reserves a budget lease like any attempt, and is bounded by a
hard timeout. Its job is to deduplicate claims, surface disagreements with
per-scout attribution, and preserve every scout's omissions. The reducer's merge
becomes `final/report.md`; the raw scout reports remain as per-attempt
artifacts. The reducer is emitted as a normal attempt (`synth`) in the run
telemetry roster, so its route and cost are visible. If a caller
`--output-schema` is set, it validates against this FINAL reduced aggregate, not
the first scout.

The reducer is honest about failure: on reducer error, timeout, budget denial,
or when no scout route can synthesize, the final artifact is an explicitly
labeled raw scout bundle (a marker heading, the scout reports verbatim, the
honest roster denominator) — never a fake synthesis. A single-scout (width-1)
scan skips the reducer entirely. The typed outcome is recorded on
`RunTelemetry.deep_scan_synthesis` (`succeeded` = merged, `failed` = honest
bundle with a reason, `skipped` = single report).

### Agent

`claudexor agent` defaults to `agent`. It is a one-candidate orchestrator/envelope
run: the harness works in an isolated workspace, Claudexor captures the git diff,
emits artifacts, and live project mutation happens only through explicit
delivery/apply.

An Agent whose effective access is `readonly` is the answer-producing narrowing
of that path: it skips Git/worktree preparation, snapshots, patch capture,
synthesis, delivery, and patch WorkProduct emission, while preserving the answer,
summary, telemetry, and native session. Patch-convergence controls (`attempts` or
`untilClean`) are incompatible with readonly and refuse typed before provider or
workspace work; they are never ignored or silently redirected.

Envelope semantics are strict. Project runs execute under
`~/.claudexor/v3/projects/<project-sha256>/workspaces/<task>/<attempt>/tree`, and
the harness `cwd` is the envelope worktree. Proven work product is the git diff in that worktree, a
declared run artifact, or an explicitly verified host side-effect. Absolute
`/tmp/...` writes are host side effects and are not project diffs; project tmp
requests default to `tmp/...` inside the project/envelope or to run artifacts.

Git admission follows the semantic run shape, not a blanket mode rule.
`GET /v2/run-applicability` (with the absolute `repoRoot` query) returns the
live Git capability plus the engine-owned `in_place | isolated` × `read_only |
agent_convergence | agent_other` matrix computed by the same predicate the run
preflight uses. An isolated thread materializes its persistent Git worktree on
the first mutating turn. Read-only Ask, Plan, and Agent turns reuse that worktree
when it already exists; before then they read the stable project directly and do
not initialize Git. Git-backed Agent write envelopes use the same idempotent initializer: `git init` plus a
deterministic baseline commit (author `Claudexor`) make worktree diffs honest
from the first run. Claudexor never creates or edits the project's `.gitignore`;
repo `.claudexor/` is user-owned config and runtime stays external. The action
is announced via a `project.git.initialized` run event in the timeline — never
a silent mutation. Exception (INV-075): a root equal to the user home
directory or a filesystem root — or one that cannot be classified (no safe
home resolves, or the root itself does not physically resolve; both fail
closed) — is refused with the typed `git_boundary_root_refused` error before
any mutation, carrying cause-specific required actions: the home and
filesystem-root refusals offer a project subfolder or a self-run `git init`
plus a first commit, while an unclassifiable root names its classification
failure and its own remedy; a home that is already a healthy repository is
respected untouched. Both operands are classified on their PHYSICAL
resolution (realpath of the raw spellings, exactly git's own `-C`
resolution), so a symlinked spelling of the home cannot slip past the guard
and a home that fails to resolve physically refuses fail-closed. Ordinary
non-git roots keep the announced auto-init. If a non-transactional Git step fails after
repository metadata may have changed, that same event carries `partial:true`,
the failed stage, and the proven progress before the workspace failure; CLI and
Control timeline render the incomplete initialization as a warning instead of
hiding it behind the terminal error.

Supported in-place non-Git shapes remain available: Ask and Plan do not require
Git there, and the existing live Agent convergence path can use its copied
baseline. A Git-backed shape instead refuses before a provider starts when the
executable is missing, is Apple's developer-tools launcher stub, or fails its
probe. Direct `/v2/runs` keeps eager admission. A thread turn is persisted first,
then runs the same preflight in the durable daemon job immediately before
provider execution, so its typed problem survives reload and Exact Retry can
replay the unchanged target and options after Git becomes available.

Read-only turns provision a scoped harness HOME (and no new worktree) so native state —
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

Chat thread turns run IN-PLACE: a mutating Agent turn executes directly in the
execution tree (the live project for an `in_place` thread, or the thread's
persistent worktree for an `isolated` thread — the orchestrator's internal
run-input carries this as `executionRoot`). A read-only turn uses an existing
isolated worktree directly, or the stable project until the first mutating turn
materializes that worktree. Thus the
routed harness resumes its own native CLI session and the next turn sees the
work — no continuation packet for these (the native session already holds the
delta). A best-of-N race still runs candidates in
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
An isolated candidate refused by the secret fence is excluded when another
safe working candidate survives; an all-refused race, an in-place cleanup
receipt, or an injected Delegate-belt failure remains terminal for the race.

### Agent --attempts / --until-clean

One envelope is carried forward across repair attempts. `--attempts` stops at
the explicit cap. `--until-clean` has no fixed iteration cap and stops on
convergence, cancellation, budget/quota exhaustion, or no-progress stall after
eligible harness rotation.

### Plan

Runs one eligible planner read-only with an explicit "plan, do not implement"
instruction wrapped around the goal (so the model produces a plan instead of
trying to build it and dumping code when writes are blocked) and writes
`final/plan.md` — an honest `# Plan` document with the goal, plan, and open
questions. Multi-harness plan critique belongs to Council's explicit
draft-then-merge strategy; Plan never enters the code-review pipeline or carries
reviewer/protected-approval controls. It
also writes `final/work_product.yaml` with `result_kind: plan` and a null
diffstat, so a surface reports "plan only — no files changed" rather than a green
"succeeded" over nothing. A follow-up turn implements it via the `planRunId`
field: Implement freezes the plan (sha256 recorded on the turn) and delivers it
to the executor as a server-owned file reference. The plan lifecycle — typed
open questions, server-derived readiness, plan freeze on Implement — is
plan-owned, not a permanent top-level app sidebar concept.

### Ask --deep-scan (single report, width 1)

Runs one selected compatible harness read-only with `intent: audit` and writes
`final/report.md` (deep scan at width 1 — no swarm fan-out).

## 7. Control API

The daemon is the durable scheduler. `DaemonServer` requires an injected durable
command authority and has no in-memory command-record fallback. The HTTP control API is a live viewport and
artifact/delivery facade. Every implemented operation is declared once as a
code-first **route descriptor** — a plain entry in the control-api operation
catalog (`packages/control-api/src/operation-catalog.ts`) carrying method, path,
one-line summary, mutability, auth boundary, applicability plane, and
request/response schema names.
That catalog is the single source of truth (Zen #4): the daemon serves it at
`GET /v2/operations`, and `node scripts/gen-endpoints-doc.mjs` derives BOTH the
canonical inventory below and the machine-readable endpoint map for external
agents at `docs/reference/endpoints.json` (method, path, mutating flag,
applicability, summary, auth, located parameters, and request/response/error
schema names referencing the generated JSON
Schemas in `packages/schema/generated/`). README and INTEGRATIONS link here
instead of maintaining duplicates. A freshness gate (`scripts/docs-truth-check`)
fails when the descriptors and the actual wired route guards drift apart in
either direction, so an added or removed handler cannot silently escape the
catalog. Field-level semantics live in the schemas themselves: every control DTO
carries `.describe()` documentation that lands in the generated JSON Schema
files.

`applicability` groups an operation under the resource plane it acts on —
`global`, `project`, `thread`, or `run`. Collection and create routes inherit
their family even without an instance id (`GET`/`POST /v2/projects` are
`project`, matching how the run and thread collections are classified), so a
context-aware consumer can filter operations by the selected resource.

`requestSchema` names the JSON request **body** DTO only. Strict non-body inputs
— GET query filters (`fresh`/`all`/repeated `harness`, the credential-route
model filter, the setup-job list filter, the trust `repoRoot` scope) and SSE
resume cursors (the `Last-Event-ID` header, plus the run stream's `lastEventId`
query alias) — are declared separately in each descriptor's `parameters`
(name, `query`/`header` location, required/repeatable, enum or generated
schema reference, and one-line semantics). A machine consumer can therefore
build a full valid request, including resumable streams, without guessing.
The control API validates request bytes as strict UTF-8, rejects malformed
percent-encoding in the path with a typed `400 malformed_request_path` (never a
`500`), projects request-schema violations into structured `fieldErrors`
(JSON Pointer → messages) with a single-line human summary rather than a raw
validator dump, and validates the per-run SSE cursor as a nonnegative integer
`seq` before opening the stream.

<!-- BEGIN GENERATED ENDPOINTS (node scripts/gen-endpoints-doc.mjs; do not edit by hand) -->
- `GET /healthz`
- `GET /v2/account-pools`
- `POST /v2/accounts-migration/rollback`
- `GET /v2/agent-capabilities`
- `GET /v2/credential-profiles`
- `POST /v2/credential-profiles`
- `DELETE /v2/credential-profiles/:harness/:profileId`
- `PATCH /v2/credential-profiles/:harness/:profileId`
- `GET /v2/filesystem/directories`
- `GET /v2/global/events`
- `POST /v2/handshake`
- `GET /v2/harnesses`
- `POST /v2/harnesses/:id/auth-readiness`
- `GET /v2/harnesses/:id/models`
- `POST /v2/maintenance/gc`
- `GET /v2/operations`
- `GET /v2/projects`
- `POST /v2/projects`
- `DELETE /v2/projects/:id`
- `GET /v2/projects/:id/events`
- `GET /v2/projects/:id/file`
- `GET /v2/projects/:id/outputs`
- `GET /v2/projects/:id/outputs/<path>`
- `POST /v2/projects/:id/relink`
- `GET /v2/quota`
- `POST /v2/quota`
- `GET /v2/recovery/partitions/:id`
- `POST /v2/recovery/partitions/:id/export`
- `POST /v2/recovery/partitions/:id/quarantine`
- `POST /v2/recovery/partitions/:id/validate`
- `GET /v2/run-applicability`
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
- `POST /v2/setup/jobs/:id/input`
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
  thread once a mutating turn materializes it. It also carries sticky routing — `primaryHarness` and
  `eligibleHarnesses` — that its turns inherit; `PATCH /v2/threads/:id` renames /
  archives a thread (title + open/closed state) and switches the sticky
  routing.
- `POST /v2/threads/:id/turns` enqueues a follow-up run anchored to the thread.
  Mutating Agent turns run IN-PLACE in the execution tree — the live project for
  an in-place thread, or the thread's worktree for an isolated thread. Read-only
  turns reuse an existing isolated worktree or read the stable project without
  materializing one — so the
  routed harness resumes its own native CLI session and the next turn sees the
  work. A best-of-N race runs candidates in isolated envelopes and auto-applies
  the winner to the execution tree. When a turn runs on a lane that has not seen
  the whole conversation (a lane switch or an A→B→A gap), the engine hydrates it
  with a bounded continuation packet delivered as `context/THREAD.md` and
  discloses it via a typed `session.continuity` event + a `continuity` field on
  the turn record (INV-137); a plain in-lane turn resumes natively with no
  packet. Past a byte budget the packet's oldest turns collapse; the engine
  replaces the collapsed prefix with a cached LLM summary keyed by (thread,
  collapse-boundary turn) under the thread's lane dir — computed once by a
  bounded read-only ask-mode pass on the lane's own harness + credential route
  (single turn, hard timeout, no job queue) and reused until a new head turn
  advances the boundary. A timeout or unavailable harness falls back to
  mechanical one-liners, so the delta is never lost; the disclosure's
  `summarized` flag is set either way. A `planRunId` body field implements an approved
  plan from an earlier turn: Implement freezes that plan (sha256 recorded on the
  turn) and delivers it to the executor as a server-owned file reference, so the
  agent runs against the frozen plan rather than a bare prompt. `POST /v2/threads/:id/apply` delivers an isolated thread's accumulated
  worktree diff to the project; in-place threads write the project directly and
  never need it.
- Refused turns are honest end-to-end: when a turn's run dies BEFORE it starts
  (the trust gate refusing `access: full`, preflight validation, an enqueue
  throw, or an Implement whose plan still has open questions and no explicit
  override — a typed `plan_not_ready`), the daemon persists the reason on the
  turn (`ThreadTurn.enqueue_error`, projected as `enqueueError`) as one typed,
  sanitized problem: message, machine code, retryability, bounded required
  actions, bounded structured context, and failure time. String leaves are
  redacted before bounded persistence; arbitrary provider output and environment
  values are not admitted. Surfaces render the message and recovery actions,
  not the context object wholesale, so every refusal stays useful without
  becoming a raw-data disclosure. The readiness refusal is enforced at
  run-start (not by a bespoke early return in the control API), so it rides this
  exact mechanism and stays durable, idempotent, and replayable. `POST
  /v2/threads/:id/turns/:turnId/retry`
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
  `claudexor retry` and `claudexor run-again`. Durable idempotent replay is
  resolved before mutable resource, Git, or harness preflight: once a request
  was accepted, a later environment change returns the original command/run
  handle rather than replacing history with a new refusal. If no command was
  accepted, a replay may reuse its one journaled runless turn only while that
  turn is still the conversation tail; the recovery boundary refuses a
  historical orphan before enqueue. Already accepted commands remain valid and
  bind in daemon command order even when later turn bubbles exist. If command
  retention has removed that authority while its turn is already bound, replay
  refuses instead of executing a second unbound run. Thread recovery mutations
  are serialized per thread, bind a turn to at most one run, preserve
  frozen-plan hash/override provenance on Exact Retry, and emit decision/rerun
  audit side effects only for the request that first accepted the command.
- `GET /v2/trust` + `POST /v2/trust` are the user-level trust surface: the GET
  enumerates per-repo trust files (`~/.claudexor/v3/trust/<repo-hash>.yaml`, each
  stamped with its `repo_root` provenance so the list is human-readable; legacy
  pre-provenance files show a null root), and the POST accepts `repoRoot` plus
  `allowFullAccess` and/or `accessDefault` (strict — unknown fields are 400) to
  update one repo. Versioned project test commands are canonical typed argv,
  never implicit shell text. Their external grant binds the project/config/
  command digests, resolved executable/script bytes, and access profile;
  changing any component prevents spawn. CLI trust commands use this same
  boundary (`trust --grant-test '["pnpm","test"]'`). This backs the macOS one-click remedy on a
  trust-refused turn and the Settings trust section (list + revoke).
  Two distinct authorities feed the deterministic gate set (QA-010): a run
  request may also carry **explicit per-run operator test commands**
  (the run request's typed `tests` field / CLI `--test '["npm","test"]'`), canonical
  typed argv that become `trust_required:false` gates for that run's own
  envelope. The operator authorized them by passing them, so they run without a
  trust grant — that is the honest rule for a Create run, whose fresh project
  (and its test script) does not exist until the run produces it, and which
  therefore has no versioned config commands and no trust file to grant. Only
  the versioned *project* commands (loaded from `.claudexor/config.yaml`) carry
  `trust_required:true` and need the external grant above; the two sources merge
  in `resolveContractGates`.
- A succeeded-but-blocked run carries a minimal typed `requiredActions` list on
  `ControlRunDetail` (stable machine ids from the single status-projection owner:
  `resolve_review_block` / `fix_failed_checks` / `record_operator_decision` for a
  risk-overridable block, and the non-overridable `provide_required_input` /
  `complete_incomplete_work` for a work_state veto). Clean, already-decided, and
  failed runs carry none — a failed run's remediation rides the failure
  `nextActions`.
- `POST /v2/runs/:id/decision` records a typed operator decision on a blocked run:
  `accept_risk` / `override_needs_human` append an auditable patch-hash-bound
  record to the owning global/project journal before ACK. The run artifact
  `arbitration/operator_decision.yaml` is only a compatibility projection for
  artifact-only CLI reads; the apply gate reads journal authority. A same-key
  replay reads that journal authority before the thread's current idle gate and
  repeats the lookup inside the serialized mutation to close a concurrent-record
  race;
  `accept_clean_patch` delivers; `rerun_with_feedback` enqueues a follow-up;
  `revert_run` uses an immutable external content-addressed anchor and restores
  only recorded postimage bytes that still match; overlapping later user edits
  are refused instead of overwritten. The anchor remains reachable independently
  of Git garbage collection.
- `GET /v2/runs/:id/produced` and `GET /v2/runs/:id/produced/<path>` serve the
  project's PRODUCED outputs — the repo `artifacts/` dir, the macOS workspace
  Artifacts-tab source — distinct from the run-internal `GET /v2/runs/:id/artifacts` tree.
  Artifact listings and the review-findings projection are point-in-time
  snapshots that tolerate vanish races (ENOENT/ENOTDIR) as partial snapshots,
  never a 500 — a poll concurrent with reviewer-workspace churn serves the
  survivors; other errnos stay loud. `.git` entries are never enumerated
  (name-based skip — gitlink FILES are skipped too, not only `.git`
  directories) but remain fetchable by explicit path.
- `GET /v2/runs` returns a BOUNDED, newest-first, keyset-paginated page of run
  summaries (QA-052), not the whole retained registry. `limit` (1..1000, default
  200), `state`, and an opaque `cursor` are strict and typed — a typoed or
  malformed value is a typed 400, never silently ignored. Ordering is
  `(createdAt desc, id desc)`; a page returns `nextCursor` + `hasMore`, and
  `cursor` is comparison-based so keyset traversal survives concurrent
  inserts/prunes with no duplicates or omissions. Ordering, `state` filtering,
  and page slicing all happen on raw records BEFORE any summary is materialized,
  so per-run artifact fingerprint/projection work is bounded by page size rather
  than total retained records; a terminal run's fingerprint further short-circuits
  to file identities for only the mutable `delivery_state.yaml` overlay and the
  retention-owned `tombstone.yaml` transition (all other artifacts are frozen once
  the run is terminal). The bare parameterless call stays valid — it now yields the
  newest 200 with a cursor to page the rest.
- `claudexor settings show|set` is a thin client of `GET|POST /v2/settings`.
  Validation, persistence, cache invalidation, and the returned effective
  `ControlSettingsSnapshot` come from the daemon; the CLI has no second config
  writer or model/effort validator.
- The macOS Settings surface treats each execution location's `GET /v2/settings`
  as an explicit `idle | loading | loaded | failed` projection. Engine-backed
  editors exist only in `loaded`; a missing or failed snapshot is never replaced
  by editable client defaults. Load publication is fenced by location, gateway
  identity, connection generation, and a newest-request token. `POST /v2/settings`
  remains the write authority and its returned snapshot may establish `loaded`
  only when no newer GET owns that location. App-local controls such as
  Connections and Appearance remain available while engine settings are loading
  or retryable.

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

The open questions themselves ride the SAME projection: `ControlRunDetail`
carries `planQuestions` (the parsed `PlanQuestion[]`) beside `planReadiness`,
from one artifact read — so surfaces RENDER questions without re-parsing.
Every parsed question accepts the operator's own words as a complete answer;
single/multi options are suggestions rather than a forced closed vocabulary.
The interactive CLI (a TTY plan turn on a thread) offers to answer inline
(numbered pick for `single`, comma-separated for `multi`, free line for `text`,
blank to skip) and submits the composed answers as an ordinary follow-up plan
turn through `POST /v2/threads/:id/turns` — the same lane, no separate answer
channel. The shared CLI choice parser accepts only complete in-range decimal
tokens; a single-choice question requires exactly one. Numeric-prefixed prose
or a comma list supplied to a single-choice question remains the user's whole
free-text answer instead of silently selecting an option. Non-TTY/`--json`
prints readiness + guidance only. The ACP surface
(chat-first, Zed) renders the question set as TURN TEXT (numbered, options
inline, marked which accept multiple picks or free text) and ends the turn
normally; the user's next prompt is an ordinary follow-up plan turn. ACP's
`session/requestPermission` bridge stays reserved for single-choice RUN-TIME
interactions (the SDK 1.2.x has no multi-select/free-text typed input, so the
end-of-turn question batch is rendered as text rather than a faked typed form).

An answer follow-up carries `answersPlanRunId`, a typed relation to the plan
whose questions it answers. The Control API accepts it only for a Plan turn
against the same thread's current head and rejects a second accepted/queued or
retryable answer turn. The relation is persisted on `ThreadTurn` and projected
as `answersPlanRunId`, so the macOS card restores a read-only submitted receipt
after restart or remote reconnect without parsing prompt text. A non-retryable
pre-enqueue refusal remains resubmittable; retryable refusals keep their own
exact-turn Retry path.

Implement is a normal agent thread turn that carries `planRunId`
(`POST /v2/threads/:id/turns`). The server FREEZES the referenced plan: it reads
the plan artifact, records its `sha256` on the turn (`plan_hash`), and hands the
executor a server-owned `planRef` (`{ runId, sha256, path }`) whose file is
materialized as `context/PLAN.md` OUTSIDE every worktree. The engine verifies
the hash before any harness spawns — a tampered or unreadable plan fails loudly
(`plan hash mismatch` / missing plan), never runs against altered intent. Exact
Retry replays the `planRef` verbatim, so a retried Implement can never silently
run without its plan. Both provenance facts ride the turn projection (the
`planHash` / `planReadinessOverridden` fields on `ControlThreadTurn`) so a
reviewer can prove which plan bytes ran and see the override survive reload.
Implementing
while open questions remain is an explicit, recorded operator choice
(`plan_readiness_overridden`), not a silent default;
plans and repo config never carry protected-path approvals — operator approval
is always supplied on the current run.

Planning is solo by default. The **Council** plan strategy (`plan --council`,
optionally `--n 2..4`) turns it into a multi-harness draft-then-merge: round 1
runs N members as parallel planner attempts (each the SAME vendor-native
read-only planner spawn the solo loop drives, in its own lane on a thread turn;
Cursor uses native read-only Ask so the final-message WorkReport remains available), whose
drafts land as file-backed artifacts (`council/draft-<harness>.md`). The primary
then runs ONE merge iteration (intent `synthesize`) whose prompt POINTS at the
draft files by absolute path — like the frozen-plan brief, full text never rides
the prompt bubble — and produces a single unified plan. The `## Open Questions`
parser runs on the MERGE output only, so `final/plan.md` + `final/questions.json`
are shape-identical to a solo plan and the readiness/freeze/Implement flow above
is unchanged. Council owns no new state machine: it is round-1 attempts plus a
merge attempt, with a `council/membership.yaml` projection served on
`ControlRunDetail.council` (requested/drafted/degraded/mergedBy + per-member
role and status) and mirrored on the MCP run/read structured results so a host
can machine-verify the roster without reading local artifacts. Degradation is
disclosed, not silent — a failed member is
carried on the projection and the merge proceeds with survivors (one survivor
still merges); all members failing is a typed failure. Council shares the
explicit-lane admission rule with Best-of: an explicitly named member that is
unavailable (including one with no doctor manifest) fails the run loudly at
routing preflight before any draft, rather than vanishing while a healthier
member drafts. Draft and merge are distinct phases of one primary: a member
card carries only its DRAFT outcome (a merge failure is never attached to a
drafted member), the failure text derives from per-attempt outcomes (a
successful draft is never relabeled failed and its artifact is preserved), and
the merge runs in the SAME admitted route context whose readiness passed for
the draft — not a fresh disposable HOME whose cold native-status probe times
out. `council` is a strategy
FLAG refused off `mode=plan`, and `--n` on a plan is legal only with it (shared
`runStartStrategyViolations` owner). The strategy is engine-owned in
`packages/orchestrator/src/planRun.ts` (round orchestration) and
`packages/orchestrator/src/council.ts` (member selection, merge prompt,
projection).

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
has applied the terminal event provably has the output. The EventLog's
once-only terminal-preparation hook also builds and validates the immutable
`RunFacts` receipt in memory and embeds that exact object in the terminal
journal event. Terminal commit order is: owning partition journal, atomic
telemetry/`final/run_facts.yaml` projection, per-run `events.jsonl`, then
best-effort live publication. An observer that has seen the terminal event can
therefore fetch the exact validated receipt rather than racing terminalization.
A failure before journal acceptance leaves no terminal authority and may use
the safety-net retry. A local failure after journal acceptance preserves the
typed `terminal_recovery_required` signal; the daemon immediately (or on
restart) validates the journal payload, repairs a missing/torn receipt and
per-run terminal tail, and terminalizes the command from that same `RunFacts`.
Once a terminal commits, EventLog refuses every later terminal or engine emit
for that run; post-terminal control audit events continue the monotonic file
sequence.

The terminal event TYPE is derived from the validated outcome facts, never
taken from the emitter's original choice. Every non-succeeded lifecycle
(failed, cancelled, interrupted) commits as `run.failed`; a succeeded outcome
that needs an operator decision (review blocked, checks failed, or an
unfinished work_state) commits as `run.blocked`; and a succeeded outcome with
clean axes normalizes to `run.completed` even when the engine emitted
`run.blocked` — preserving a producer-authored block with no machine-readable
cause would demand a decision no axis can justify. The wire type is therefore
a projection of the receipt; consumers read the axes in the payload and never
pattern-match the producer's intent.

Lifecycle and terminal reason remain separate. Reaching a configured hard
wall-clock limit stops the process and therefore commits lifecycle `cancelled`
with reason `wall_clock_exceeded`; the shared presentation owner labels that
"Time limit reached", and ACP returns `refusal` because the user did not cancel
the turn. An explicit Stop commits `user_cancelled` and projects cancelled.
Control API, CLI, MCP, ACP, and macOS consume those typed facts rather than
rewriting every cancellation as user intent; a legacy cancellation with no
reason stays unknown/cancelled instead of receiving a fabricated cause.

Cancellation wins only until the synchronous terminal commit starts. An abort
observed before the terminal barrier replaces the prepared outcome with
cancellation facts while retaining the independent checks/review/no-change/
work-state evidence already established for the run. Once a terminal has
committed to the owning journal, Cancel is a NO-OP: the committed terminal
wins, a later abort cannot rewrite the durable result, EventLog refuses every
later terminal emit, and the daemon keeps reporting the committed outcome.
The `aborted -> cancelled` mapping survives only as the daemon's fail-closed
fallback classification for a malformed runner result with no recognized
lifecycle.

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
disclosed in the log). Awaiting-user interactive login runners are the one
exemption: the shutdown drain does NOT signal them (a detached Terminal login
survives an ordinary daemon bounce and is reconciled on the next start;
explicit cancel is the only killer). A hung participant cannot immortalize the
daemon whichever trigger asked it to die. Runtime replacement uses a separate
internal socket operation: in one synchronous event-loop turn the daemon checks
its queued/running/in-flight command authority, the composition root checks the
active setup authority, and only an idle result enters `beginShutdown`, whose
synchronous prefix fences setup, Control API, and daemon admission before any
shutdown await. Busy is a retryable `runtime_replacement_busy`; unreadable or
missing authority is `runtime_activity_unknown`; either refusal leaves the
serving daemon and every ingress open. A lost, untyped, or incompatible RPC
response may passively prove that the pinned daemon exited, but only an exact
`{ok:true,fenced:true}` admission receipt grants SIGKILL authority; uncertainty
therefore cannot turn an old or newly busy daemon into a replacement casualty.
Explicit operator shutdown keeps its forceful semantics. The daemon records its
birth identity in the writer lease at startup; `claudexor daemon stop` then CONFIRMS death
(released lease, gone pid, or identity-verified SIGKILL escalation — a
recycled pid is never signalled) before reporting success, so scripts and
test disposers can trust its exit code. The lease is acquired before the
daemon publishes its socket or Control descriptor, so a present lease without
a reachable socket remains a protected startup window unless its owner is
proven stale. That proof is deliberately narrow: a missing pid, a birth-identity
mismatch, or exact Linux `/proc` state `Z` is stale; a matching non-zombie
owner, malformed or unreadable authority, and any unavailable identity/state
proof remain fail-closed. Recovery never signals the stale owner. Acquisition
moves the exact stale generation to a deterministic, nonempty tombstone keyed
by pid and a digest of its token, then preserves that tombstone so a delayed
contender cannot quarantine a live successor. Acquisition is the only
quarantine mutator and tombstones have no automatic GC.

Above the per-socket lease sits a PERSISTENT root authority for the shared
data root. Before any journal work the daemon validates/installs a permanent
barrier at the canonical default writer address: the lease directory carries
`root-authority-v2.json` and no top-level owner record, so a pre-fix claimant's
owner parse fails closed forever (it can neither adopt nor quarantine the
address), while fixed runtimes contend on a nested `active` slot inside the
barrier. First migration of an owned flat generation is an in-place atomic
owner replacement (owner record swapped for an unparseable migration sentinel,
marker published, sentinel retired), so the address is never absent and never
carries a dead parseable owner; an already-live pre-fix owner still refuses the
candidate through the shared lease machinery and cannot be retroactively
revoked. The barrier record persists two separate facts, both refused typed
and fail-closed: the writer protocol epoch (foreign epochs refused) and the
semantic-version floor of the last runtime that PROVED it could serve
(strictly lower versions refused; equal versions contend normally). The
barrier survives clean shutdown and is never automatically removed. Startup
itself is two-stage: after authority, the journal is prepared READ-ONLY (scan/
verdict, no truncation), the socket + Control API come up serving
`recovery_only` — health, handshake, shutdown, and the `/recovery/*` surface
stay reachable while every product route/RPC is refused with a typed
`daemon_recovery_only` 503 — and only after transport is provably up does the
daemon revalidate every read-only preparation, and only on all-green advance
the floor, run destructive recovery (activation truncation, crash GC,
orphan/debris sweeps, retention), and open normal admission. A root
with a recovery-needed partition keeps the floor unchanged and destructive
work off, staying online recovery-only instead of dying dark — the control
API binds for that plane even under `CLAUDEXOR_NO_CONTROL_API=1`, and a
successful `/recovery/*` quarantine re-runs the admission completion in
process, so the daemon transitions to normal serving without a restart. The handshake
discloses `servingMode` (`normal`/`recovery_only`; absent means a pre-fix
daemon, treated as normal); the macOS app maps `recovery_only` to its
existing Connecting loop — no adoption, no hydration, no reconciliation, no
fallback launch — until admission opens.

Termination, local and remote runtime replacement, and the real-harness
battery consume the same strict owner classification. They recheck the exact
generation at the action boundary; classification alone never grants signal
authority, and only an explicitly pinned, identity-matching capable owner may
be escalated. Socket-unreachable plus an absent or proven-stale lease may prove
an idempotent stopped state, while capable or uncertain ownership blocks. The
battery may start through a stale lease because normal acquisition heals it,
but cleanup succeeds only after the main lease is physically absent.

Stdio bridges (`mcp serve`/`acp
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
`POST /v2/projects/:id/relink` moves an existing stable project id.
`DELETE /v2/projects/:id` retires a project — it removes the registry entry and
ARCHIVES the project's journal partition (renamed out of the active journal
tree, never deleted, the same non-destructive move the quarantine path uses),
leaving run artifacts to normal GC and disclosing all of that in a typed
receipt. It is refused with a typed `409` while any non-purged thread or
live/queued run still references the project. The live/queued-run fence is a
SNAPSHOT, disclosed as such in the receipt (`activeRunCheck: "snapshot"`): the
active-run root set is read once via an async daemon IPC job-list read BEFORE
the synchronous removal, so a run that starts in the narrow window between the
snapshot and the removal is not fenced. Closing that TOCTOU would require the
job list to be readable synchronously inside the removal (it is a cross-process
socket call today), so the receipt states the guarantee honestly rather than
implying atomicity. The CLI
projects the same surface as `claudexor project list|register|relink|remove` and
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
with a typed 410 `run_expired_by_retention` — never a mysterious 404. The
receipt also carries an advisory `data_root_unrecognized` listing — names of
top-level data-root entries the engine does not own and never touches
(absent, with an `errors[]` entry, when that scan fails).
While running it snapshots its live harness child process groups to
`daemon/pids.json`; the NEXT startup reaps recorded orphans that survived a
crash (pid liveness + command-name recycling guard) and sweeps workspace
debris under daemon-known project roots: orphaned envelopes (with their
seeded-credential homes), dead per-attempt `claudexor/<task>/<attempt>`
branches, leaked `claudexor/verify-*` branches, and stale
`claudexor-ro-*`/`claudexor-verify-*` tmp dirs. Envelopes whose creating
process is STILL ALIVE survive the sweep: `WorkspaceManager.create()` records
an owner marker (pid + kernel start time — recycling-proof, plus the envelope id
and in-place/isolated recovery mode) that the sweeper honors, so a workspace
whose owner is still active is never garbage-collected by a daemon starting
mid-flight. A dead in-place envelope is reconstructed with that exact identity,
allowing marker-bound Browser cleanup without treating the live project as an
isolated worktree. One bounded exception: when start-time proof is
unavailable on either side (`ps`-less or sandboxed environment, legacy
marker), a live pid keeps the envelope only while its working dirs are fresh
(24h window over the newest mtime of the envelope base, owner marker, and
a bounded recursive walk of tree/home) — a recycled pid must not pin a
seeded-credential home forever. A second daemon refuses to start while a live daemon
holds the socket — checked BEFORE crash GC so a racing start can never reap
the live daemon's children. `claudexor daemon rotate-token` rotates the local
auth token (refused while the daemon is live; takes effect on next start),
and on POSIX the daemon best-effort chmods the socket 0600 — a chmod failure
on exotic filesystems is tolerated at startup (the win32 named pipe is not a
filesystem entry, so no chmod applies there; the bearer token remains the auth
gate on every platform).

### Interactive runs (waiting_on_user)

Harnesses with the `interactive` capability (Claude Code via its bidirectional
stream-json control protocol) can raise typed user questions mid-run; the
orchestrator OFFERS the interaction channel only to routes whose manifest
declares `interactive`. The
engine emits `interaction.requested` (questions, options, nullable timeout deadline),
parks ONLY that attempt, and the daemon journals the pending projection in the
run's global or `project:<id>` partition before exposing it via
`GET /v2/runs/:id` (`pendingInteractions`, `summary.waitingOnUser`). Answers
arrive via `POST /v2/runs/:id/interactions/:id/answer` and are delivered into the
live session only after the resolution is journaled (`interaction.answered`).
TTY delivery uses the same exact choice grammar as plan questions; it never
coerces a numeric prose prefix or multiple picks for a single-choice question.
After daemon restart an unresolved question becomes interrupted rather than
resurrecting a dead in-process continuation. `interaction_timeout_ms` is one
finite-or-disabled policy: absent uses the 15-minute default, a positive value
sets automatic expiry, and `null` disables automatic expiry. A real finite
expiry becomes a benign decline (`interaction.timeout`) so the model can
continue with stated assumptions. With expiry disabled, answer, Cancel/abort,
the run's outer deadline, terminal cleanup, daemon restart, or registry release
still ends the wait; those releases must not be relabeled as timeouts.
Declined/timed-out interactive flow-control tools are benign timeline events,
never blocking tool errors.

Delegate children use this same interaction contract. A parent/list child
summary may carry `waitingOnUser:true`, but it does not own the question body;
the macOS client therefore performs a coalesced fresh child-detail read even
when that child had been hydrated earlier, renders the answer against the child
interaction's canonical `runId`, and exposes a truthful retry if the detail read
fails. Answer delivery remains the same journal-first child endpoint above; no
parent-side proxy or app-local interaction state is introduced.

`/v2/setup/jobs` (create / status / snapshot / events / cancel / reconcile / extend)
is the native-login setup surface for Codex, Claude, Cursor, and Antigravity.
The same effective setup-login projector feeds `/v2/harnesses`,
`/v2/agent-capabilities`, and create admission. Its current producers always
emit their own `setupLogin` property; omission remains a legacy-wire fact.
`in_app` maps to daemon transport, while `external_terminal` maps to the
existing `client_pty` attach path. The full CLI and packaged daemon bundle
share that exact attach owner: the latter reserves only `setup attach <jobId>`
as an alternate role, and malformed `setup` input exits with usage status 2
before daemon startup. Profile-required and platform-cardinality validation
runs before any terminal capability probe or durable mutation.
Readiness and
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

Native login specs are a shared `{binary,args,displayCommand,loginMode}`
contract. The adapter manifest owns the only duplicate-prone input fact as
`managed_login.stdin = none | pipe | terminal`; command argv, flow, and vendor
window remain in the native-login registry. **Codex's primary flow is typed device-code over the official codex
app-server, with NO Terminal (D-17):** the sealed manifest carries
`loginMode: "device_code"` + `appServerFlow: "chatgptDeviceCode"` and the args
`codex -c cli_auth_credentials_store=file app-server --stdio` in its dedicated
`CODEX_HOME`. The runner hosts that app-server inside the SAME detached process
group the Terminal flow uses, drives `initialize → account/login/start
{chatgptDeviceCode}`, and surfaces `{userCode, verificationUrl}` on the JOB
SNAPSHOT via a read-time projection (see below), then waits for
`account/login/completed` before exit 0 → the unchanged native verification
runs. The request `loginFlow` selects the secondary app-server
`browser_callback` (`account/login/start {chatgptDeviceCode}` → `chatgpt`
authUrl) or the legacy Terminal `browser_redirect` (localhost callback). Claude
(`claude auth login`, the claude.ai subscription route with no version-varying
flag) and Cursor (`cursor-agent login`) use daemon-hosted URL disclosure; Claude
accepts its one-shot completion input over the transient sidecar, while Cursor
self-completes by vendor polling. Antigravity uses the same disclosure/input
shape but declares terminal stdin because the vendor rejects a plain pipe.

**Typed capability probe, no stdout regex:** if the installed app-server lacks
the auth methods it answers a JSON-RPC method-not-found; the runner maps that to
the typed `device_auth_unsupported` result, so the daemon offers the legacy
Terminal `browser_redirect` fallback (never an opaque argv error). The legacy
Terminal flow is DEMOTED to this fallback: it still probes `codex login --help`,
tees output so the operator sees the URL/one-time code, and persists a bounded
ANSI-stripped tail so the daemon can disclose the real failure cause (e.g. the
ChatGPT "Allow device code login" toggle being off).

**Transient login disclosure (journal-is-authority, INV-062):** the one-time
`userCode` and every captured sign-in URL ride ONLY a transient
`runner-devicecode.json` sidecar the runner writes and a read-time overlay on
`ControlSetupJobSnapshot` / `ControlSetupJobEvent`; they are NEVER fields of
the journaled `ControlSetupJob`, never logged, and never written to the durable
result receipt (the journal records only THAT something was disclosed, via the
`awaiting_user` transition). The sidecar is removed on terminalization so the
disclosure stops projecting. Snapshot/event schemas accept the overlay for any
active login job in `awaiting_user` — codex app-server flows carry a
`userCode`; the daemon-hosted `url_disclosure` (cursor) and
`url_disclosure_with_input` (claude, agy) modes carry the captured `oauth_url` /
`oauth_url_input` sign-in link with an empty code. For
`url_disclosure_with_input`, the user's pasted completion value arrives via
`POST /v2/setup/jobs/:id/input`, rides a one-shot transient
`runner-input.json` sidecar to the vendor CLI's stdin under the same
never-journaled rule, and a second submission conflicts instead of replacing
the first. Stateful UI clients replace the overlay from each authoritative frame,
retain it only across a bounded same-job Extend/reconnect transition, and clear
it on Cancel, detach, terminal/non-awaiting state, final stream loss, or poll
failure. Every point response and SSE event must identify the setup job named
by its request; cursor and sequence then fence ordering within that job.
Every machine fallback and UI continuation takes its credential `profileId`
from the server-owned setup job, never from the sheet or caller that happens to
be observing it.

The daemon writes a private runner manifest; the device-code runner is launched
DETACHED (no Terminal, not macOS-gated), the Terminal fallback via
`open -a Terminal`. In both the runner executes the absolute vendor binary,
scrubs provider credentials, and atomically records
PID/kernel-start/process-group and result sidecars. A vendor that reads its
pasted code only from a terminal (agy) is the one exception to a bare exec: the
runner interposes the system terminal helper it probes for (`expect`, else
util-linux `script`) on POSIX, or the adjacent probed ConPTY helper on Windows.
The exact resolver requires a regular helper plus a bounded protocol probe,
derives argv from the sealed words, and preserves the vendor exit status. An
absent/unsupported helper refuses with typed 409 and names the external-terminal
route; a failed helper probe is a retryable typed 503. The runner resolves the
same backend again immediately before spawn, so a post-admission change becomes
a durable typed transport failure rather than a false vendor exit. The vendor's OWN window, when shorter than the engine's, becomes
the job deadline and cannot be extended — delivering the pasted code raises a
bounded exchange floor so the clock cannot cancel a sign-in that succeeded. It never receives or
persists a vendor token or credential file. Apart from the bounded, ANSI-stripped, secret-redacted diagnostic tail a
FAILED codex login persists, vendor output is not copied into durable logs, and the Terminal fallback stays open on the result until the
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

Login launch has a 10-second watchdog and a 15-minute deadline where the
ENGINE owns the window; a vendor that caps its own sign-in (Antigravity's
sixty-second paste window) has that shorter deadline published as fixed, and
Extend refuses it with a typed 409 until a delivered code replaces it with the
bounded exchange grace. For engine-owned deadlines Extend adds 15 minutes
without a cumulative limit. For a deferred `client_pty` attach, the
journaled job deadline remains the mutable authority across extensions; the
immutable manifest instead seals a 10-second permit window measured from the
actual runner start, and the daemon refuses to issue that permit after the
journaled deadline. Duplicate create for the SAME target store
(default, or one profile) returns the same active action instead of launching
a second Terminal; a create naming a DIFFERENT target while a login is active
refuses with a typed 409, and a conflicting active mutating
action is refused. Cancel is asynchronous. Cancel/timeout sends TERM and, after
five seconds, KILL only when PID + kernel-start identity still matches; an
unproven identity is never signalled or called cancelled.

On **win32** the same contract holds through platform-shaped mechanisms, and
this is the ONLY lane that enables them. Kernel-start comes from the process
creation time (`GetProcessTimes`, read through the absolute System32
PowerShell), so a recycled PID compares DIFFERENT exactly as it does on POSIX;
every other consumer keeps the fail-closed default where a win32 identity stays
unprovable and no signal is sent. Windows has no process group and no
cooperative TERM, so both escalation steps are one `taskkill /PID <leader> /T
/F` of the recorded leader's tree, issued only while that identity still owns
the PID, and emptiness is the LEADER's identity being gone afterwards — a
leader-death proof, weaker than the POSIX group-ESRCH proof and recorded as
such. The vendor binary is still executed without a shell: on win32 only an
executable image (`.exe`/`.com`) resolves, so an npm `.cmd`/shell shim is
refused with the install advisory rather than launched through `cmd.exe`.
Terminal-stdin setup wraps that exact image with the adjacent ConPTY helper
only after its real `--probe` succeeds; doctor/quota print probes instead use
a detached, console-free runner with ignored stdin. Their bounded reaper
and passive registry retain normal cancellation and unconfirmed-child custody.
An ordinary daemon
stop/restart no longer terminates an awaiting-user login runner (that regression
killed the operator's own pending login in the 2026-07-21 incident); explicit
`setup jobs cancel` and the login deadline's timeout escalation are the only
signalling paths. Restart consumes an existing
terminal result first, then adopts a live runner only on positive evidence — a
matching durable handle, the same leader identity, and a nonempty process
group; a proven-dead group with no receipt is the unrecoverable
`cancelled_on_restart`, and identity uncertainty stays fail-closed as
`termination_unconfirmed`. A capability smoke with no durable completed receipt
becomes `interrupted_unknown` and is never auto-replayed. Terminal outcomes distinguish
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

A run blocked by the winning candidate's `NEEDS_HUMAN` findings (reviewer
escalation, protected-path change, critical-risk diff) is a terminal `blocked`
state whose findings surface inline on the blocking turn and in the
run-filtered workspace's Outcome facts (there is no separate Review Queue
screen). The gate is winner-only and fail-closed: losing candidates' findings
are disclosed run evidence that never blocks the selected deliverable, while a
winner missing its review evidence record blocks exactly like an escalated
one. Since v0.9 the human decision is a TYPED server action:
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
The derived `ApplyEligibility` verdict is delivery-state aware: it consults the
effective `RunApplyState` BEFORE the pre-delivery gate, so a change already in
the live tree answers a terminal `already_applied` (and a deliberately reverted
one `reverted`) with no `requiredAction` — never "run a fresh final check" for
finished work. Because a review-`blocked` run skips the FinalVerifier by
construction (`final_verify: null`), a hash-bound `accept_risk` /
`override_needs_human` decision does NOT dead-end that verdict: the read-only
projection reports `verify_pending` and stays eligible, and the fresh final
check runs just-in-time on the apply path (the same gate, now handed the fresh
verifier result) — a mechanical conflict there still fails closed.
The versioned project config owns restriction-only approval globs under
`constraints.protected_paths` (empty by default). The schema accepts only
canonical repo-relative forward-slash globs, rejecting absolute paths, dot
segments, traversal, and backslashes. The orchestrator freezes the parsed list
into `TaskContract.constraints.protected_paths`; any matching create, modify,
delete, or either side of a rename escalates the completed run to a human
decision before apply. Per-run approvals never narrow this list.

Before a mutating turn starts, the daemon promotes an `in_place` project thread
with configured project protected paths one-way into the existing persistent
isolated-thread workspace. The promotion, worktree path/base, and invalidation
of native sessions from the former live cwd are one durable journal mutation;
the next lane receives the bounded continuation packet. The run can finish and
produce a patch without changing the project tree, while the existing typed
thread Apply decision remains the only delivery authority. A direct agent
embedder that requests `inPlace` against the live project root fails before
adapter spawn and must provide a distinct isolated execution root.

`TaskContract.constraints.auto_protected_paths` is instead derived from configured
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
   Replaying apply on an already-delivered run (a fresh invocation with a new
   idempotency key) is a typed idempotent no-op: when the forward patch no
   longer applies but the reverse check proves the tree is already this patch's
   exact postimage, delivery returns `applied` with no mutation instead of a
   `patch does not apply` failure; a diverged target still refuses as a
   conflict, never a false success.
2. **In-place turns (thread turns and thread-less one-shot runs)** — a write
   turn executes directly in the thread's execution tree, and the thread-less
   one-shot surface (`POST /v2/runs` with `execution.isolation: "live"`,
   agent-mode only; `execution.delegated` external-orchestrator runs ride this
   same shape) executes directly in the live project tree. Fences (the same
   machinery for both): a pre-turn snapshot is taken at turn/run start and a
   post-turn snapshot at turn end (the per-turn diff base, so prior dirty state
   is never attributed to the turn), and the server-owned `revert_run` decision
   uses an external content-addressed pre/post anchor (overlapping later user
   edits are refused, below).
3. **Best-of winner adoption** — a best-of-N thread race runs candidates in
   isolated envelopes and applies the winner's patch to the execution tree only
   on a fully verified `success`; `ungated`, `review_not_run`, blocked,
   and failed results remain inspectable artifacts and never auto-adopt. Adoption
   runs the PROTECTED apply path (`git apply --check` first, then a plain
   all-or-nothing apply). A stale or concurrent target is refused and no
   destructive rollback is attempted; `adopted:false` reports whether the
   observed target remained unchanged (INV-114).
4. **Thread apply** — `POST /v2/threads/:id/apply` delivers an isolated thread's
   accumulated worktree diff. Fences: one per-thread mutation queue refuses
   apply as `thread_busy` while a mutating turn is queued/running; every run
   after the durable delivered-prefix watermark must be applyable (a later
   success cannot launder an earlier blocked contribution); a secret-like-token
   scan refuses the patch; delivery reuses `verifyAndDeliver` with a fresh
   verifier and exact target preimage. Success advances the persistent thread
   branch and watermark with journaled thread state.
5. **Automatic git init** — a NON-GIT project folder is initialized before a
   Git-backed mutating run shape crosses its boundary (`git init`, deterministic
   baseline commit). This includes the first mutating isolated-thread turn and
   Agent write-envelope paths; read-only and supported non-Git in-place shapes do
   not initialize.
   Fence: the mutation is announced via a typed `project.git.initialized` run
   event — never silent. A partial non-transactional failure emits the same
   event with its failed stage and proven progress before terminalizing.
   Second fence: a user-home, filesystem-root, or unclassifiable root is
   refused with the typed `git_boundary_root_refused` error before any
   mutation (INV-075 exception); a healthy home repository is untouched.
6. **`revert_run`** — the server-owned in-place revert reads the immutable
   external patch anchor and reverses only bytes still equal to the recorded
   Claudexor postimage; a conflicting user edit is refused and left untouched.
7. **Thin `CLAUDE.md` bridge** — under its own write-envelope preparation rule
   (INV-113), a project root that has `AGENTS.md`
   and no `CLAUDE.md` gets a thin `CLAUDE.md` whose body is the official Anthropic
   import form (`@AGENTS.md`) plus a Claudexor ownership marker, so a Claude Code
   route reads the same instruction file Codex/Cursor/OpenCode read natively
   (Codex additionally gets `CLAUDE.md` as a project-doc fallback via config, and
   a CLAUDE.md-only project needs no write at all). The bridge is written in TWO
   places, because an isolated envelope checkout materializes only the COMMITTED
   tree and so never sees an untracked project-root bridge: (a) the PROJECT root
   (the durable, in-place/thread-visible write, announced via a typed
   `project.claude_bridge.created` run event — never silent); and (b) each
   git-mode ENVELOPE checkout at workspace prep, so a Claude Code candidate racing
   inside an envelope reads the same instructions. The envelope write emits NO run
   event — the envelope is disposable and Claudexor-owned — and diff capture
   EXCLUDES the generated bridge from the candidate patch by exact path, gated on
   BOTH the created-this-run fact AND BYTE-EQUALITY with the generated bridge
   content (A-3: byte-equality alone is necessary but not sufficient — it cannot
   tell our fresh bridge from a candidate that rewrote a pre-existing committed
   `CLAUDE.md` to the exact bytes, so `WorkspaceManager.diff` AND-gates it with
   "Claudexor created the bridge this run"). Only a pristine, untouched bridge is
   excluded; a candidate-authored `CLAUDE.md`, or any candidate EDIT of the bridge
   — even one that keeps the ownership marker comment — differs from the exact
   bytes and is captured in `patch.diff` like any other real change, the same
   positive-ownership doctrine as the marker-bound artifact-child exclusion.
   Fences on both writes: the create is EXCLUSIVE (`O_CREAT|O_EXCL`)
   and NO-FOLLOW, so a hand-written `CLAUDE.md`, a symlink (even dangling), or a
   directory at that path is never overwritten or written through; it is
   idempotent, so a second or concurrent prep is a no-op; the project-root write
   is skipped for read-only modes and `--in-place` stateful targets. Git
   admission is determined independently by the semantic run-shape predicate
   above. A bridge failure never fails the run (it is a convenience, not a
   precondition).
8. **Secret-diff quarantine rollback** — when an in-place candidate contains
   secret-like bytes, the orchestrator reverse-applies only that candidate's
   transient patch. The workspace rollback verifies the exact postimage before
   mutation and refuses if concurrent/user bytes diverged; Git object writes
   use the isolated scratch object database. A refusal or unproven scratch
   cleanup becomes a typed manual-cleanup receipt, never a broader reset. This
   path does not yet take the repository mutation lease; that hardening remains
   a separately owned follow-up rather than an undocumented mutation.
9. **In-place browser artifact cleanup** — when Browser is effective, workspace
   prep lazily creates one unique `.claudexor-artifacts/<envelope-id>` child and
   persists an envelope-id-bound ownership marker outside the live tree. Only
   that child is passed as Browser output, excluded from Git/non-Git capture,
   collected into Evidence, scanned for secret risk, and removed at dispose.
   A pre-existing shared root is validated as a real directory and preserved;
   sibling/user files are never excluded or deleted. A symlink or non-directory
   root refuses before Browser starts, and cleanup never widens beyond the
   marker-bound child. The shared root is removed only when this run created it
   and it is still empty. The envelope owner record persists that exact id and
   the workspace mode before Browser can run. Normal dispose and crash/startup
   recovery therefore remove the same marker-bound child; malformed recovery
   identity preserves both the marker and envelope base for manual recovery.

Reviewer selection is Agent-only and schema-owned. Ask and Plan reject reviewer
panels and protected-path approvals; Council is Plan's critique path. The
automatic Agent selector uses provider-family
diversity plus optional per-family `reviewerModels` / `reviewerEfforts` hints.
For release and dogfood gates, the `reviewerPanel` field on
`ControlRunStartRequest` carries an
ordered list of explicit `{ harness, model?, effort? }` entries. The CLI spells
this panel as `--reviewer-panel` with comma-separated `harness=model:effort` entries
(model and effort optional), e.g.
`--reviewer-panel "claude=claude-opus-4-8:max,cursor=gemini-3.1-pro"`. That panel is
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
requires at least two distinct observed provider families. UI clients may
send the same DTO but must not invent reviewer readiness outside doctor/status
and declared intent.

Reviewer prompts always review code through the normal patch contract. The
retired standalone Plan-review subject has no runtime or surface representation.

Paid budgets use an explicit tagged contract: `{kind: unlimited}` or
`{kind: finite, maxUsd >= 0}`. CLI `--max-usd N` is syntax sugar for the finite
form, including `--max-usd 0`; zero and null never mean unlimited. The default
comes from `budget.paid_budget_per_run`. A single root ledger grants leases to
planner, candidates, synthesis, and review, and settles
observed spend even when work errors. Every route carries cost knowledge
(`exact | estimated | unknown`), billing knowledge, source, and provenance.
Subscription token valuation is telemetry, not a cash debit — estimated OR
exact, for candidates and each reviewer route. It is projected BESIDE cash on
`ControlBudgetSnapshot` (`valuationUsd` + `valuationKnowledge`, also on the MCP
read result), so a native-subscription run reads as exact `$0` cash with a
non-null valuation; an unknown valuation stays null, never a fabricated `$0`.
Mixed review panels settle
native reviewers to valuation and API-key reviewers to cash independently;
their aggregate is never blindly charged as cash. Candidate and reviewer
retries classify EACH usage event by that event/current typed credential
route; a native→API-key retry cannot hide later metered spend under the first
native route, and an undisclosed route remains cost-unverifiable. A typed auth
fallback disclosed before the vendor process starts selects the carried route
but does not create a billable interval; only a real `started` interval can end
without a receipt and make cash cost permanently unknown. `finite(0)` admits
only proven-zero or subscription-entitlement work; a positive finite cap permits
at most one unknown-cost paid unit in flight. A later exact charge above the cap
is retained and ends `budget_overshoot`; permanently unknown cost ends
`cost_unverifiable` rather than fabricating `$0`. Later parallel race
candidates, Council members, and deep-scan scouts reserve an estimate floor
(`budget.estimate_usd_floor`, default $0.05). The Deep Scan synthesis reducer
and the one-shot enveloped candidate continuation reserve it too because each
is another unknown-cost paid unit. A real Delegate child uses that same floor
for its first and subsequent paid attempts because it overlaps the still-running
parent. The first ordinary top-level attempt remains unreserved. Estimated work
therefore counts against shared headroom before usage streams, while final
settlement remains authoritative.

A budget refusal is projected honestly by ONE shared classifier
(`classifyBudgetFailure`), not re-invented per mode. The ledger's typed
lease-denial (`finite_zero`, `hard_cap`, `estimate_headroom`,
`unknown_paid_in_flight`) and settled terminal (`budget_overshoot`,
`cost_unverifiable`) are captured at the denial site with the refused
route/slot, then mapped — across ask, agent/best-of, deep-scan, solo plan, and
council — onto a `RunFailure` with `phase: budget`, `category: budget`, a
machine-readable `code`, the refused `harnessId`/`attemptId`, and remediation
that names the budget control (`--max-usd` or the composer Budget) or a
proven-zero route. It NEVER recommends authentication/setup for a budget cause,
and it warns that an unchanged Exact Retry replays the immutable cap. Surfaces
choose remediation from the typed `code`, never by parsing the message.

Quota is typed and vendor-owned, never scraped from prose. Each constraint may
carry canonical `applies_to_models`; omitted/null means a vendor-wide window.
Routing, pacing, and profile headroom consume that same applicability predicate,
so a saturated Fable-only window cannot cool an explicit Opus run. Codex rollout
`token_count.rate_limits` preserves every reported window as an independent
constraint with usage, duration, reset, provenance, and freshness. The global
journal is authority; an elapsed reset marks a snapshot stale and requests a
refresh, never locally invents zero usage. Unknown usage remains `null`.
One exhaustive schema-owned trait registry classifies every source along three
independent axes: vendor-authenticated credential evidence, the primary harness
whose missing observation creates refresh demand, and whether a top-level
refresher produces it. Refresh demand is computed per enabled credential
subject and only a fresh matching primary snapshot satisfies it. Typed absence
is still a successful, displayable observation, but retains soft demand under
exponential pacing; reactive rollout/retry and status-line evidence remains
available to display and routing without triggering or satisfying primary
demand. The poll lifecycle is single-flight, anchors its next eligibility to
completion rather than start, advances backoff after partial/absence outcomes,
and resets when credential or routability state changes. A registry-owned
credential generation fences a provider cycle after validation and before its
first journal, memory, absence, marker, response, or cursor write. A foreground
caller from a newer generation waits for obsolete work to retire, then all such
callers coalesce into one current-generation cycle; an obsolete poll cannot
restore removed evidence or satisfy a post-login refresh. The three top-level
refreshers run concurrently, validate every fulfilled snapshot and absence
before the first write, then fold in declaration order so first-claim and marker
semantics remain deterministic; each refresher's per-account vendor calls stay
serial. Both `/v2/quota` and the atomic Accounts response decorate snapshots
with the same server-owned model-aware availability projection. Raw journal
records and projection signatures remain undecorated, and clients never promote
a model-scoped exhausted window into an account-wide percentage or block.
Runtime-update rollback remains backward-readable: a scoped snapshot — or one
whose source postdates v3.2.0's strict enum (`cursor_rate_limit`) — is first
prepared under a typed record that an older engine ignores, then committed by
the established upsert using an explicit v3.2.0 field allowlist with the
nearest v3.2.0 source label in the base. The journal
appends that pair under one recovery intent and one fsync, so replay retains
both records or neither. Current engines apply the exact scope and true source
only when the
matching base follows; v3.2.0 replays that base conservatively as account-wide.
`auto` ranks by the binding `min(elapsed_fraction - used_ratio)` pacing slack,
`quality` uses only exact user-declared `{harness,model,effort}` tiers, and
`economy` minimizes known incremental cash spend with quality tiers only as a
tie-breaker. Credential transport alone never proves a route free. Typed rate
limits that reject or block a run create cooldowns. A Claude rejection whose
typed `rateLimitType` proves an Opus or Sonnet family carries that same model
scope into both the live ledger and durable journal; generic or unknown
rejections remain account-wide. Advisory Claude `allowed_warning` heartbeats do
not create cooldowns. Unknown quota remains eligible and is never rendered as
full headroom.

Quality routing needs at least one comparable user-declared tier for the run's
intent, or the ranker refuses at preflight (`RoutingPreflightError`). This is a
CONFIGURATION error, not a harness-availability one, and is enforced on BOTH
sides (D-9/#22): the daemon `POST /v2/settings` write validates the MERGED
EFFECTIVE routing and returns a typed 4xx `config_error` when the write would leave
`goal: quality` with zero configured tiers (whether the patch flips the goal or
clears the tiers), so an unroutable goal is never persisted; and at run time the
strategies (ask / agent / plan / deep-scan / council) classify a
`RoutingPreflightError` as a `config_error` failure — with configuration
remediation, never a re-auth/harness-wait prompt — rather than
`harness_unavailable`.

Routing rationale: pool ordering records a typed `RouteRankingRationale` ONCE as
run evidence (`RunTelemetry.routing_rationale`), not an event — the ordered pool,
the ids dropped by `paid_fallback`/cooldown, the decisive `reason`
(`subscription_entitlement_first` / `lowest_incremental_cash` / `quality_tier` /
`expiring_quota_slack` / `all_incremental_cash_unknown` / `declared_order`), and a
per-candidate `{billing_knowledge, incremental_cost_usd, eligible}` tuple. The
rationale is axis-aligned with the ranker, so it can never disagree with the order
actually taken, and it is derived from typed auth-route evidence: a doctor-VERIFIED
vendor-native source proves `subscription_entitlement`, so that route survives
`paid_fallback: never` and ranks with a real economy tuple instead of reading as
unknown/paid. Surfaces project the rationale verbatim (run detail) and never
reconstruct the order from prose. A deep-scan swarm reserves n>1 subscription
scouts under a finite cap against the per-run estimate floor (mirroring the
candidate loop), so later scouts are not refused for lacking a per-attempt cash
quote; a scout the gate still refuses before spawn is recorded as a failed attempt
with a budget-denied marker so the denominator stays honest (1/2, not 1/1),
omissions and telemetry disclose it, and an all-denied scan still terminalizes
through the shared budget classifier (never harness_error).

Transient-failure taxonomy (adapter→orchestrator boundary): every
adapter/stream failure is classified into a typed `HarnessFailureCategory`
(`timeout` / `rate_limited` / `auth_failed` / `capability_refused` /
`process_crash` / `config_error` / `unknown_harness_error`) alongside the
fine-grained `kind`, with the safe provider metadata preserved (retry delay,
vendor HTTP/adapter code, kill signal). The classifier reads only typed event
fields — an adapter-declared `transient`/`rate_limit` signal, the vendor's typed
`status.error_category`, and the run loop's typed exit disclosure (signal /
spawn-failure) — never prose. The centralized retry policy gates on the
category's `retryable` verdict rather than a bare "saw a transient" boolean:
adapter-disclosed transients and rate limits retry with backoff (rate limits also
feed W5.4 profile rotation), while deterministic refusals (auth/capability/config)
and give-ups (a crashed child, an inactivity-watchdog abort) terminate. The typed
category rides `route.transient.detected`/`exhausted`, is persisted on the attempt
telemetry's `transient_failures`, and drives required-actions — authentication
guidance appears ONLY on a classified `auth_failed`, never on a timeout, rate
limit, or crash.

On every terminal path (zero exit, nonzero exit, abort), the shared CLI run
loop attaches a bounded, adapter-redacted `stderr_tail` to the terminal
`completed` payload — raw diagnostics on the attempts channel (events.jsonl /
SSE / `--json-stream`), never a verdict axis. Persistence into attempt events
is guaranteed for consumers that drain the stream to completion; an
orchestrator-side abort that stops consuming before the terminal event does
not persist it (bounded residue).

Structured output: routes whose manifest declares `json_schema_output`
receive `HarnessRunSpec.output_schema` — a CALLER-supplied per-run schema the
run's final answer must conform to (agent race / ask answers), normalized and
strictified
for vendor strict modes (every object: `required` = all keys,
`additionalProperties: false`; inline root — both live-verified: codex
`--output-schema <FILE>` written into the scoped CODEX_HOME, claude
`--json-schema <inline JSON>`). The conformance validator selects draft-07
(the compatibility default when `$schema` is omitted) or draft 2020-12 from
the caller declaration; the metadata declaration is removed only from the
vendor-strict transport copy. The two CLIs SATISFY the schema differently
(live-observed): codex constrains its FINAL MESSAGE to bare JSON
(structured-first parse path); claude materializes the schema as a
StructuredOutput TOOL — the constrained JSON rides the tool call while the
final message stays markdown, so the fenced-JSON path carries claude (and
every non-capable route). Structured output is also gated OFF when the spec
will ride the interactive stream-json transport — that vendor combination
is unverified; fenced parsing carries interactive runs.

WorkReport envelope (D-16): on a `work_report_transport: constrained` route the
engine COMPILES a transport ENVELOPE `{ work_report, output }` that wraps any
caller `output_schema` and rides `HarnessRunSpec.output_schema`; the caller's
original schema stays the conformance authority for `output` after unwrap (the
contract keeps both). With no caller schema a `final_message` route (codex)
wraps the markdown deliverable as `output: string`; a `side_tool` route
(claude's `--json-schema` materializes a StructuredOutput tool) arms a
`{work_report}`-ONLY schema so the prose final stays the deliverable and the
report rides the tool payload (the adapter surfaces it on the final message's
`work_report_side_tool` payload); a `validated` route (cursor, no native
schema) INSTRUCTS the model to write its complete markdown answer normally and
end with a fenced `{work_report}` metadata block that the finalizer validates
off the last fenced block. Historical fence-only `{work_report, output}` replies
remain readable through a compatibility fallback; a nonempty markdown prefix
is always canonical, and legacy `output` is consulted only when that prefix is
empty. The three tiers
are one resolver (`resolveWorkReportEnvelope`) and one unwrap
(`unwrapWorkReportEnvelope`, keyed on the envelope `channel`). The unified
attempt finalizer removes the transport beside `finalizeStructuredOutput` —
`answer.md` persists the deliverable, never the envelope/footer — and validates the
model-authored `WorkReport { state, required_inputs }`. A missing/malformed
report on a constrained OR validated route is a typed `work_report_contract`
failure (never a prose success); a valid `needs_input`/`incomplete` report
becomes a `work_state` veto.

Context signals (D-16c) are a sibling of the transient-retry taxonomy and NEVER
enter the retry loop. The claude adapter maps FIXTURE-PROVEN 2.1.165 frames onto
the typed `context` field of `HarnessEvent`: result `terminal_reason` (`prompt_too_long` and
the rapid-refill breaker `rapid_refill_breaker` → `capacity_exhausted` with a
typed cause), the `compact_boundary` system frame → a compaction event, and the
top-level typed `rate_limit_event` → the existing `rate_limit` signal (a routine
`allowed` heartbeat surfaces nothing and never arms rotation). Codex exec
0.144.1 surfaces oversized input only as a stderr JSON-RPC error
(`input_error_code: input_too_large`), NOT a typed stream frame, so codex stays
honestly generic (no context event) until upstream surfaces a typed code. A
terminal `capacity_exhausted` with no completed WorkReport maps to
`interrupted / context_capacity_exhausted`.

One-shot continuation (D-16d): when an eligible terminal `capacity_exhausted`
(cause `repeated_refill` only — `prompt_too_long` may be an irreducible packet)
leaves no completed WorkReport, `continuation_count == 0`, and the run is
read-only or enveloped (in-place excluded), the engine launches ONE fresh native
session (`nativeResumeAvailable: false`) re-grounded by a mechanical-first
checkpoint packet synthesized via the continuity module (sibling of
`resolveContinuity`). The continuation is disclosed as a typed `run.continuation`
event with the count; on completion it supersedes the exhausted attempt as the
run winner. Live plan checklists ride typed
`HarnessEvent.plan_progress` (codex `todo_list` items; claude
TaskCreate/TaskUpdate accumulation — TodoWrite kept for older CLIs), forwarded
as last-wins `plan.progress` run events and projected on the run detail as
`planProgress`; per-candidate evidence cards are projected on the run
detail as `candidates` from attempt/review/decision artifacts.

Repository release review is cumulative and SHA-bound. The panel reviews the
exact clean committed candidate against the checklists and docs; any tracked
mutation invalidates every result and starts a new freeze. Since the owner
decision of 2026-08-06 the formal pair executes as Cursor operator subagents
(one `fable` slot and one `sol` slot, each pinned to its owner-approved tier
set in the panel constant, both on the full context — INV-125), and the signed
schemaVersion-6 attestation (protocol `cursor-operator-fable-sol-v1`) binds
the candidate SHA/tree/version, the exact full-gate receipt, the sealed
evidence manifest/diff/wave, and both reviewer entries. Each slot's artifact
directory (`NN-<slot>/`) carries `report.md` plus an exact-shape
`metadata.json` whose fields are operator-attested: the actually used model
slug (validated against that slot's owner-approved tier set), exact ISO
start/finish intervals that must genuinely overlap, a
`pass|warn` verdict, the mandatory `review_scope: "full"`, and the report's
SHA-256. The sealer does not launch any review CLI; it recomputes every
digest and refuses anything missing, extra, malformed, or mismatched.
Schemas v2-v5 are archival only:
already-sealed attestations stay signature-verifiable for their releases,
never as new publish input. The operational protocol — panel composition, wave
discipline, blocker contract, and round bound — is defined ONCE in
`docs/CHECKLISTS.md` (Release review protocol); this map does not restate it. The old per-commit
staged-diff hook, bypass log, and installer are removed so they cannot compete
with or be mistaken for release authority. Product command `claudexor review
--diff <file>` remains a normal engine capability; it is not this repository's
release attestation.

After exact `pnpm release:verify` passes, the gate builds a small
self-contained verifier from tracked candidate sources and copies the packaged
app's self-contained CLI, binding both byte digests into its receipt. The
operator transport never executes that copied CLI — it travels only as
receipt-bound bytes — and the sealer imports only the receipt-verified
verifier bytes rather than mutable workspace `dist`. The sealer re-verifies
the sealed evidence packet against the candidate SHA/tree, the exact
base..candidate diff byte-for-byte, the byte-identical receipt inside the
packet, every reviewer artifact digest, and the interval overlap before
signing. The slot metadata itself — model, intervals, verdict, scope — is a
set of operator-attested statements, not independently observed session
evidence (an accepted property of the owner's v6 transport decision recorded
in `docs/CHECKLISTS.md`).

Runtime resilience is typed. Adapters translate native transient failures
(network lookup failures, stream disconnects, retryable HTTP statuses, timeouts)
into typed `transient` `HarnessEvent`s; the orchestrator may retry only within the bounded
global `runtime.transient_retry` policy and only when the failed attempt produced
no deliverable. Reviewer panels use `runtime.reviewer_timeout_ms` (default 10
minutes). A timed-out reviewer still records any observed model/route proof that
streamed before timeout. Candidate/planner/read-only harness streams carry an
INACTIVITY watchdog (`runtime.harness_inactivity_timeout_ms`, default 60
minutes; env `CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS`): no useful agent
progress for the window means the vendor CLI is wedged — the stream is aborted
(process-group kill) and the attempt fails with a typed message instead of
parking the run in `running` forever. One closed typed policy resets the window
for non-empty thinking/message deltas, tool calls/results, file or patch
changes, plan progress, and completed context compaction. Starts, status/retry/
reconnect/keepalive chatter, usage-only updates, transient errors, terminal
frames, and unknown future event kinds stay observable but do not extend the
lease. Waiting on a typed user interaction suspends the watchdog under the
separate finite-or-disabled interaction policy. Long active runs therefore stay
alive while they make real progress; a tool call that streams nothing for the
whole window remains indistinguishable from a hang and is killed.

Run detail includes terminal state and output-ready state. `summary.state` is the
daemon terminal/lifecycle state. `summary.outputReadyState` is
`pending | finalizing | ready | diagnostic`. New terminal runs consume the
optional `presentation` member of `RunFacts`, written from the last validated
`output.ready` state and the terminal-selected primary artifact; `primaryOutput` consumes the
same receipt. Retention truth wins that projection: `tombstone.yaml` yields a
diagnostic primary output, and a declared primary file that is missing or blank
yields an explicit diagnostic at the declared path rather than a false empty
success. Only legacy runs whose RunFacts predates `presentation` fall back
to artifact/failure inference. Terminal run detail also carries `runFacts`, read
as the exact validated value from `final/run_facts.yaml`; it is null while the
run is active and for legacy runs without the receipt. Terminal CLI JSON and
JSON-stream output project that same run-detail value, while artifact-only
`claudexor inspect --json` reads the canonical file directly. None of these
surfaces reconstructs shared terminal facts. A malformed HTTP 200 is not a
legacy/missing detail: the CLI validates the response against `ControlRunDetail`
and raises a typed retryable service problem; MCP/ACP keep the terminal handle
and expose a secret-redacted typed detail problem. `summary.webEvidence` and
tool-error rollups are projections of the engine-owned
`final/telemetry.yaml` (the orchestrator is the single evidence owner); runs
that predate that artifact report `available: false` instead of recomputed
guesses. Timeline projections include tool name, target/domain/path, error
summary, severity, harness, attempt, and raw event reference, and are capped
with an explicit truncation marker.

## 8. Artifact Layout

Canonical project output lives under
`~/.claudexor/v3/projects/<project-sha256>/runs/<run_id>/`; no-project Ask uses
`~/.claudexor/v3/runs/<run_id>/`:

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
final/run_facts.yaml
final/telemetry.yaml
final/patch.diff?
final/work_product.yaml?
final/summary.md
final/failure.yaml?
final/answer.md?
final/explore.md?            (legacy deep-scan output; current runs write final/report.md)
final/explore-findings.yaml?
final/omissions.md?
final/report.md?
final/plan.md?
plans/<harness>.md?           (plan mode)
attempts/aNN/events.jsonl?    (read-only modes)
```

`final/telemetry.yaml` (`RunTelemetry` in the schema) is the single engine-owned
record of per-attempt web evidence (requested/effective mode, attempted,
satisfied, status), unrecovered tool errors, non-blocking tool-warning counts,
attempt outcome dimensions, statusless results, adapter-declared transient
failures, and dropped native events. The attempt outcome also carries the D-16
`work_state` axis (the model-attested WorkReport outcome — completed /
needs_input / incomplete / unverified — orthogonal to the process status per
INV-116); the control plane folds the winning attempt's `work_state` into the
run's `outcomeFacts`, so a needs_input/incomplete run is non-applyable and the
outcome-aware CLI exit projection returns non-zero even on a succeeded
lifecycle.
Surfaces project it; they never recompute evidence from raw events or model prose.

`final/run_facts.yaml` (`RunFacts` in the schema) is the canonical immutable
terminal-fact receipt. It binds the terminal outcome, canonical deliverable,
immutable presentation state and primary artifact, role-labelled participant
roster and planner count, configured-gate execution, review blocker ids, apply
eligibility and operator-decision presence, and the typed required actions. A
successful `final/summary.md` receipt may prove presentation is ready, but the
summary is never selected as the model's primary answer; a no-change success is
therefore `ready` with a null presentation primary. The schema-owned invariant validator rejects
cross-axis contradictions before persistence: examples include a succeeded
plan without a deliverable, merge/reviewer roles inflating the planner count,
configured tests presented as both `not_configured` and passed, or required
actions that disagree with the terminal outcome. The orchestrator sanitizes
and validates this object once, embeds that exact value at
`RunTelemetry.run_facts` as a compatibility copy, then writes the standalone
file last as the canonical commit marker. `GET /v2/runs/:id` (`runFacts`),
terminal CLI JSON/JSON-stream output, artifact-only `inspect --json`, MCP
structured results, and ACP `_meta.claudexor` expose the same parsed object
without a second redaction or independent projection. A missing receipt retains legacy-run compatibility; a receipt that
is present but fails parsing or invariant validation is a typed
`run_facts_invalid` server error and never falls back to legacy outcome or apply
authority. Readers also bind the receipt's run/task identity (and terminal
lifecycle where available) to the requested daemon record; copying a valid
receipt from another run cannot make it authoritative.

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

The engine computes reviewer candidate membership once before panel fan-out.
For a Git-backed source it is the union of tracked files, untracked files not
excluded by Git, and exact paths named by the reviewed diff; only the ancestor
directories needed to reach those files are traversed. This retains a tracked
file that later became ignored and an ignored generated file explicitly present
in the diff, while excluding unrelated ignored local notes and their siblings.
The shared sensitive-resource path/content policy remains a final exclusion over
that inventory. Membership follows host path semantics: a literal backslash in
a POSIX file name is never normalized into a directory separator. Without a Git
inventory the candidate plane is limited to diff-touched postimages. The evidence
directory never inherits either rule: it is copied through its own explicit
redacted or sealed-packet boundary. Each reviewer artifact records which
inventory mode was used.

Files are the source of truth. UI and terminal output are projections. The
control API also projects `primaryOutput`, `timeline`, and `budget` from these
files/events so clients do not have to guess which artifact is the main result or
show fake zero spend/quota values.

## 9. macOS App

The UI behavioral and visual contract — the one-screen chat shell, the
composer, the thread workspace (`Changes | Artifacts | Evidence`, plus a
remote-only `Terminal` on remote threads), Settings, and
every interaction rule — lives in [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md), the
macOS UI/UX SSOT. This section keeps only the engine-facing facts.

- The app is a thin native control surface over the control API (§7). It
  consumes: threads and turns (`/v2/threads`, `/v2/threads/:id`, `/v2/threads/:id/turns`,
  `/v2/threads/:id/apply`), runs and events (`/v2/runs`, `/v2/runs/:id`,
  `/v2/runs/:id/events`, `/v2/global/events`), run-internal artifacts (`/v2/runs/:id/artifacts`)
  and produced project outputs (`/v2/runs/:id/produced` — the workspace Artifacts source),
  delivery, decisions, and control (`/v2/runs/:id/apply/check`, `/v2/runs/:id/apply`,
  `/v2/runs/:id/decision`, `/v2/runs/:id/control`,
  `/v2/runs/:id/interactions/:id/answer`), harness status (`/v2/harnesses`,
  `/v2/harnesses/:id/models`), root-scoped Git applicability
  (`/v2/run-applicability`), Accounts/quota (`/v2/credential-profiles`,
  `/v2/quota`), setup jobs (`/v2/setup/jobs`), settings and secrets
  (`/v2/settings`, `/v2/secrets`), and journal recovery
  (`/v2/recovery/partitions/:id` and validate/export/quarantine actions). The
  plan lifecycle rides the normal thread/turn endpoints — a `plan` run surfaces
  typed open questions, and an Implement turn carries `planRunId`; there is no
  separate spec surface or `ModeKind`.
- The app must not invent server state: delivery, decisions, review verdicts,
  routing readiness, setup progress, and budget truth are projections of
  control-api DTOs and run artifacts, never app-local logic. Read-only modes
  expose no patch/apply controls.
- Every app action that can start a turn first freezes one immutable
  `TurnStartTarget`: execution location, project root, existing-thread versus
  draft-create identity, and workspace mode; the effective turn options are
  captured alongside it before the first await. Mouse Send, keyboard Send,
  Implement/Implement anyway, and Plan-answer submission share one admission
  boundary. The attempt then leases one exact
  `GatewayClient` through applicability, thread creation, attachment upload, and
  turn POST; a selection change during an await cannot redirect any later step.
  Remote disconnect/reconnect advances the location generation and atomically
  retires the old client, control forward, streams, and daemon-authored
  projections. Within that turn-start path, each post-await result is accepted
  only for that client/generation, while the explicitly offline thread-summary
  cache remains a separate lifetime.
- Delegate readiness comes from each harness row's engine-owned `delegation`
  projection. Run summaries carry the requested/effective/used/reason/remediation outcome
  and the narrow `delegatedFromRunId` child link. The exact composer and run-row
  presentation is defined in [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md).
- Attachments use a daemon-owned resource pipeline. `/v2/uploads` streams bytes
  to an external temporary file; finalize fsyncs, hashes, deduplicates the blob,
  atomically publishes it, and returns an immutable resource ID. `/v2/runs` and
  thread turns accept only resource IDs. Each adapter declares exact MIME classes,
  finite byte/count limits and a native transport in
  `capability_profile.attachment_inputs`; every explicitly selected lane must
  support every mandatory attachment. The daemon revalidates finalized bytes at
  enqueue and adapters recheck the digest immediately before vendor serialization.
  The macOS staging owner applies that same pool admission to file metadata
  before allocation. One nonblocking descriptor owns the regular-file check,
  size admission, bounded read, and before/after identity plus timestamp
  fingerprint; the current path must still name that descriptor's file before
  publication. This rejects same-size replacement and torn in-place mutation,
  while reading no more than the admitted size plus one byte. The live attachment
  set is rechecked separately at publication.
  Picker/capture staging is an explicit in-flight composer owner: Send remains
  blocked with visible progress until every operation settles, and Cancel
  retires the whole generation so a late read can never enter the next turn.
  A selection-generation lease prevents late picker/capture completion, including
  A→B→A, from publishing private file context into another conversation.
- The agent-driven browser is an engine capability the app merely arms. The
  composer sends user-selected access and web policy unchanged: Browser never
  widens either axis. `browser: true` plus selected `off` stays `web: off` on the
  wire and reaches the engine's existing typed preflight refusal; disarming
  Browser leaves the selections untouched. Only selected values may persist as
  sticky thread preferences. The
  adapter injects the exact lockfile-pinned Microsoft Playwright MCP (codex via stateless
  `-c mcp_servers.browser.*` overrides, claude via `--mcp-config` inline JSON —
  the agent gets the Playwright navigate / screenshot / snapshot browser
  tools) only when the run opted in, the harness declares
  `browser_tool`, web policy is not `off`, and the adapter's existing native MCP
  policy admits the selected access. Claude admits Browser at native
  `workspace_write`; Codex requires explicit trusted `full` and returns a typed
  pre-spawn remediation for Browser at `workspace_write`.
  `RequestRequirementsResolver` records `{eligible, requested, effective,
  reason, evidenceRefs}` for every selected lane. A mixed pool keeps an
  incapable lane participating without Browser (`effective=false`); zero
  effective Browser lanes produce a typed preflight refusal before a harness
  starts. The same receipts project through telemetry, Control API, CLI, and
  the macOS thread workspace, so a missing Browser is never a silent null.
  The runtime is deployed inside the DMG/ZIP and its offline entrypoint is
  build-smoked; no `npx`, runtime package download, or provider credential is
  available to the browser child. The injection is disclosed, the browser runs
  HEADED, and navigation snapshots land in the run artifact tree. Cursor/OpenCode/raw-api report
  `browser_tool: false` (honest — no injector wired).
  Browser RUNTIME evidence (QA-040): adapters normalize browser calls as
  `kind:"mcp"` (there is no `browser` ToolKind), so the attempt-telemetry web
  fold recognizes a browser tool call as trusted live-web activity by matching
  the ENGINE-INJECTED `browser` server namespace only (a user MCP server cannot
  spoof it). A successful browser navigation records
  `web.verification: verified` plus a typed
  `browser: {attempted, satisfied, failed, unused}` receipt; a failed browser
  call remains attributable warning evidence. The separate explicit Browser
  capability preflight is unchanged and still refuses a pool with no effective
  Browser lane before a harness starts.
  An armed-but-unused browser (generic `web_search` satisfied instead) is
  disclosed as an unused-browser flag on that receipt — disclosure only, never a
  run failure.

### Remote SSH execution

Release `3.8.0` is an owner-authorized one-release publication exception: its
GitHub Release omits `runtime-manifest.json` and
`remote-runtime-manifest.json` rather than shipping unsigned substitutes.
Consequently, an existing app cannot update its engine in place to that
version, and the app cannot perform a first-time remote bootstrap from it.
Fresh signed/notarized app installs, npm packages, and reviewed exact-pin
embedders remain usable; the normal signed-manifest design below stays
fail-closed for non-exempt releases.

The macOS app can bind a thread to a remote execution location. A location is
either `local` or a stable app-owned connection UUID backed by one concrete
alias from `~/.ssh/config`; a materialized thread is permanently identified in
the UI by `(locationId, threadId)` and keeps the project root chosen when it was
created. Choosing another host or folder starts a new draft—it never migrates a
thread or worktree between daemons.

The app delegates transport and authentication to `/usr/bin/ssh`. It parses
concrete `Host` entries (following `Include`), asks `ssh -G` for the effective
configuration, and creates an app-owned ControlMaster per connected host.
Settings can also create a host: the app appends a plain `Host` block (alias,
`HostName`, optional `User`, `Port`, `IdentityFile` path) to `~/.ssh/config` —
append-only after a timestamped backup, refusing duplicate or pattern aliases
and any multi-line value, creating the file `0600` (and `~/.ssh` `0700`) only
when absent and never re-moding an existing one. The block is exactly what the
user would type by hand; keys, passwords and tokens still never pass through
Claudexor. Batch-mode connection is attempted first. Host-key confirmation,
passwords and MFA run only in an ephemeral SwiftTerm PTY backed by the same
system SSH binary. Terminal output, SSH input, bearer tokens and vendor
credentials are never persisted.

Each host runs the complete Claudexor engine next to its repository and harness
CLIs. A signed `remote-runtime-manifest.json` binds the version, build SHA,
protocol major, minimum app version and SHA-256 for four archives:
`linux-x64`, `linux-arm64`, `darwin-x64`, and `darwin-arm64`. Each archive
contains the release-built CLI/daemon/setup/browser closure and the exact Node
version pinned by `.node-version`; official Node archive digests are pinned in
`scripts/remote-node-sha256.json`. The JS and Swift verifiers reject unknown
manifest or asset fields before signature verification, so an unsigned extension
cannot ride beside the explicit cross-language signing projection. The app verifies Ed25519 and archive SHA-256,
uploads through SSH, probes a staging directory, and atomically switches
`~/.claudexor/remote/current`, retaining `last-known-good` for rollback. No
remote installation uses `sudo`. A newer compatible runtime is never
downgraded; an incompatible older runtime is updated before use. One opaque
activation lease is claimed before the install actor's first SSH suspension and
owns the candidate through the tunneled daemon handshake. Commit and rollback
accept only that exact lease; another install cannot replace it, and a rollback
failure remains visible instead of being swallowed. If the mutating SSH response
is lost, the exact candidate/previous payload remains `uncertain`: recovery must
observe the candidate and roll it back, prove and restart the previous closure,
or stay visibly blocked. An unreadable pointer is never collapsed into a proven
absent pointer. Both forward activation and rollback call the serving closure's
internal runtime-replacement stop before changing `current`: a late run or setup
admission returns a typed retryable refusal and leaves the working pointer
untouched. The stop request binds the freshly observed version/build SHA and
writer-lease owner in the same synchronous turn as admission fencing; a stale
handshake, missing lease, boot-window lease without a socket, or legacy
unbound receipt can prove only passive exit and never grants kill authority.
Every reconnect then binds one exact chain before publication: the
current-pointer probe, bootstrap closure, bootstrap-disclosed engine, tunneled
Control handshake, and final current-pointer probe must agree on the runtime
identity. Activation commit additionally rechecks the lease-owned pointer target.
Once that exact commit succeeds, a later final-probe mismatch is treated as a
newer external pointer transition and fails the reconnect without rolling it
back through the settled lease.

Vendor harness CLIs land on a host only through the disclosed installer
(`claudexor harness install`, reachable from Settings → Harnesses for a
connected host). The npm-distributed harnesses (claude, codex, opencode)
install one EXACT pinned version — each pin aliases that harness package's
vendor-version constant, and npm checks the registry integrity checksum for
that exact version; `@latest` is never used. For claude and codex that
constant is the same value the model-hints and effort freshness gates read,
so the installed CLI is the version this release was verified against; the
opencode pin is a deterministic install target, not a verification claim —
no recorded fixture covers it yet, as its `vendor-cli-version.ts` discloses.
Cursor ships no npm artifact and cannot be pinned:
its vendor script is downloaded in full (`curl --fail`, never piped to a
shell), its size and SHA-256 are printed, and it executes in the visible
embedded PTY where the operator watches it — the human is the verifier, the
same principle as interactive SSH auth. Nothing installs without disclosure:
the CLI prints the exact package/version/destination install recipe
(`~/.claudexor/remote/vendor/bin`, which the remote wrapper puts first on
PATH) and requires a TTY confirmation or an explicit `--yes`, and the macOS
confirmation dialog shows the remote CLI's own `--dry-run --json` disclosure
verbatim before opening the terminal sheet, including the typed evidence class
(`release_verified`, `deterministic_only`, or `human_observed`) that selects the
same honest pin wording as the CLI. Failures are typed and loud — a
failed or unreadable download refuses without executing, a non-zero installer
exit never reads as success, and Harness Doctor verifies the result
afterward. Every npm, curl, and vendor-script child receives the shared minimal
runtime environment, including proxy and trust settings but no provider
credential variables.

The installer recipe producer also accepts the explicit `local` target used by
host integrations. Npm harnesses then install under the existing managed Node
root (`~/.claudexor/node/bin`), which is already shared by local resolution and
native harness PATH resolution; Cursor keeps its vendor-selected destination,
and normalized harness discovery covers both `~/.local/bin` and
`~/.cursor/bin`. An explicit `--target local --yes` is suitable for an
unattended Connect action that already carries the user's authorization. Cursor
is still unpinned in that flow: the typed evidence class is
`unattended_unpinned`, and the execute receipt records the exact downloaded
script's SHA-256 and byte length rather than claiming human observation. Local
installs take a user-scoped cross-process lease and recheck both the exact npm
pin and its target-contained, non-empty launcher under that lease before
mutating the shared prefix; a partial package without its shim is repaired.
Before any success receipt, the absolute launcher must execute `--version` and
prove the exact npm pin. Cursor similarly rechecks the supported `cursor-agent`
name through the target-aware normalized harness PATH, permits the vendor's
official launcher symlink layout, and records its bounded non-empty version
line. Child exit zero without this proof is the typed
`install_verification_failed` outcome. A live owner gets a bounded wait. A dead
or old owner-less lock fails closed as `install_lock_stale` with the exact lock
path and a verify/remove/retry remedy; waiters never rename an observed stale
pathname because a new owner could have replaced it between observation and
mutation. An unexpected filesystem or child-process exception is normalized by
the canonical CLI projector as `harness_install_failed`; JSON mode still emits
one object containing the full pre-execution disclosure.
Local Windows installation is a typed `unsupported_platform` refusal before
filesystem or child-process side effects. The omitted target remains `remote`,
so the SSH installer's
visible disclosure, confirmation, command, destination, and precedence
contract are unchanged. After any successful local install, the embedding host
must request the existing fresh doctor/status projection before retrying login;
it must not trust a pre-install readiness cache, and this needs no new setup-job
or daemon API.

`claudexor remote bootstrap --json` starts or discovers the remote daemon and
returns its loopback endpoint. The daemon remains bound to `127.0.0.1`; the app
opens a local SSH forward and keeps the bearer token only in the in-memory
`GatewayClient` for that location. Every thread/run/settings/setup request and
both global/run SSE streams use that owning client. The unified sidebar stores
only location-tagged thread summaries with a last-sync timestamp under
`~/Library/Application Support/Claudexor/` (directory mode `0700`; metadata
files mode `0600`); transcripts and artifacts are fetched after reconnect.

Remote project browsing uses the home-contained directory endpoint, which
lists only visible (non-hidden) directories and refuses to descend into dot
trees — file names and hidden names are never disclosed, and every refusal
(absent, outside home, not a directory, hidden) is one constant typed answer
so the endpoint is not an existence oracle for the names it hides. Remote
image links use the registered-project-scoped, size-capped file endpoint:
content type is identified by magic bytes, never by file name — a
non-matching file is refused before its content is read, while a matching
file's remaining bytes are served verbatim (the sniff authenticates the
header, not the whole container). Both endpoints are wired only into the
remote runtime — a local daemon never serves them.
Shells, daemon-log tails and `client_pty` setup attachment use the system SSH
PTY; Codex device login stays a typed setup-job UI. Preview creates a
short-lived forward from an ephemeral local port to the requested remote
loopback port and closes it with the preview. On app termination all
ControlMasters and forwards close, while the remote daemon and durable jobs
continue.

### Engine runtime updater (M7, D22/D23)

The mechanism below is the normal release contract. The version-specific
`3.8.0` exception documented above deliberately has no signed manifest assets,
so clients refuse rather than weaken this verifier.

The app updates its **engine runtime closure** in place without a new DMG. The
update unit is a `claudexor-runtime-<version>.tar.gz` containing the engine-owned
resources: the bundled daemon, the setup-login runner, the Browser MCP
deployment, the native process-identity helper, and the reviewed operator CLI
used by embedding hosts. App-owned Node, UI, and icons stay outside the
closure, so a Node bump ships a new signed DMG.
Each release also publishes a **signed** `runtime-manifest.json` built straight
from the signed app bundle by `scripts/build-runtime-closure.mjs`. The builder materializes
internal package links into regular files/directories, rejects links escaping
their closure entry, special files, and `.node` addons, and suppresses macOS
AppleDouble sidecars. The shipped file bytes therefore come from the exact app
resources the release gates smoke-tested while the archive itself needs no
POSIX symlink semantics.
`release/runtime-min-app-version.json` is the tracked `minAppVersion` floor
(validated `<=` the release version by `scripts/verify-version-parity.mjs`), the
app-vs-engine skew guard.

**Host-owned embedding.** A non-app host reuses this SAME release archive; the
existing signed manifest remains its upstream publication authority. There is
no embed-only payload, manifest, updater authority, or runtime npm install. The
portable archive root is fixed:
`claudexord.bundle.cjs`, `claudexor.bundle.cjs`,
`setup-login-runner.cjs`, `browser-mcp-runtime/`, and
`native/claudexor-process-identity` plus
`native/claudexor-conpty-helper.exe`. It deliberately contains no Node runtime.
A host owns the install directory, config root, process, rollback, and exact
reviewed pin. Its full Node toolchain is the exact version proven by that pin's
closure smoke; POSIX consumers using local harness install must provide both
`<node-root>/bin/node` and
`<node-root>/lib/node_modules/npm/bin/npm-cli.js`, with no ambient-PATH npm
fallback. The root package's
`engines.node >=20.19.0` promise covers the npm distribution and does not by
itself prove a release-built `--target=node22` closure on Node 20. The pin also
carries protocol major 3, separate daemon and CLI entrypoints, expected archive
size, and the accepted `{version,buildSha,sha256}`. The signed
`runtime-manifest.json` is the
upstream publication authority used to form that pin. A host MAY verify it
directly against the runtime-update authority, or a review-bound consumer may
ship only the exact URL/build SHA/SHA-256/size pin and verify the downloaded
archive against it; it need not add a second Ed25519 verification path. Neither
mode reinterprets the app-only `minAppVersion` as a host compatibility promise
or follows `latest` without review.

The lifecycle handshake is intentionally tiny. Before activation, run
`node claudexord.bundle.cjs --probe` and require the single JSON line's exact
`version` and 40-character `buildSha` to match the publication identity in the
manifest or its derived host pin. Current probes additionally advertise the
additive `roles:["setup_attach"]` marker; its absence remains readable as an
older closure without packaged external-terminal recovery, while unknown roles
are ignored.
Before replacing a live closure, run the SERVING closure as
`node claudexord.bundle.cjs --stop <observed-version> <observed-buildSha>` and
require its typed stopped receipt; busy or unknown refuses the swap. The daemon
start, handshake, and stop subprocess MUST receive the same
`CLAUDEXOR_CONFIG_DIR` and, when set, `CLAUDEXOR_DAEMON_SOCK`; otherwise a stop
can truthfully report `alreadyStopped` for the wrong root while the embedded
daemon remains live. The Darwin process-identity helper remains a regular inert
extra off Darwin: `ProcessIdentityService` executes it only on Darwin. The
link-free archive removes a POSIX-symlink requirement, but Windows support is
claimed only after the consumer's native extract/exact-Node `--probe`/isolated
handshake/graceful-`--stop` smoke. Setup/login and harness capabilities retain
their separately documented platform gates. An embedder needing isolation from
the operator's global daemon uses its own `CLAUDEXOR_CONFIG_DIR` rather than
replacing another owner's process.

**Signed-manifest authority (D-2).** The manifest is signed by a DEDICATED
offline Ed25519 runtime-update key, SEPARATE from the review-attestation key and
pinned in `release/runtime-update-authority.json`. There is ONE canonical
manifest contract — the release-tooling mirror
`scripts/lib/runtime-manifest-contract.mjs` and the in-package TS contract
`@claudexor/util` (`runtime-manifest.ts`) emit byte-identical canonical signed
bytes (bound by a parity test), and the Swift updater
(`ClaudexorKit/RuntimeUpdate.swift`) verifies the same bytes with CryptoKit,
locked by cross-language fixtures (`Fixtures/runtime-update/`, TS signs → Swift
verifies). The signed bytes cover `{schemaVersion, version, sha256,
minAppVersion, archiveName AND archiveUrl (both bound to version), buildSha,
notes, keyId, algorithm}` — the URL binding (D-2) means the installer refuses to
download unless the release asset URL it resolves EQUALS the signed `archiveUrl`,
so a tampered release listing cannot redirect the download even though the
sha256 would still be checked. Anti-replay is the signed `version` plus the
installer's strict monotonic check (never install a version ≤ current or
last-known-good). Both the
Swift updater AND `claudexor release check` verify FAIL-CLOSED: an unsigned,
unknown-key, tampered, or version-regressed manifest is refused, never surfaced
as an available update. Exact-artifact promotion (A-5): the candidate release
workflow builds the closure + an UNSIGNED manifest and uploads them as an
immutable run artifact; the owner signs the manifest OFFLINE against that exact
digest (`scripts/sign-runtime-manifest.mjs`, external 0600 key, refuses unstamped
fields and refuses unsigned extension fields in every verifier); every offline signing ceremony opens its key with no-follow semantics
and requires a same-user regular file with exact mode 0600 before reading bytes.
The publish workflow takes the candidate `run id` + the signed manifest
as inputs, `download-artifact`s the candidate run's EXACT closure bytes (never a
publish rebuild), verifies their build provenance, and `scripts/verify-signed-
runtime-manifest.mjs` refuses to ship unless the signature verifies against the
pinned key, its `sha256` byte-matches the promoted tarball, and its non-secret
fields equal the candidate's unsigned manifest — so the shipped closure is
byte-for-byte the reviewed one. A wrong or expired (14-day retention)
`candidate_run_id` fails the download. `scripts/release-workflow-check.mjs`
enforces this wiring; the two authority files (review vs runtime-update) can
never be the same key. The same A-5 boundary covers the release application:
publish verifies and promotes the candidate DMG, ZIP, and SBOM byte-for-byte;
only the signed runtime manifest, review attestation, and final checksum set are
created by the publish run.

**Install flow.** One click (bottom-left chip → Install) runs
`RuntimeInstallCoordinator` (`apps/macos/ClaudexorApp`): verify monotonic →
download the closure from the release CDN asset URL → sha256-verify against the
signed manifest → FULL unpack to `versions/<version>/` → re-verify → strip
`com.apple.quarantine` (after hash verification) → probe-start the unpacked
daemon with the app-bundled Node via `claudexord --probe` (prints
`{version,buildSha}` and exits without binding a socket or opening the journal) →
require that exact pair to equal the signed manifest → claim one process-session
lifecycle lease shared with steady daemon reconciliation before the first async
install step → advisory idle probe (cheap early deferral) → daemon-atomic
runtime-replacement admission (`claudexord --stop`: synchronously prove no
queued/running run or active setup job and fence every ingress; busy/unknown
refuses without stopping; the request names the freshly observed serving
version/build SHA and writer-lease owner) → identity-proven termination
confirmation with no-successor proof (never a raw kill) → ATOMIC `current.json`
swap (write a temp file + a single rename, inside a `flock` over the whole
check-then-swap critical section) → relaunch → handshake-verify the new engine
identity against the signed manifest → rollback to `last-known-good.json` on
ANY failure, accepting recovery only when the prior exact identity returns.
Rollback authority comes from the same launcher selection: current.json's exact
`{version,engineSha}` for an installed closure or the app-signed bundled script's
stamped probe. If that authority is unavailable, installation refuses before it
stops the daemon. The bundled runtime
stays the final fallback (the launcher already falls back on an invalid/absent
pointer). The daemon-lifecycle side effects are behind a `RuntimeDaemonControl`
port so the whole sequence, including rollback, is exercised offline against a
locally-served fixture closure.

**Native addons & entitlements.** The bundled Node ships
`NodeRuntime.entitlements` with `com.apple.security.cs.disable-library-validation`
and `allow-unsigned-executable-memory` (V8 JIT, mirroring Apple's notarized
Node). That means a `.node` C++ addon dlopen'd into the bundled Node would load
even though the runtime-update closure is not part of the app's code signature —
so the integrity of any closure-carried native code would rest ENTIRELY on the
signed-manifest sha256. As defense-in-depth the closure is kept pure JS + the
standalone process-identity helper (a SEPARATE spawned executable, not a dlopen
target — quarantine-stripped after verification, so library validation never
gates it), and `build-runtime-closure.mjs` FAILS if any `.node` file appears in
the closure.

- **Layout.** Runtimes live under `~/.claudexor/runtime/versions/<version>/`
  (directly under `~/.claudexor/`, NOT under `v3/`); the active one is named by
  `runtime/current.json` (version + path + sha256 + engineSha), and
  `runtime/last-known-good.json` is the rollback target. `DaemonLauncher`
  resolves the daemon script through `current.json` ONLY when it passes the
  QA-073 containment guard (`RuntimeInstaller`'s `containedDaemonScript`): the
  pointer path must be exactly `versions/<version>`, resolve with no `..` and no
  symlink escape out of `versions/`, and name a REGULAR file — otherwise it
  falls back to the bundled `Contents/Resources` path. A contained pointer wins
  only when its semantic version is strictly newer than the app bundle; an
  equal-version pointer also falls back so a newly installed DMG cannot retain
  different bytes under the same version. On connection, the app side-effect-
  free probes the selected script and compares its exact `{version, buildSha}`
  with the live handshake before hydrating daemon state. A mismatch is replaced
  only after the daemon atomically proves idle and fences admission; busy or
  unknown activity keeps the compatible daemon alive and visibly defers
  reconciliation. A successful replacement retires the old client and re-reads
  discovery before hydrating;
  any failure after lifecycle work begins goes offline rather than reusing an
  ambiguous process. An installed selection's probe must also equal the pointer's
  exact `{version,engineSha}` authority; the signed bundled selection uses its
  stamped probe as authority. The three-second identity poll retries deferred
  work when the daemon becomes idle. Reconciliation and in-app installation
  claim the same exact session lifecycle lease before their first suspension,
  so their stop/start transactions cannot overlap. Node is ALWAYS the
  app-bundled binary; because the
  whole closure unpacks together, the Browser MCP resolves adjacent to the
  daemon inside the same version dir.
- **Check flow** (foreground / bottom-left chip / Check for Updates — no timer):
  GET the latest release manifest (`api.github.com`, ETag-cached) → verify the
  signature fail-closed → compare `version` to the running engine and gate on
  `minAppVersion` → surface "Update available → vX.Y.Z" with an Install action.
  There is no background update timer.
- **Build-sha stamping (QA-002).** `build-app.sh` stamps `CLAUDEXOR_BUILD_SHA`
  into the esbuild daemon and CLI bundles via `--define`, and
  `build-runtime-closure.mjs` embeds the SAME sha in the manifest and refuses to
  ship either unstamped bundle, so
  the daemon handshake discloses a real `engine.sha` in packaged builds (bundled
  and downloaded closures are stamped identically) instead of "unknown".
- **Engine side.** `claudexor release check` handshakes the running daemon for
  its authoritative engine version and compares THAT to the manifest (no daemon
  reachable → the engine is reported unknown and the CLI package version is
  compared honestly, never relabelled as the running engine). The check never
  starts a daemon. Its guidance is accurate to what ships: the macOS app offers
  an engine update flow, and npm users update the CLI with `npm install -g
  claudexor@latest`. `claudexor release stats` is the owner-facing install
  counter (D23) — GitHub asset download counts + the npm downloads API, zero
  infra, no telemetry, no ping. Both hit the network only when invoked.

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

- The delegation belt (`agent --delegate`) has NO apply/decision/thread/settings
  tool: the parent integrates sub-run results in its own workspace, so a
  delegated sub-run adds no new live-tree mutation path. Sub-runs are isolated
  envelopes (forced no-thread), depth is capped at 1, and all family reservations
  and settlements cross one daemon-owned parent budget authority. Child detail
  exposes only the child's spend; the parent detail exposes the aggregate.
- Planning rides the normal thread/turn path (the spec-interview state machine
  and its in-process grounding runs were retired in v3): a `plan` run surfaces
  typed open questions, answer turns refine it on the same persisted lane, and
  Implement freezes it as a content-hashed brief. There is no separate spec
  surface, spec-session store, or grounding-run job class.
- `--json` mode guarantees exactly one JSON object on stdout; interactive TTY
  question prompts (follow/agent Q&A) remain human-text affordances by design.
  Canonical run paths normalize argument/usage validation, pre-daemon bootstrap
  (e.g. `EPERM` on `fchmod`), typed preflight/daemon problems, transport errors,
  and unexpected exceptions through the ONE top-level projector
  (`packages/cli/src/cli-error.ts`) into
  `{ok:false, exitCode, code?, message, retryable?, fieldErrors?,
  requiredActions?, details?, context?}` (with a legacy `error` alias of
  `message`), generated from the SAME typed problem as the human stderr line.
  Some subcommands and pre/post-run paths retain purpose-built one-object
  schemas; their exact bounded residue is tracked as D-7 in `docs/BACKLOG.md`.
  A projector-owned run-scoped failure
  (inspect/apply/decision) may add a
  per-command identifying field such as `runId` alongside those canonical
  fields, but the projector-owned fields always win over a same-named extra, so
  the failure shape cannot be forged. Redaction runs BEFORE the bounded-context
  truncation, so a secret token straddling the truncation boundary is masked on
  the full string and can never leak as a surviving head fragment. A central category → exit-code table owns the codes: usage /
  validation = 2, operational failure = 1. Typed domain codes and structured
  field errors survive projection (never a serialized Zod object inside
  `message`, never a secret echoed back, never empty stdout under `--json`);
  a typed `ControlProblem` from the daemon is preserved intact, with any
  localized git/tool stderr demoted to a bounded `context` evidence field. The
  run-verb SUCCESS envelope (`{runId, runDir, status, ...}`) is byte-stable and
  does NOT flow through the projector. Binary/opaque success payloads stay one
  object too: `project outputs <id> <path> --json` returns the bytes as base64
  inside `{ok:true, path, encoding:"base64", byteLength, content}` rather than
  streaming raw bytes onto the JSON stdout. `claudexor <cmd> --help` resolves
  the command first and prints that command's scoped usage (a typo'd verb with
  `--help` is a usage error, exit 2), never the global help at exit 0.
- `--json-stream` is the separate NDJSON machine surface on canonical run
  verbs: an early `run.started` frame (runId/runDir/jobId), one JSON line per
  run event (internally the shared follow pipeline in json mode), and the same
  terminal object `--json` prints as the LAST line. It never changes the
  `--json` exactly-one-object contract, and the retired `run` verb stays
  retired.
- Vendor-owned quota snapshots and typed rejecting rate-limit cooldowns persist
  in the checksummed global journal through `QuotaRegistry`; routing reads that
  cross-run authority rather than rediscovering pressure independently in each
  run. Codex uses its app-server. Claude subscription windows arrive from the
  `oauth/usage` endpoint as the PRIMARY source (since 2.1): the daemon's
  refresher reads each logged-in config dir's OAuth token transiently —
  every claude `config_dir_login` row (subject = its profile id), plus the
  legacy default native dir (subject null) only while that store is
  UNMIGRATED — and a failing endpoint yields NO
  snapshot, never degraded auth. The user-scoped status-line payload
  (installed explicitly by the Claude host-plugin lifecycle) remains a
  SECONDARY source for the legacy null subject only; its collector stores only
  allowlisted windows in the external v3 root and composes/restores any
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
  by delimiters (never as governance), bounded to that block: once it contains
  any recognized `[single]`/`[multi]`/`[text]` bullet the block is STRUCTURED,
  so only tagged bullets (and a terminal `(none)`) are questions and the first
  nonconforming top-level bullet ends the set (QA-016 — an adapter that appends
  ordinary todo bullets after the tagged block, such as Cursor's empty-`planUri`
  recovery, can no longer fabricate owner questions). A wholly-untagged block
  keeps the tolerant legacy degradation to free-text/single-choice questions;
  output with no parseable block is an `unverified` readiness. No shape fails
  the plan run.
- Startup crash GC sweeps orphaned envelopes only under project roots recorded
  in the daemon command journal; envelopes created by CLI/MCP/ACP runs
  in roots the daemon never saw are reclaimed only by their own process.
- Web use is optional under `auto`, `cached`, and `live`; no
  did-this-task-NEED-web resolver or mandatory evidence gate is inferred from
  those policies. `off` remains the only strict external-context policy.
- Read-only flows never materialize a Git boundary, capture a patch, or emit a
  patch WorkProduct. An isolated thread reuses its worktree only after a mutating
  turn has already materialized it; otherwise it reads the stable project.
  Git-backed write envelopes initialize per INV-075 and the implemented live
  Agent convergence path keeps its non-Git copied baseline.
  A root equal to the user home directory or a filesystem root — or one that
  cannot be classified — is refused with the typed `git_boundary_root_refused`
  error before any mutation instead of being initialized (INV-075 exception);
  ordinary non-git roots keep the announced auto-init.
  If exact capture or reversal cannot be proven for an explicit in-place run,
  Claudexor fails closed with a sanitized `manual_cleanup` receipt; it never
  substitutes an empty diff and asks reviewers to trust the live tree.
  Presentation remains capped at 200 kB only after the full text diff has crossed
  the secret fence.
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
  override). CLI harnesses (agy/claude/codex/cursor/opencode) discover
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
- `claudexor profiles login` for non-codex harnesses deliberately spawns the
  vendor's own login command IN the operator's terminal (no daemon setup
  job): vendor OAuth needs the user's TTY/browser interactively, and the
  binding's Claudexor-owned HOME/config root scopes vendor state. Credential
  custody remains platform-defined and may be OS-user-owned; Claudexor neither
  reads nor copies it. There is no daemon setup receipt to journal, and the
  post-exit vendor doctor probe under the exact binding environment is the
  verification truth (exit code non-zero unless the probe passes). Codex
  profile login is the D-17
  exception: it rides the SAME durable app-server device-code setup job as
  the default codex login (restart-surviving runner, transient sidecar,
  in-app/inline code disclosure), because the app-server flow needs no TTY. The daemon-owned setup jobs remain the path for
  non-interactive/GUI-driven logins.
