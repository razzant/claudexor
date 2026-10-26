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

Ordinary Agent model review is opt-in. `review: true` (`--review`) requests the
automatic panel; explicit reviewer panel/model/effort controls request it too.
Best-of and until-clean retain review. Capped `attempts` defaults to review but
allows explicit `review: false`; the ordinary GUI Single uses that form with
its existing three-attempt cap. Executor selection never determines review.

### Delegation belt (`agent --delegate`, D32)

`--delegate` (agent-only) injects a SCOPED Claudexor MCP belt into the harness
sandbox — the generalized `HarnessRunSpec.extra_mcp_servers` seam translated per
adapter (claude `--mcp-config` inline JSON, codex `-c mcp_servers.<name>.*`,
cursor a reconciled `mcp.json` in the Claudexor-owned lane `CURSOR_CONFIG_DIR`
plus `--approve-mcps` — a run without `extra_mcp_servers` removes any
previously Claudexor-managed entries so a stale belt never rides a
non-delegate run, and the host `~/.cursor` is never written).
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
whose `capability_profile.mcp_injection` is true (claude, codex, cursor) can host the
belt. `HarnessStatusDto` and the agent capability catalog carry one derived
`delegation` projection (`available`, typed `reason`, remediation, and the access
requirement), so CLI, Control API, and macOS consume the same readiness truth.
The flag is permission, not a child-count promise: current top-level summaries
record `delegation {requested,effective,used,reason,remediation}`; the field is
nullable when reading legacy artifacts that predate this receipt. A known pre-injection
runtime, manifest, or access incompatibility may continue as an ordinary Agent
run with `effective:false` and a durable warning. An MCP startup failure AFTER
the descriptor was injected is terminal and never silently degrades on
adapters with a startup receipt (claude's `mcp_servers` init frames, codex's
required-MCP failure frames); cursor has NO post-spawn startup receipt yet —
its injection failures refuse typed pre-spawn only, and closing the post-spawn
gap is the recorded acceptance condition on its `docs/FEATURES.md` row. An
unrecovered non-ok result from an exact injected belt tool likewise hard-fails
the Agent outcome; the Delegate receipt still says `used:true` because it records
which path ran, not whether that operation succeeded. An isolated-envelope
deliverable remains diagnostic and cannot be auto-adopted. If an explicitly
Git-backed in-place lane already changed the live tree, the failure first emits a durable
`adopted:true`, `applied_review_blocked` WorkProduct with pre/post snapshots and
a revert anchor, then emits the failed terminal; this records unavoidable live
bytes honestly without treating them as reviewed success. Direct directory
effects instead use the [file-result contract](#directory-execution), with no
unproved revert anchor. Secret-like output takes no exception on this path:
the live bytes stay where the harness wrote them, the WorkProduct and its revert
anchor are recorded as for any other turn, and INV-062 hides the matches only in
the persisted and served copies (see
[Secret-like output: keep and mask](#secret-like-output-keep-and-mask)). The one
remaining capture-time refusal is a capture that could not observe the changes
at all; it is recorded as `capture_refused` with `applied_review_blocked` and no
anchor, never as a rollback. In a mixed
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
- `packages/harness-codex|claude|cursor|opencode|agy|acp|raw-api|fake`: adapters that
  translate native CLI/API streams into typed `HarnessEvent`s. The `fake-*` kinds
  are deterministic offline test fixtures (incl. `fake-implement`, which writes a
  real worktree file); they are explicit-`--harness` only and never enter
  auto/reviewer pools.
- `packages/workspace`: Git-backed disposable candidates use private shared-clone Git
  authority; explicit directory workspaces use a selected live folder or a
  complete copy of the selected input footprint. Git-backed persistent threads
  materialize git worktrees on their first
  mutating turn (read-only turns reuse one if present); scoped harness homes/
  config dirs for write envelopes and read-only routes via `readOnlyHomeEnv` keep
  relocatable, route-local state outside both the worktree and the operator's
  home. An in-place run normally keeps the native environment so its vendor
  session stays resumable; a run marked `execution.delegated` (started by an
  external orchestrator that owns the workspace) is scoped even in place, and
  refuses rather than starting a harness in the operator's home. The in-place
  candidate of a delegated thread's turn uses that thread's durable lane home
  instead of a per-attempt one (below).
  A selected native Codex route uses its Claudexor-owned file-only profile;
  native Claude also uses a Claudexor-owned config dir and exposes only the
  narrow host Keychain bridge described in §5. The package also owns Git diff
  capture, digest-bound directory manifests and
  content, per-file application, and path-safe disposal.
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
- `packages/delivery`: patch check/apply/commit/branch/PR delivery, copied-file
  verification and application, and the
  single-owner apply gate.
- `packages/artifact-store`, `packages/event-log`: run artifact tree and
  append-only event log writers.
- `packages/control-api`: loopback HTTP/SSE facade over daemon and run artifacts.
- `packages/daemon`: the durable local queue (Unix socket on POSIX, named pipe
  on Windows), its in-process facade client, and one SQLite engine store for
  commands, projects, threads and logical event ledgers. SQL state tables are
  the projections; addressed queries hydrate only selected bodies. The existing
  quota and setup reducers replay selected SQL event rows. The importer alone
  uses the read-only frame/intent reader under `store/legacy-journal/`; writable
  journal serving and compaction are retired. The frozen legacy implementation
  remains test-only. See [SQLite engine store](#sqlite-engine-store) for commit,
  retention, migration and recovery semantics.
- `packages/cli`: thin command surface plus local host-integration lifecycle
  (`claudexor plugin`) for generated Claude Code/Codex/Cursor/OpenCode
  skill/MCP artifacts and commands; portable distributions live under `plugins/`. Plugin
  lifecycle state is user-level local setup state, not a control-api
  contract.
- `packages/claudexor`: the bare-name npm bin wrapper — `claudexor` and
  `claudexord` bins that import `@claudexor/cli`'s explicit entry exports;
  the published global install (`npm install -g claudexor`) and the ONE owner
  of the global bin names.
- `packages/mcp-server`, `packages/acp-server`: thin protocol surfaces. The
  MCP server rides the official TypeScript SDK v2 (concurrent dispatch, era
  negotiation down to 2024-10-07, schema-validated arguments, elicitation);
  all three run modes enqueue through the daemon `/v2` control API. Until MCP
  Tasks stabilize, MCP returns a durable run handle and exposes explicit
  status/result/cancel/interaction tools; launch calls do not wait for terminal,
  return the accepted job (queued or bound) as the handle, and the server does
  not advertise Tasks. One-shot launches and MCP
  persistent-thread create/turn pass an optional caller key
  to the daemon's existing idempotent command authority; read projects its
  thread detail
  without starting a run or a daemon. Existing-run wait, event-part, live-message
  and continuation controllers project the same daemon authority; their bounded
  observation and receipt contracts live in [MCP controls](INTEGRATIONS.md#observing-and-directing-an-existing-run).
  ACP uses the official TypeScript SDK at stable protocol v1;
  its session IDs are daemon thread IDs and list/load/resume/close/prompt/cancel
  all project the same `/v2` thread authority. ACP images and embedded resources
  are finalized through the daemon attachment pipeline before a turn enqueues.
- `packages/canary`: canary golden stories — user-level E2E smokes over the
  BUILT CLI with offline fake harnesses, each pinned to a Bible invariant
  tag (`pnpm canary`; runs in CI on every PR). The shared fixture pins the built
  daemon entry and its own endpoint. Disposal removes its root only after the
  writer lease proves absence or a stale owner; a failed stop or live/unknown
  successor retains the root and cleanup diagnostic.
- `benchmarks/runner`: the SWE-bench Verified benchmark runner (predictions
  via the Claudexor CLI; see `benchmarks/`).
- `apps/macos`: native app; displays/edits what the engine exposes.

Adapters translate native I/O into `HarnessEvent`s. They do not select winners,
manage budgets, decide review policy, or orchestrate.

Host integrations are generated translational artifacts: Claude Code, Codex,
Cursor, and OpenCode files point at the local CLI/MCP server and carry ownership
markers for safe repair/uninstall. They do not route work or duplicate
orchestration logic.

The schema-owned `ExternalHostBinding` is optional local integration state in
the existing plugin `HostState` ledger. `plugin-runtime.ts` projects one argv
prefix and environment into MCP, shell fallbacks, doctor and Claude statusline.
An installed canonical MCP source addresses its ledger even when repair runs
from another CLI/root; host caches remain host-owned copies. `daemon-owner.ts`
validates explicit lifecycle ownership, and `ensureDaemon` attaches before
token/root creation when ownership is external. The same existing connection
retains recovery-only mode. Delegate lineage is independent of this connection
policy. Registration and compatibility are documented under
[externally owned host integrations](INTEGRATIONS.md#externally-owned-host-integrations).

### External-orchestrator workspaces and native access

`execution.delegated` marks a run whose external caller owns the mutable
workspace; it is independent of the `agent --delegate` belt. For a
project-scoped delegated Agent with `execution.isolation: live`, `scope.root`
is the stable project identity used for registration, configuration, trust,
TaskContract, artifacts, and history. `execution.workspaceRoot` is the
one-shot absolute existing directory used as the `executionRoot` field on
`RunInput`, so the
harness cwd and workspace operations happen only there. Every new mutating
delegated-live request must supply it and never falls back to `scope.root`.
Read-only requests may omit it. Exact Retry revalidates a frozen new-shape
workspace; the bounded legacy no-field replay retains its historical
`scope.root` execution semantics.

A persistent delegated thread binds that execution address once.
`POST /v2/threads` with `workspace: "delegated"` requires `workspaceRoot` (and
accepts it only then) on a project scope; it must be an absolute existing
directory, kept in the spelling sent. The thread persists it as
`workspace.workspace_root` (projected as `workspaceRoot`), separate from the
managed `worktree_path`; no PATCH or turn field can change it. An exact
creation replay is answered from retained, registered project partitions before
checking the project or workspace path again. The existing startup ghost-project
quarantine can unregister a missing author root and remove its partition from
this lookup; replay after that retirement is not guaranteed. Before a turn's
command is accepted, the turn route
records the effective execution in its params: Agent turns carry
`{delegated: true, isolation: "live", workspaceRoot}`, while Ask and Plan keep
their ordinary isolation and readonly clamp and carry the same delegated root
(the shared normalizer admits `workspaceRoot` for a delegated project-scoped
read-only run, or an Agent that is live or uses directory execution, and
nowhere else). A per-turn `execution.isolation: "envelope"` on an Agent Git
turn contradicts the binding and is refused `thread_execution_conflict`. The
turn's idempotency digest still covers only the client's request body. The
runner then enforces agreement for every thread-bound run, the raw daemon
socket included: the run's project is the thread's project, a delegated
thread's run carries exactly its bound root under delegated authority, and an
ordinary thread's run carries neither (`thread_execution_mismatch`). The
root's existence is checked inside the durable job, so a missing workspace is
a retryable `delegated_workspace_unavailable` refusal on the exact turn; Turn
Retry replays the accepted request after the caller restores it. Every mode
and access level resolves to the bound root before any managed-workspace rule:
no thread worktree is created, protected paths never promote the thread, and
nothing reads or writes the author tree in its place. Directory execution
keeps its own live/copy semantics with the bound root as its source.
Mandatory-context checks and the Plan scope atlas read that execution tree;
their mandatory paths and include/exclude rules remain project configuration.
Manual run Apply, Apply Check, eligibility, and Accept Clean Patch use the
recorded execution workspace as the original delivery target when present.
Copied directory results return there through the ordinary verifier and
preimage checks; the stable project still owns configuration and run identity.
An unavailable execution workspace never substitutes the project directory.

The caller owns the workspace's contents. Claudexor captures each mutating
turn's Git-visible changes against a pre-turn snapshot of the workspace (so a
subject the caller staged before the turn is never attributed to it, and
Git-ignored evidence never enters `patch.diff`), never applies the workspace to
the project (Thread Apply refuses `thread_workspace_caller_owned`), and never
resets, cleans, or deletes it; purge removes only Claudexor's lane state and
keeps the binding as history. The snapshot is written with a scratch index
into the workspace's own object store; the workspace's HEAD, index, refs, and
stash are not changed. `/produced`, revert, continuation, and the Run Again
draft all read the recorded `execution.workspaceRoot` and never fall back to
`scope.root`. Run summaries project that address as `executionRoot` beside the
stable `project.root` (the project root for every other project run, null
without a project). The macOS terminal and local preview use the thread's same
bound workspace and explicitly report a missing binding; the thread's
changed-image gallery, turn file links, and Run Detail's answer, retained output
and artifact previews resolve only in that workspace, never in same-named project
files, and a run whose summary carries no `executionRoot` scopes only its run
directory. A remote image names its run (`runId` on `GET /v2/projects/:id/file`):
the remote runtime verifies that every supplied run belongs to the addressed
project, including ordinary runs without a workspace override. A run without
project scope cannot name project files. Reads without a run retain the project
root, and a recorded workspace needs no project registration. A missing
root answers `execution_workspace_unavailable` from `/produced` and from that
file read (410), never the project's file. Refreshing the workspace between turns is the caller's job, and
only after it has established that the previous turn's processes stopped: a
restart-interrupted turn proves nothing about that (see Daemon lifecycle).

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

`execution.auxiliaryWritableRoots` names exact caller-created service
directories (a shared download cache, outside-Git scratch) that an Agent run
with effective `workspace_write` may also write; omission and `[]` grant
nothing. Any other mode or effective access is a typed
`auxiliary_writable_roots_access_conflict`, never a changed profile. Request
boundaries keep the caller spelling and refuse relative or missing paths
(`auxiliary_writable_root_invalid`; thread turns defer existence to their
durable job). Run admission resolves each root to its real directory,
deduplicates it, creates nothing, and refuses (`auxiliary_writable_root_unsafe`)
a filesystem root, HOME or its ancestors, Claudexor's own state or a configured
credential-profile home, any overlap with the execution or source tree
(ancestors and descendants included), and Git metadata of either tree; HOME descendants are
allowed. Realpath spelling and directory-identity ancestry are checked, so macOS
firmlink aliases cannot hide the same project directory. `TaskContract.access.auxiliary_writable_roots` records the canonical
list. Only a lane whose own access is `workspace_write` and whose
`capability_profile.access_control.auxiliary_writable_roots` is true (catalog
`accessControl.auxiliaryWritableRoots`; Codex today) receives it: an explicit
incapable lane refuses `auxiliary_writable_roots_unsupported` before spawning,
Auto drops it with a `route.pool.degraded` `access` receipt. Requirements preflight
filters these Auto lanes before discovery and profile-cardinality checks;
request pools, Settings pools and credential pins retain typed refusal. Writable candidate
synthesis keeps the grant; planner, reviewer, read-only reducer, Ask and patch-producer lanes do not. A thread turn
carries its own list beside the fixed binding, and a turn without one has no
grant; `continueFrom` inherits or replaces it with the execution group, and
Exact Retry replays it. Files written there stay outside capture, apply, revert
and run lifecycle.

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
width 4, capped by `runtime.max_deep_scan_width`, default 8; see
[Main Execution Paths](#6-main-execution-paths)). Best-of-N expands the eligible pool over N candidates. Convergence rotates compatible
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
profile id shared across harnesses creates an implicit AUTO pool: a typed quota
refusal removes only that lane while a sibling survives, whereas an explicit
pool remains strict and an exhausted primary keeps its original typed terminal
if no fallback survives admission and ordering. A
pool smaller than `N` with NO drops is still a legitimate best-of-N on the
available harness(es); deep-scan likewise repeats a surviving harness for scout
coverage, since its width is distinct slices, not distinct harnesses.

A thread carries sticky routing so the chat surface stays a thin gateway: a
`Thread` persists `primary_harness` (which harness answers in chat) and
`eligible_harnesses` (the pool Best-of runs — one candidate per harness, so its N is
the pool size). A turn inherits both unless its request overrides them
(`POST /v2/threads/:id/turns` accepts `primaryHarness` / `harnesses`); precedence is
**turn body > thread sticky > engine default** (config `routing.primary_harness`,
otherwise an auto-pool of doctor-OK default routes plus harnesses with enabled
account rows; a selected row must pass exact profile preflight). All
ordering/validation stays in the engine —
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

Harness availability is determined by discovery + route-specific readiness +
capabilities: `available` alone is not enough. A genuinely profile-less/default
route must be doctor-`ok`; an exact account row may instead admit its harness
after that selected profile passes readiness, quota, and model preflight, even
when the default store is unavailable. Either route must expose the selected
mode's intent (`explain` for Ask, `audit` for Ask's `--deep-scan` sweep,
`implement` for Agent/repair paths, `plan`, etc.) and support read-only when the
mode requires it. Surfaces keep aggregate/default doctor evidence distinct from
exact-profile evidence and routing gates on the identity actually selected.

Attachment and Browser request admission (requests with neither skip it) uses
execution's pool projection and candidate membership: the request's pool (a thread
turn carries its sticky pool), else Settings `routing.eligible_harnesses`, is
strict; otherwise Auto membership comes from host status, enabled account rows and
a pinned profile's harnesses (`orchestrator/route-admission.ts`). One precedence
owner resolves the profile for admission and the run: an explicit per-turn id
wins, explicit `null` clears the thread pin for that turn (the run still keeps the
thread's durable account binding), and omission inherits it. Admission checks
static facts only. Missing, disabled or wrong-harness pins and unavailable lanes
refuse with 400 `harness_unavailable`, including an empty Auto candidate pool.
Every explicit-pool lane must accept each mandatory attachment; Auto may drop
incompatible lanes. Remaining lanes with ambiguous platform bindings refuse with
409 `credential_profile_ambiguous`; Browser needs one effective remaining lane
under its access and web declarations. One bounded asymmetry remains: Browser-only
Auto on Windows can reject ambiguous AGY rows that execution would have dropped
as unready. Admission deliberately does not probe readiness to resolve that edge.
Account readiness, quota and model admission belong to the run (owner decision),
so a named profile admits its harness even when the default store is logged out.
An accepted run whose selected account is not ready fails after run preparation
(artifacts, Git boundary, `CLAUDE.md` bridge, in-place snapshot) and before any
provider starts; run-level Exact Retry replays the same request. A direct
`POST /v2/runs` carrying `threadId` is refused before admission reads that thread.

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
source, judged under the harness's own `model_inventory_absence` declaration
described in the model-governance section above: strict where the harness
declares its lists complete, forward-and-disclose where it declares them
advisory — there is no silent pass-through tier either way.

Reasoning effort is an OPEN vocabulary, mirroring the vendors: codex types its
own `ReasoningEffort` as any non-empty value the model advertises, and Claude
Code's ladder belongs to the INSTALLED binary (2.1.89 stops at `max`; 2.1.165
adds `xhigh`). So `EffortHint` is a bounded lowercase slug rather than an
enum, and the PRIMARY ORDERING AUTHORITY is the vendor's own advertised
sequence. Vendors return their levels already ordered
weakest→strongest (codex `app-server` `model/list` →
`supportedReasoningEfforts` per model; the `--effort` line of `claude --help`),
so a model's ladder is its own ordered list, a harness's ladder is the
positional merge of its models' lists (`mergeEffortLadders`; the Swift
`EffortLadder` merges the manifest's already-ordered arrays the same way), and
a level's rank is its position in that merged order — which is what lets a
brand-new vendor level sort correctly with no code change. Should two models
advertise contradictory or incomparable orders, the resolver refuses
cross-model substitutions rather than treating display order as rank.

`EFFORT_PREFERENCE_ORDER` (`none < minimal < low < medium < high < xhigh < max <
ultra`, the one row every Claudexor client speaks) is NOT a second rank table
and never replaces the vendor's order. The resolver consults it only to PLACE a
requested word that the route's own ladder does not list at all: `ultra` on a
Claude binary that stops at `max` resolves downward to `max`, and `none` or
`minimal` on a ladder that starts at `low` resolve to that known minimum. A word
the vendor ladder does list is always ranked by the vendor (`ultra` on gpt-5.5
clamps to `xhigh` because a sibling Codex model lists it, with no shared-order
claim). Placing a word declares neither that the vendor supports it nor that two
vendors' levels of the same name are of equal quality: only a level the final
route itself advertises is ever submitted, and the receipt's `reason` states
that the shared order did the placing. The fallback merges the shared words
from the same RAW vendor lists (`effortLadders`), so contradictory orders among
comparable words disable it instead of being masked. Extra vendor-only words
do not disable placement onto the advertised/shared intersection: `ultra` on
`low, medium, high, turbo` resolves downward to `high`, never to the unranked
`turbo`; a floor uses the weakest comparable advertised level. Adapters
discover what is really advertised at discovery time and fall back to a
recorded snapshot (stamped vendor data, kept in its captured order) when a
probe cannot answer, so a probe failure costs freshness, never the run; both
probes are cached, and `scripts/model-hints-freshness.mjs` WARNS when the live
ladders disagree with the snapshot. Codex model membership is account-scoped,
so its recorded fallback covers the union of verified account catalogs: every
live model must match its recorded ladder/default, while a recorded-only model
does not make another account stale. Effort ceilings are per MODEL, not per
harness (gpt-6-astra and gpt-5.6-sol take `ultra`, gpt-5.4 stops at `xhigh`), so
`effortLevelsForModel` narrows the harness-wide merged ladder for the routed
model on the native session surface. The shared normalizer passes an accepted level through verbatim,
resolves a known unadvertised preference to the strongest supported level not
above the request. Only when every supported level exceeds the request may the
known minimum be used. Display tie-breaking between incomparable vendor chains
is not rank evidence; unknown order never authorizes a guessed substitution.
ONE resolution result per route feeds everything downstream: the arg builder
sends the receipt's `submitted`, the disclosure event describes the same
receipt, and `downward`/`floor` are judged on the order that actually chose the
level — so the native flag and the recorded receipt cannot disagree. WHICH LAYER clamps is part
of the contract: `discover()` probes the DEFAULT native harness home, so the
manifest carries the default account's ladders, while codex advertises per
ACCOUNT and every credential profile and API-key route runs under its own
`CODEX_HOME`. Run preflight therefore forwards the original preference
unchanged even when default-account discovery lacks it. Native effort adapters
(Claude, Codex, the ACP client) resolve only after the account, model and
harness are bound. Settings writes and reviewer admission preserve these
preferences too. On an adapter without any effort carrier a settings WRITE
keeps its typed validation (a refusal before anything is stored, never lost
paid work), while a run or a review is never lost to it: a harness that
declares no effort controls keeps the preference in the receipt as `omitted`
and discloses it — an unknown word included, which is noted as outside the
shared order rather than refused — and only a reviewer ladder that exists and
cannot place the word still refuses an explicit panel entry or drops an
automatic one with disclosure. Cursor and Antigravity carry the level inside
the compound model id and declare `--model` as their effort carrier: given an
effort preference, `prepareProcessing` selects the listed variant of the
requested model's family from the inventory of the account that will run (the
family is the id with exactly one shared-order level token removed; `fast`,
`thinking` and every other token stay in the key; a family exists only when
that account lists two or more levels; the level is placed by the shared
preference order alone, the vendor's list order being a menu, never a ladder),
so `grok-4.7-high` + `max` runs the listed `grok-4.7-xhigh` and
`gemini-3.8-flash-low` + `max` runs `gemini-3.8-flash-high`. Without a
preference the id is sent as written. The requested id stays in
`spec.model_hint` / `attempts[].requested_model`; the final id is the
processing receipt's `submittedNative` (the `--model` argument, the native
truth gate's second check and the telemetry `model_mismatch` baseline); the
level receipt is that preparation's `EffortResolution` (`parameter: --model`,
`source: account_catalog`, `submitted` = level token), recorded once by the
engine's spawn gate or the reviewer dispatch — never a second `omitted`. An
ambiguous id (two level tokens), a family-less id, an unknown word, an empty or
unread account list (Antigravity: no pinned account; the static hint list never
authorizes a rewrite) keep the id unchanged with an `omitted` receipt and a
note; nothing refuses. The level choice never crosses fast/standard: the
existing fast-pair and paid policy run after it on the selected id. A settings
write accepts the preference for these routes like any flag carrier. Claude
uses the installed binary's accepted list and its
recorded same-provider vendor order for known gaps, and the shared preference
order for a word neither lists; no ordering can authorize submitting a value
absent from the current accepted list. Snapshot
fallback authorizes values only on its recorded CLI version. An unverifiable
knob uses the current vendor default with an explicit omission receipt; known
absence and unknown capability remain distinct. A request that neither order
can place against an available nonempty ladder refuses before generation; the
ACP client refuses it before spawn instead of forwarding a flag the vendor CLI
would reject. The CLI help, the MCP tool
schema and the macOS picker's ordering all derive from that single source. `doctor` validates each
harness's CONFIGURED default model against the truth source, so a broken
default (e.g. a model the CLI cannot run) is reported honestly instead of
masked by a smoke that used a different model, and the same verdict rides
the harness status DTO (`configuredModelCheck`) into the Settings UI.
The reusable `EffortResolution` schema records `requested` (the original
preference), `submitted` (native option or explicit null omission), `resolution`
(`exact`, `downward`, `floor`, `omitted`, `unverifiable`, `rejected`), `source`
(the resolution authority), and `parameter` (the native carrier, null if absent).
`observed` and `observedSource` stay null unless a provider field reports effort;
submission never becomes observation. Existing dispatch/lifecycle evidence still
determines whether the prepared option was physically sent. The receipt is
optional on historical records. Model operations retain `effortResolution` in the
existing `ModelCallResult` resource only when creation opted into
`captureEffortEvidence=true` (see [model operations](#caller-owned-model-operations)).

Runs record it as `attempts[].effort_resolution` in
`final/telemetry.yaml`, carried through `HarnessEvent.effort_resolution`. The
attempt retains the final native execution's receipt after account rotation.
Codex model results obtain observation only from Responses' `reasoning.effort`;
`appliedOptions` keeps its existing provider-echo meaning. Session adapters do
not claim an observed value. Adaptation disclosures, including an exact effort
selection that changes a `--model` id, are status/log events and
never injected assistant messages. These fields add no operation, generation,
retry, account-selection or budget authority. A rejected final-route preference
ends that attempt without account rotation, model/harness fallback or repair retry;
ordinary availability failover retains its existing policy.

Codex raw model calls expose ordinary inference efforts, while the native CLI's
`ultra` selector also owns automatic task delegation. The raw adapter excludes
that agent-mode selector from `reasoningEfforts` and retains the vendor's original
`reasoningEffortPreferenceOrder` internally through operation-local catalog parsing.
The existing preference resolver chooses the strongest accepted generation effort
not above the original request in that vendor order (currently `ultra` → `max`
for Astra), with a downward receipt and no claim of native delegation. It does
not copy the CLI's underlying per-agent effort or invent a replacement ladder.
A word no verified catalog model lists is placed by the shared preference order
exactly as on session routes, and the receipt says so.
Both public catalog views project the internal order out, preserving their object
shapes. Native session Ultra remains unchanged and is implemented by the CLI.
For an explicit unlisted raw model, ordinary effort is submitted unchanged with
adapter-sourced exact-submission evidence and unconfirmed capability; no sibling
ladder is borrowed. Raw Ultra without a known generation ladder is an unsupported
option, since a raw call cannot perform the native agent's automatic delegation.

Managed catalogs also carry optional `reasoningEffortsVerified` on `ModelCatalogEntry`:
true records a fully parsed vendor array (including known empty), while false or
historical absence prevents an incomplete catalog from claiming known absence or
authorizing a substitution. Native Codex likewise retains explicit empty arrays
separately from missing metadata on a listed model. The unnegotiated model-catalog
HTTP view omits this new field; the account view retains it. Session adapters keep
their existing unlisted-model effort resolution; raw calls use the rule above.

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

`access=full` (unsandboxed) requested by an operator at a surface additionally
requires `allow_full_access: true` in the USER-LEVEL trust config
(`~/.claudexor/v3/trust/<repo-hash>.yaml`); versioned repo config can never
self-grant it, and the violation is a loud routing error naming the resolved
trust path, not a silent downgrade. A run marked `execution.delegated` is driven
by an external orchestrator that owns the workspace and carries its own
authority: it needs no separate trust record, and its effective profile is still
recorded as `full` on the immutable contract. `claudexor trust` is
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
the default changes (QA-035); an inherited native speed is kept the same way
from the source run's frozen routing-time intent (Processing and account catalogs); the resolved map is what route-spec building
reads; per-attempt overrides
(budget downgrade to `fallback_model`, fallback retry) sit on top. Every
explicit model — per-run, settings default, fallback, reviewer — must pass
the harness's model truth source wherever that source can prove absence (live
`models()` inventory, else manifest `known_models`; an authoritative harness
with neither refuses explicit models; an advisory harness forwards, see below):
enforced at settings write (400), run preflight (typed failure with artifacts before any
CLI spawns), immediately before each routed spawn against that attempt's exact
profile, state, cwd, and auth preference, and both reviewer-panel paths. A pinned
profile answers its OWN inventory through the same route resolver the run path
uses, so preflight and spawn always name one account. A profile-less automatic
route is enumerated with the same `auto` the adapter will resolve and the spec
reaches the adapter unrewritten: the gate reads the run's identity, it never
decides it, and an undecidable route is the vendor's refusal to make, not the
gate's.
The same rule decides what a list may refuse with. A list always proves
PRESENCE; whether an absence from it is proof too is the HARNESS's declaration
(`model_inventory_absence`), and it governs the live inventory and the manifest
hint list alike — the hints are one day's memory of the same vendor menu, so
they can refuse no more than the producer can. `advisory` (claude: the picker
is an alias menu of one binary version plus the account's bootstrap rows;
codex: `model/list` carries no provenance and the CLI substitutes a bundled
default list when its remote fetch times out; cursor: `--list-models` is a
fail-soft menu blind to routing variants; agy: an account menu with
no completeness guarantee; copilot: `session/new` config
options are an optional per-session menu over unverified hint rows) makes
an unlisted EXPLICIT model undecidable, so every gate forwards it
byte-identical and the vendor decides.
Each admitting consumer says so once: the settings write persists the model
and its read-back carries the admission in `notes` (the CLI prints it), the
doctor's configured-model row passes with the note in its detail, and the
per-spawn gate discloses a status event; preflight stays silent, so one spawn
speaks once. `validateModel` takes the list, its source and the declaration
with no defaults, and `checkHarnessModel` in the CLI registry is the one owner
of that triple for the settings, doctor and catalog gates. No list is ever
substituted to admit a model, and the automatic reviewer panel keeps its own
skip-at-zero-cost contract whatever the harness declares. The residual is
disclosed rather than guessed at: a vendor CLI refusing a forwarded model
surfaces as an untyped error carrying the vendor's text, and a mistyped model
on an advisory harness costs one spawn.
Thread ask/plan readiness and inventory use the same durable lane HOME as the
eventual spawn, while non-thread read-only runs retain disposable state.
`/harnesses/:id/models` reports
the truth source honestly (`source: api|manifest|none` — a producer that
answered only hint rows reports `manifest`; rows may carry `origin` and
`resolved_model` — with the manifest's `verifiedAgainst` CLI-version freshness
note), and the model-hints-freshness gate warns when the installed vendor CLI
drifts from the verified version.
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

Cursor and AGY prompts use the shared CLI loop's one-shot stdin. AGY omits
print flags so its native stdin reader selects print mode. Claude one-shot uses
text stdin; interactive/image runs retain their sole stream-json stdin owner.
Claude instructions append through an adapter-owned UTF-8 file, removed when
the child ends, never through argv or user-role text (`instructions-file.ts`).
Codex owns one native
`app-server --stdio` JSON-RPC child per Claudexor run. Its stdout uses the shared
process reader's opt-in LF framing: U+2028/U+2029 inside JSON strings remain
payload, not frame boundaries. The reader searches each chunk once and joins a
fragmented frame once, at its LF. Natural EOF delivers an unterminated final
frame (a malformed one fails the run); the post-exit drain's forced closure
drops it. Every Codex
adapter run, in any mode or reviewer role, opts in. Raw `/responses` model
operations are HTTP and read no child stdout. The auth-refresh app-server
child, the shared CLI run loop and other protocol line readers keep their own
framing (`docs/BACKLOG.md`, #484 siblings).
The adapter keeps the run
active while a native turn, active goal continuation, or run-owned background
terminal exists. Native thread/turn ids are control handles, not durable engine
truth; the engine store remains authoritative. Stop pauses an active goal,
interrupts the exact stored turn id, terminates only background terminals whose
item ids were observed in that run, verifies quiescence, then reaps app-server.
Finality belongs to the ROOT thread (`app-server-threads.ts`): Codex may spawn
native sub-agents whose threads emit their own `turn/started`, items, token
usage and `turn/completed` on the same stdio stream, so a notification is the
run's own only when its `threadId` is absent or equal to the thread
`thread/start`/`thread/resume` returned (per thread, never per turn: a goal
continuation runs several root turns). Resume binds the requested thread id
before sending the RPC. Start buffers notification state effects until its reply
identifies the root, then classifies them in arrival order. Only root frames move
the active turn, the owned command set, the thread's health (`systemError`), the pending final
and the terminal candidate; `started.native_turn_id` is the `turn/start` RPC
result's turn and `completed.native_turn_id` the last root turn. Sub-agent
frames are not dropped: tool calls/results, thinking, file changes and token
usage stay on the timeline tagged `payload.native_thread_id` /
`native_turn_id` / `subagent: true` (their tokens stay in the run's usage), a
sub-agent's agent TEXT is re-emitted as a `status` event
(`code: subagent_message`) and never as a `message` (the same rule the claude
adapter applies to `parent_tool_use_id` frames), its plan progress never
overwrites the root's, and its lifecycle frames are recognized without
becoming finality; the terminal discloses `subagent_threads`. After the root
turn completed, "thread settled" is re-checked on any notification and, in
silence, after the poll interval. A sub-agent's failed command therefore stays
tool-warning evidence beside the root's delivered final instead of escalating
through the deliverable-less tool-error exception. On normal shutdown, an explicit
completed root answer with settled lifecycle and no other failure survives the
Windows-only whole-tree proof limitation. Its unchanged `termination_unconfirmed`
payload records uncertainty separately from answer text; empty survivors prove no
death. Other unresolved reasons, observed survivors and cancellation remain errors.
After stopping the process, drained root system errors, failed or interrupted
completions and new root turns invalidate the candidate answer even when POSIX
cleanup confirmed death. Child-thread lifecycle frames never invalidate it.
An inherited pipe has a bounded post-exit drain: complete frames already read
are delivered, while forced closure is disclosed as `payload.output_drain:
"truncated"` on the terminal event of Codex, the shared CLI loop and ACP (a
gate marks its stored output `output_truncated`); output written after the
closure is never read. The bounded reader then suppresses only that closure
(`ERR_STREAM_PREMATURE_CLOSE`): a frame that breaks its size or UTF-8 limits,
any other stream error and a callback failure stay failures. Pipe closure
proves no descendant death; whole-run scope settlement and its separate
receipt still follow.
Native in-turn retry notices use the existing nonterminal `api_retry` status;
their wire mapping is documented in INTEGRATIONS' Harness Stream Reference.
Adapters without a verified prompt transport retain their vendor-specific path.

Git-backed candidate envelopes also preserve bounded raster previews before
cleanup (PNG/JPEG/WebP/GIF, 16 MiB each / 32 MiB total) under the attempt's
run-artifact tree. The winner's copies materialize at the run root so relative
markdown screenshot links remain inspectable after the worktree is disposed;
they remain INTERNAL run evidence until the patch is applied to the project,
preserving INV-051's two artifact planes. These preview limits do not limit the
complete content of a [directory file result](#directory-execution).

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
this bounded grace, while unpinned pool/rotation selection never consumes it.
This absorbs a probe failure only; it does not claim to serialize the vendor's
OAuth refresh or to repair a revoked credential. A spawn that fails for the
file's format (`EFTYPE`/`ENOEXEC`, including a launch refused before spawning)
is not a transport failure: it is reported once as a probe failure, with no
retry and no stale observation.
Cursor's row status probe (`cursor-agent status` in a row's file-store HOME)
is coordinated the same way: concurrent reads of one row store — keyed by the
auth-selecting `HOME`/`USERPROFILE`/`XDG_CONFIG_HOME`/`APPDATA`, so admission
and a spawn with a lane state HOME share it — share one child, and a POSITIVE
answer is reused as fresh for at most one minute, keeping the instant the
vendor gave it as `last_verified_at`. Age uses a suspend-inclusive monotonic
clock; Linux uptime's possible one-second quantization is conservatively
bounded, so an observation can expire less than two seconds early. Wall time
only stamps the observation; clock steps neither extend nor expire it.
A probe with no recognized answer whose ten-second budget expires before
observed native exit or caller cancellation reports
`did not answer within 10s (…); login state unknown`, which is
`unknown + not_run`, never a logout and never a pass — a caller's
cancellation or a kill from outside is a plain unknown, not a timeout. Its stale path serves the other side of routing (the INV-135
#363 amendment): only such a timeout, while the store's last positive answer is
under five minutes old, projects that answer as `stale: true` with
`stale_basis: last_positive_after_timeout`, its `stale_age_ms`, a detail naming
the answer's instant, and no `last_verified_at` or identity. That basis admits
UNPINNED choices only — a bound row, the pool, rotation and `next_up` — never
an explicit pin (a pin whose probe timed out is still refused), while the
generic grace above still serves only a selected route. A logged-out answer
from the store drops its positive, as do Claudexor-handled credential
mutations (including an in-flight probe), and while a Claudexor-managed
Cursor login's credential-mutation window is open (see the profile-login
note under [Design constraints](#design-constraints)) the coordinator
answers live and neither reuses, retains nor leans on any positive; any
other unknown answer never consults it, and no file in the row HOME is read
as a substitute. The
adapter's spawn-time route check applies the same split. The engine stamps
each spec whose row was an unpinned choice (a bound row, the pool, rotation, an
unpinned or automatic reviewer seat) with that row's id in `spec.extra`; the
adapter never infers it from profile fields. Only a stamped row starts on a
stale positive, after yielding an `[auth] … using the last positive status
answer …` status event (`auth_status_stale`; never answer text). An explicit
pin, or any unstamped spec, whose spawn-time probe times out refuses as
`login state is unknown`, naming the last positive as unpinned-only, and every
other unconfirmed row refuses the same way rather than with login advice. A
model-inventory read, which launches nothing, may still read on it. The
Accounts catalog projection remains stricter for a named account: it reports
unknown status and does not offer catalog reading on stale evidence. This
conservative projection does not change standalone inventory or run admission.
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
run requests never turn the command store into a secret store. Secret-setting
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
Codex's direct `model/list` and quota app-server probes use that same producer,
so a GUI-launched daemon can discover models and quota from the CLI it found
during login. Host toolchain PATH is composed before a scoped HOME patch;
credential homes and provider-variable scrubbing remain specific to each probe.
The same runtime environment producer supplies an absent OS login name from
`os.userInfo()`, preserving supplied identity and later environment
patches. It never derives the name from a profile or scratch HOME.
The shared `spawnProcess`/`runCaptureRaw` helpers start every child as a fully
piped background process through one spawn shape (`backgroundSpawnShape`,
`runtime-env.ts`). On POSIX the child is detached: it leads its own session and
process group, so a cancel signals the whole tree. On Windows it is not
detached, so libuv's `windowsHide` adds `CREATE_NO_WINDOW` (Windows ignores that
flag beside `DETACHED_PROCESS`): the child owns an invisible console, and every
console program it or its descendants start without flags of their own (shells,
`git`, MCP servers, the native program behind an npm wrapper) inherits that
console instead of opening a window. A descendant that detaches again or asks
for a new console is outside it. The Windows tree kill is
`taskkill /PID <root> /T /F` (`process-tree.ts`), which follows parent links and
needs no process group; the child also joins libuv's kill-on-close Job, so it
normally ends with the daemon process. Its descendants never join that Job: they
end through the harness itself or the tree kill.
A consumer passes `windowsConsole: "none"` to keep `DETACHED_PROCESS` and no
console at all: agy does so for its runs and `--version` probe, because its
print mode treats an openable `CONIN$` as interactive, and console programs an
agy run starts may still open windows. Claudexor's own `git` calls keep the
console-less start they always had, so they open no window; Git for Windows'
`cmd\git.exe` launcher gives the real git a windowless console of its own, so a
credential or host-key prompt there waits until the call's timeout, as before.
Codex's quota and `model/list`
app-server probes, the install `--version` proof and the `login --help` probe
start their direct child with `windowsHide` only. So do the daemon-hosted
no-Terminal sign-in children (URL disclosure and the device-code app-server):
their runner and worker are detached and have no console to share.
Interactive sign-in (`profiles login`, the Terminal/ConPTY setup runner),
`setup attach` and vendor update keep their own terminal policy.

### Account resources and explicit resets

`QuotaRegistry` also owns independently observed balances, spending, reset inventory
and diagnostics. Versioned resource observations share the global SQL event ledger;
quota windows keep their strict schema and their existing admission/supersession owner.
Resource facets carry a successful observation time, a separate last attempt, source,
and freshness. A missing or failed facet preserves its last known value as stale;
unknown amount/count is null, not zero. Amount strings retain provider units,
nullable currency and provider-reported `decimal_places`. Reset offer/grant
`description` is display copy; `clears` retains native scope identifiers. Diagnostic
codes retain provenance while their detail explains the state, including false/unknown.
These resources do not enable paid usage or change routing policy.

`cursor-quota-source` uses the bound vendor file store (macOS HOME, Linux XDG,
Windows APPDATA; config stays CURSOR_CONFIG_DIR). Source-derived layouts are not
native-platform proof. Existing demand/pacing emits bounded `usage_http` receipts;
Retry-After starts at response receipt. USD minor-unit resources (scale 2) never
admit runs; `no_source` means no quota-window source, not no account resources.

The operation catalog advertises `view=resources` on quota and atomic Accounts
reads; `resources_freshness` combines the freshness view (including its Codex reset-credit
compatibility label), typed resources and a model/request-kind echo on passive GET
(wire contract: INTEGRATIONS). Unselected quota reads keep the strict legacy shape. A refresh body
may select one exact `target` (harness and profile id), including a named default
or a disabled portable profile. It uses the existing refresh coordinator and pacing
floor, retains other accounts, and cannot join a cycle that did not cover its target.
Claude's ordinary usage read includes spending and granted-reset inventory. Separate
prepaid and session-refill reads run only during existing foreground cycles, with the
same subject's pacing owner. A prepaid eligibility refusal affects the balance facet,
not account authentication. Background polling adds no supplementary request fan-out.
The internal observation's `resets_resolved_ids` names programs authoritatively read
in that cycle, including explicit null from that program's reader. An omitted or
malformed body is unresolved. Merge drops resolved-absent offers and retains unread
ones without inventing an error; retaining any unread offer keeps the single facet
clock stale. Coverage is not a public snapshot field. The event ledger stores the merged
complete row and replay installs it, while legacy partial rows still merge as deltas.

`POST /v2/account-resets` is a direct control operation backed by the command store,
independent of inference queue capacity. Its required Idempotency-Key binds the exact
request, canonical native account fingerprint, selected grant/program and native request
id before dispatch. The native reset starts only after `flushed()` covers that
intent; an unavailable barrier returns the retained `unavailable` receipt without
native I/O. Keep the original body and key through an HTTP timeout, even if no
receipt id arrived. `GET /v2/account-resets/:id` reads the durable receipt. Outcome and
resource readback are independent: confirmed reset survives failed readback. Codex
same-key `already_redeemed` confirms its operation; Claude `already_used` does not.
An unknown Claude outcome never automatically submits another native POST. Distinct
explicit keys are independent requests; there is no new account-wide lock or scheduler.
Receipts retain the key binding outside ordinary inference command pruning.

Only an effect or possible effect makes old observations historical. Confirmed no-effect
outcomes preserve fresh quota when readback fails. Post-reset readback drains the old
cycle, moves the durable account cutoff before the new read, and retains history if that
read fails. Journal order distinguishes fresh reads sharing the cutoff's millisecond.
The engine never infers a new balance or remaining reset count from a consume response.

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
canonicalizers refuse the native locator. That account-registration rollback
cannot undo the SQL engine-store migration or lower its semantic floor.
`claudexor auth login <harness>` is
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
The Cursor status receipt distinguishes a successful server `getMe` response
with typed `userInfo` from the vendor CLI's token-only fallback after a server
error. Only the former supplies vendor verification; bare authentication booleans,
legacy text, and stale observations do not become current server proof. Unrecognized
vendor output keeps its existing readiness classification and unknown billing.
The Accounts-only Cursor probe receipt also carries an optional email parsed
from the CLI's narrow typed status grammar. Projections reuse
the status invocation they already need; no credential file is read, no raw
status output is persisted, and no extra subprocess is launched for identity.

The orchestrator is the ONE resolve owner. There is no user-settable "Active"
account: enabling/disabling a row is the only routing control. The
per-harness EFFECTIVE account is resolved by the owner-locked order (INV-135):
(1) an explicit per-run/per-thread pin (`credentialProfileId`) is STRICT: an
unknown/disabled/harness-mismatched id is a typed refusal before spawn, a fresh
exhausted quota window refuses typed (`subscription_window_exhausted` with its
reset time), and a pin never silently rotates. (2) An unpinned THREAD turn stays
on its durable bound account, which the daemon derives from the thread's own lane
evidence (latest live session, else lane checkpoint, per harness) and hands to
the run as `threadAccountBindings`; a binding whose row became
disabled/deleted/revoked/exhausted moves to a pool sibling with a typed
`route.account.lane_switch` disclosure, never silently.
(3) Otherwise the quota-aware POOL of enabled+ready subscription rows selects
the account (`route.account.pool_selected`); "ready" is fresh readiness except
a Cursor row's bounded last positive status answer after a timed-out probe
(see [Auth And Secrets](#5-auth-and-secrets)): fresh model-applicable headroom
descending, unknown/stale quota after known-positive headroom but before
exhausted (stale quota never authorizes routing), deterministic profile-id
tie-break; a row under an observed live block (a reactive vendor-limit
cooldown or spent window: the A4 reader) ranks exhausted with its release
instant. Two live observations add one ordering key among the selectable rows:
a marked row ranks after every other selectable row for that requested model,
a row's newest mark counts, oldest mark first, and a mark never excludes a row
or makes the pool exhausted. Model operations pass a model-substitution
observation (see [Caller-owned model operations](#caller-owned-model-operations));
Agent Runs, reviewer seats, model operations and the `next_up` projection pass a
pre-progress refusal observation, recorded when an unpinned Agent try on a
subscription row reported a typed `started` session and then ended in the structural rotation branch's own
evidence (a terminal non-transient death with no agent progress, deliverable or
mutation) without a typed vendor limit, which is already a cooldown, or when an
auto model operation's provider refused it with a definite HTTP 4xx before
generation (sign-in, timeouts, conflicts, rate and quota limits, server failures
and typed request faults record nothing). An adapter's
own pre-spawn refusal and an explicit pin never record one, and the vendor's
wording is never read. It is keyed by harness, row and requested model (the
harness default model is its own key), lives in daemon memory for one hour, and
clears when a later try on that row and model makes agent progress or ends
cleanly, when a model operation is served there, or on a credential-generation
change. A try binds its row's credential
generation before it spawns, so an outcome after such a change neither records
nor clears a mark; while a login of that harness holds its credential-mutation
window the generation is no number at all, so a try bound before or inside the
window never records or clears one (#363). Among selectable rows that are
otherwise equal with unknown headroom, the row that most recently SERVED the
requested model ranks first, before the profile-id tie-break (INV-135). Service
uses the predicate that clears a mark — typed agent progress or an error-free
delivery — judged per try against the row the try bound before it spawned. The
vendor's model label is never compared with the request (aliases and picker
labels answer under resolved names), so a substituted model still counts as
service of the requested one; a try whose own events name another row or a
non-subscription route serves nothing and retracts the fact it wrote. The fact
lives in the engine store's `account_last_service` table: one current row per
harness, account, requested-model key and credential-binding digest (kind,
secret name, locator, creation time — a rename or Enabled toggle keeps it),
ordered by an acceptance sequence the single writer allocates, never by the
wall clock. The credential-generation changes that void a row's other evidence
delete its facts after the generation moved; a failed delete is logged and
leaves at most a stale preference. An Enabled PATCH, even one that changes
nothing, voids the same verdicts and moves the same generation, so a try bound
before it records nothing after it, but it keeps the binding's facts. Agent Runs (both lanes) produce it; run
admission, reviewer resolution, the `next_up` projection and a model
operation's Auto account choice read it once per ranking; model operations
never produce it. The daemon builds one
account-evidence graph per engine-store lifetime, injected into every reader and
writer: global recovery keeps it and closing the store retires it. A credential
changed outside Claudexor's lifecycle keeps its preference; each reader's own
negative evidence (Agent pre-progress refusal or model substitution) can demote
the row, as above. When the default route is not ready
and no registered row admits a lane, the refusal names every row with its own
observed readiness (`<harness> has no ready account (<row>: <detail>; …)`)
instead of the default route's doctor advice, so login advice appears only where
a row's probe positively reported logged-out; `next_up` names unready rows the
same way. An empty or exhausted pool is a TYPED TERMINAL (`route.account.pool_exhausted`,
then `credential_pool_exhausted` with the pool's earliest known reset; owner
Q3=A): an unpinned run under `auto` or explicit `subscription` waits for a window
instead of silently taking the paid route. Only the EXPLICIT `api_key` preference
moves the exhausted pool onto the paid API-key route (billed as
`managed_api_key`; the adapter's typed key refusal is the backstop), the same
principle as kind-aware `limit_action: auto` resolving a metered subject to
`fail`: `auto` never silently spends money. Harnesses with NO registered rows keep
the legacy default-subject ladder (unmigrated stores); an excluded legacy login
(`native_credentials_enabled: false`) can only be served by the explicitly
requested paid route, so nothing silently falls back INTO a disabled login. The resolved row becomes
the typed `credential_profile` on every `HarnessRunSpec` the run builds and keys
the lane's read-only home, so the resolution flows to spec, preflight, continuity
and session recording. An explicit profile is STRICT in the adapter: exactly the
row's transport or a typed error event, never default credentials (claude:
config-dir login / stored token non-bare / stored key; codex: scoped `CODEX_HOME`
login / scoped key `auth.json`; cursor: scoped file-store HOME login / namespaced
key; opencode, copilot, raw-api: secret-ref keys only). Adapters stamp
`credential_profile_id` beside `credential_route` on stream events so quota and
retry evidence stays profile-attributable; the run's `auth_route` receipt carries
`profile_id`, projected by the Control API as `authRoute.profileId` without
re-derivation. Vendor sessions record the profile they were created under (the
attempt's `session-capsule.json`), one holder row at a time. History lookup uses
the full `(harness_id, profile_id)` identity for source, target and capsule
relocation, and a disabled holder stays readable for transfer independently of
dispatch admission. The engine boundary re-verifies every cached session against
the RESOLVED account; a pool switch either MOVES the session file into the next
row's store through the adapter's `continuity` (claude, codex) and resumes it, or
starts a fresh vendor session with a continuation packet. `claudexor profiles login
<harness> <id>` runs the vendor login in the named binding's exact scoped
environment: codex rides the SAME durable device-code setup job as the default
login (D-17), Cursor runs the vendor command in this terminal through a
`client_pty` setup job and the `setup attach` owner, and Claude/AGY keep their
direct scoped terminal flow (see the profile-login note under
[Design constraints](#design-constraints)).
Credential custody stays an effective platform fact: a scoped HOME
may select Claudexor-owned vendor state without representing a separate OS-user
credential.

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
id is recreated. Dependent partition-state
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
authority whose `next_up` verdict says who an unpinned run of the configured
default model would route to next, computed by the same routing owner; it is
never a forecast for another model. The separate read-only
`GET /v2/accounts/routing-evidence` carries live pre-progress refusal marks,
temporary model capability marks, and the last-served facts of the registered rows, each scoped to its requested model,
and leaves the legacy listings unchanged. Its `kind` is
`profile | api_key_route | none`. The pool authority is also served alone by
`GET /v2/account-pools`, whose catalog presence is the unified-accounts
feature marker old clients detect. The legacy `harnessAccounts` key stays on
the wire as `[]` for strict old clients, and its legacy `next_up` union never
receives new kinds (old decoders throw on unknown discriminators). This is
ONE projection so no surface re-derives the symmetry. Every row's `enabled`
toggle is `PATCH /v2/credential-profiles/:harness/:id` (CLI `profiles
enable|disable`); for a migrated row the PATCH also updates the deprecated
`native_credentials_enabled` mirror for the downgrade window.

Accounts separates display acquisition, live quota composition and explicit refresh.
Ordinary profile and account-catalog reads share one process-local observation owner
(`cli/account-observations.ts`): one coalesced cold attempt per binding, including a
failed attempt. TTL expiry and repeated views never repeat it. The profile's current
registry fields and quota evidence are composed at each read; the last observed
verification remains visible with its check time, never renewed by viewing it. Credential-state
invalidation and an explicit atomic Refresh request new evidence. Catalog payloads
retain original timestamps, including null when the adapter supplies none. This
cache is display-only: real run and model admission retain their fresh route checks.
The ordinary response does not claim fenced `next_up` authority. Display-only
`GET /v2/quota` owns shown quota values. Explicit Refresh/Retry and exact post-login
verification use `GET /v2/credential-profiles` with `snapshot=true`: one epoch contains
profiles, readiness, Git capability, quota, `next_up` and its quota-event cursor.

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
`headroom_threshold`, default `1`: accounts remain eligible until 100% usage;
explicitly configured lower thresholds remain effective). `auto` is the STORED
DEFAULT and resolves by the limit
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
once per attempt — the no-deliverable/no-mutation rule scopes only that
FRESH carrier: after progress the same typed limit still hops, but the next
try carries the work (see "In-run continuation" below). A third, STRUCTURAL
branch of the same predicate
(`structural_pre_progress_failure`) rotates a try that ended in a terminal
NON-transient death before the agent demonstrably did any work — no typed
limit needed and never narrowed by error-text matching; agent progress is the
typed marker set (thinking/tool/file/patch/compaction — deliberately not
`message`/`error`, so vendor failure prose can never block it), transient-
retryable deaths stay with the same-profile retry machinery, and an observed
mutation (workspace diff or any `file_change` event) fences only the `fresh`
carrier; native, moved and packet carriers continue the work after progress.
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
UI surfaces the exhaustion instead of implying a switch. Inside an attempt the
event also names each candidate's own failed tries (`attempt_failures`) and the
ordered list of every failed try (`pool_attempts`). Every terminal that is not
a clean completion, decided by its actual outcome axes, publishes that one
list across all of the run's attempts (a best-of synthesis included):
failure terminals (candidate, convergence, read-only chain and deep scan,
including those after review, arbitration, final verification or delivery, a
delivered report that still fails, the run's own Delegate child-drain or
post-drain budget failure, and a terminal-facts preparation failure); D8
blocks with a succeeded lifecycle (review blocked, checks failed, work-state
veto); and cancellations. It rides the `RunFailure` field `poolAttempts` in
`final/failure.yaml` where the terminal writes one, and `pool_attempts` on its
`run.failed` or `run.blocked` event, with one rendering appended to
`safeMessage`, `summary.md` and the returned summary: per try its row, requested
model, phase (`pre_start`, `pre_progress`, `after_progress`), typed category and
its own redacted error text. A cancellation keeps the cancel as its own
statement, and the list never mints a failure record. A cancel that lands after
the strategy's last checkpoint is decided at the terminal commit, which states
it the same way: both summaries are rewritten, and a block or failure record the
replaced verdict wrote is removed, unless it carries capture facts: that record
stays under the cancellation's own category and this same statement (see the
capture contract). A block's own check, review or work-state cause is never a row. Only a physical try has a row: a selected
successor whose own model, processing or billing preparation failed before its
send was admitted, a cancelled or budget-stopped try and a request refusal have
none, while an adapter that fails on entry keeps one. A try's row is recorded
before workspace capture; a cancel or deadline that lands during that capture
still stops the attempt with no successor, probe or retry, while the try's own
pre-progress refusal observation (#363), judged on the captured workspace, is
still recorded. An attempt rebuilt after a
post-stream failure, continued by its one-shot continuation, or a synthesis
that threw after its tries while the run went on, keeps every earlier try. An
Ask attempt (chain step or deep-scan explorer) owns its tries' rows from launch
until its record joins the list, as an Agent attempt does, so a step that throws
after its tries settled (rotation's next lane home, finishing the attempt) still
names them, once; only a persistence or process failure inside a still-running
try can end the run before that try's row is recorded. A row deleted mid-run keeps its entry. Classification, retry and rotation
never read it; records written before the field existed decode with an empty
list. Exhaustion is also a
TYPED terminal: a reactive rotation-eligible failure with nowhere to go
terminalizes the attempt on `credential_pool_exhausted` (category
`harness_unavailable` — nothing malfunctioned) only when the triggering
subject carries limit/unusable evidence. Earlier or untried accounts cannot
replace its structural failure with a quota claim. Normal finalization lifts
`code` and `resetsAt` onto `final/failure.yaml` in every lane before transient
retry (race unanimity, convergence last-result, read-only chain). A typed limit
that ends a try AFTER progress reaches the terminal the same way: the
`resumable` block names the cause (`vendor_limit`, `pool_exhausted`,
`pinned_limit`), the typed code, `resetsAt`, the vendor's window label and
whether the evidence named a window. `resetsAt` folds the EARLIEST known reset WITHIN the pool —
the triggering subject's own observed limit included; a limit-evidenced member
with an unknown reset makes it null — deliberately the within-pool opposite of
the across-candidates LATEST rule. At preflight under `rotate`, the selected
subject's OBSERVED live block with no eligible alternative refuses with the
same typed terminal before spawn; a bare headroom breach with no alternative
still proceeds (proximity is not proof the window is spent).

Account observations are collected independently of rotation policy. A bound
observer sees normalized native events before the caller consumes them and
finishes even when a caller exits early. Candidate, read-only, planner, reducer,
reviewer and continuity-summary dispatches use that same boundary; raw model
catalog and inference calls bind the same authority before provider work.
An unresolved typed terminal auth or capability refusal enters the daemon's
bounded, in-memory `CredentialUnusableLedger`. A pin records evidence without
rotating. A transport failure or cancellation alone is not an auth verdict;
served usage can recover an intermediate refusal. The existing differential
probe still reads typed stream and local/poller evidence when rotation needs it,
retains the `route.profile.credential_unusable` event and terminal provenance, and
leaves stream recording to the bound observer. It adds no probe to every completion
and spawns no miniature generation.

Only independent stream and local-probe failures enter this ledger. Poller
rejections remain in the quota owner and are derived for current diagnostics,
including rotation's sibling rows. A second stored copy must not outlive
recovery at the canonical poller. Derived diagnostics use the same current
route and successful-contact evidence as account admission.

`CredentialGeneration`, extracted from the existing pre-progress ledger, is the
shared managed-lifecycle authority. Dispatch captures subject, effective route,
requested model, generation and ordering, and both recording and success
clearing respect that binding: old-generation results cannot affect a newer
login, and a success from an older dispatch cannot erase a newer dispatch's
refusal. A negative observation made after the last successful contact stays
meaningful even from a session that started earlier. The ledger keeps negative
observation boundaries within its memory and expiry bounds, including after a
success hides the current refusal, so a later-arriving concurrent refusal cannot
restore only part of that evidence. Readiness suppresses the merged refusal only
when one real successful contact covers both its dispatch order and observation
time; contacts covering different boundaries stay separate until one actual
contact covers both, because combining their maxima would fabricate a recovery
that never happened. The bounded
collection counts retained contacts, not only account keys. Only an observed
model heals a model-scoped refusal; the request does not prove which model was
served. Credential mutation windows still make observations ineligible while the
vendor may be changing the store. External native changes not observed by that
lifecycle remain a limitation until a covering vendor observation or expiry; this
is not a token-change detector.

The pure `composeCredentialProfileEvidence` owner combines local readiness,
applicable hard refusals and authenticated quota evidence for admission, catalog,
Accounts and `next_up`. Accounts retains its compact status and detailed reason,
identity and last-known quota. Only credential-wide failures affect an unqualified
account row; `next_up` considers the configured model. Only expensive probes are
cached, so a new refusal, recovery or expiry is composed on the next read without
re-probing every account. Local verification failure stays local. A covering
successful full-reader vendor observation may supersede an older auth refusal
without losing that recovery when its numeric quota ages. Its original
contact time remains visible; it cannot heal unrelated model restrictions or a
locally failed probe. Bound served-model proof also respects dispatch ordering.
Passive window notifications alone are numeric evidence, not an independent
authentication recovery receipt.

Hard credential evidence, soft pool ordering, quota windows and poll pacing stay
separate. The bound native observer is the single quota intake owner; projected
run events never write a second profile-less observation. Numeric measurements
and explicit cooldowns from an already-running session stay observable through an
unrelated managed login or a mutation window: the generation fence governs auth
refusal and recovery, not whether an ongoing session may report its quota. Run
refusals never become poller `auth_revoked` absences or retire last-known numeric
quota. A session already running when its profile is signed into another identity
can still report the old identity's numbers under that profile; full-reader
reconciliation stays authoritative for the changed store, and those passive
numbers may briefly affect ranking but never certify authentication. Raw model
operations keep a separate dispatch-generation check for their single
terminal cooldown observation.
A profile-level refusal does not suppress quota discovery:
the Claude poller retains its existing present-token rejection memo, so external
replacement remains discoverable. The hard ledger is non-durable, expires within
its existing bounded TTLs, and clears through managed credential changes.

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

### Secret-like output: keep and mask

INV-062 separates two things that used to be one check. A secret-like value in
an INPUT (prompt, run params, instructions) is still hard-blocked at every
ingress. A secret-like string in agent OUTPUT is no longer a reason to roll
back, discard or fail anything: the content policy
(`sensitiveResourcePolicy`, one rule set for redaction and detection) is a
persistence classifier.

- **Exact bytes are untouched.** The changed files (in-place tree or candidate
  envelope), the in-memory candidate diff, the patch a race adopts, the
  synthesis input and every digest keep the bytes the agent wrote. The check
  never mutates the project.
- **Saved copies hide the matches.** `attempts/<a>/patch.diff`,
  `final/patch.diff` and the reviewer packet `DIFF.patch` are written from
  `persistedPatchCopy`: each absorbed content line of a match becomes `[redacted]`
  with its diff prefix and line ending preserved, and diff structure lines
  (file headers, `@@` hunk headers, the no-newline marker) stay verbatim, so
  the copy keeps its file records and hunk counts; the payload of a
  binary file whose pre- or postimage holds (or cannot be proven free of)
  secret-like bytes is withheld, and the copy opens with a one-line notice.
  A copy with nothing to hide is byte-identical to the exact diff and carries
  no notice. A reviewer workspace copy still omits files with secret-like
  content; the reviewer judges the saved diff. Events, retained output, gate
  tails, reviewer artifacts and the answer are redacted as before; the answer
  is always kept.
- **Images.** A raster that matches the policy, cannot be read or exceeds the
  size cap is not copied into `produced/`; the run continues.
- **Disclosure, never values.** `attempts/<a>/attempt.yaml` and
  `final/work_product.yaml` meta carry `secret_like`: per-file `path`,
  `matches` and rule `kinds`, `binary_paths`, `media_withheld`,
  `answer_matches` (counted before the first redaction) and `total_matches`.
  `final/summary.md` adds one line, and the MCP read tools project the same
  record as `secretLike`. Read-only Ask, Plan and their reducers use the same
  pre-redaction answer counter: the selected final answer supplies the count,
  or the sum of the retained scouts when deep-scan returns a raw bundle.
- **Apply binds to the exact digest.** `meta.patch_sha256` is always the digest
  of the exact patch, so a redacted copy cannot pass the apply gate on any
  route. When the saved copy differs, meta records `persisted_patch: redacted`
  and `exact_patch_object` (the digest), and the exact bytes are stored in the
  private per-project object store that also holds revert anchors
  (`<project runtime>/anchors/objects`, mode 0600, never listed or served). One
  resolver serves deferred Apply, apply/check, `accept_clean_patch`, the
  `accept_risk` digest binding, thread contribution checks and RunFacts
  eligibility. A missing, unrecorded or corrupt object answers the typed 409
  `patch_exact_bytes_unavailable` before any tree is touched. The gate checks
  work-product integrity before the override-pending permission. An isolated
  candidate's object is written while its envelope still exists; if that write
  fails the envelope is kept rather than deleted.
- **Leaving the machine.** Local `apply`, `branch` and `commit` are allowed.
  `pr` is refused by `verifyAndDeliver` for a text match or a recorded blob-only
  binary finding, before the fresh verifier, the caller's authorization and
  any push.
- **Served files.** Text artifacts are redacted when served. Media and other
  binaries from run artifacts, `/v2/projects/:id/outputs` and
  `/v2/runs/:id/produced` pass the same content policy; a matching file answers
  409 `secret_like_content_withheld`. A raw patch artifact that still matches
  answers 409 as before.
- **Raw API.** A raw patch proposal with secret-like content is no longer
  refused early; scope, preimage and digest evidence are enforced unchanged and
  the proposal reaches saved artifacts only through the same capture.
- **Capture refusal.** A capture that cannot observe the changes (a thrown
  capture, a non-Git folder without a baseline, a `diff` that cannot read a
  file) remains a refusal under its own name: `capture_refusal` on the attempt,
  phase `workspace`, `manual_cleanup` for live effects, nothing rolled back.
- **Nested repositories.** A patch cannot carry another repository, so an
  untracked folder holding its own Git repository that the worktree's
  `.gitmodules` does not declare is left out of the candidate capture and of
  the in-place turn snapshot instead of failing them. The capture names it,
  top-relative, as `excluded_nested_repositories` (redacted) on the attempt
  and in the final work product's meta; a declared submodule is captured as
  its commit link. An isolated envelope is not kept for such a folder: its
  bytes go with the envelope.

Deliberate limits. A real secret an agent wrote stays in the tree or is applied
exactly: the agent already had a shell there, and the disclosure names the
files. The exact object and the post-turn snapshot hold the same bytes as the
tree; the object store has no garbage collection, so the object of an isolated
candidate that later loses its race stays there unreferenced. Applying `final/patch.diff` outside Claudexor applies `[redacted]`; the
notice says so. Directory results still fail closed on their content scan
(their manifest has no per-file `withheld` form). A token split across two
events is redacted per event, vendor session transcripts are outside this
boundary, and a host that keeps its own exact patch copy of a delegated child
owns that copy.

## 6. Main Execution Paths

Every public CLI mode (`ask`, `plan`, `agent`) and the
interactive REPL enters through the managed daemon and `/v2`; the CLI starts it
when needed and fails loudly if it cannot. There is no second in-process CLI
run/thread authority. The daemon remains the single scheduler and SQL row
writer while the mode pipelines below retain their distinct mutability.
The existing queue distinguishes `model` operations from `non_model` jobs
(Ask, Plan, Agent, maintenance and other commands). Admission has three axes:
`runtime.max_concurrent` is a GLOBAL cap across both classes;
`runtime.max_concurrent_non_model_jobs` and
`runtime.max_concurrent_model_operations` constrain their respective classes.
Each accepts a positive safe integer or `unlimited`. An absent key has no
implicit finite ceiling, including for library embedders; `0`, negatives,
fractions, unsafe integers and `null` are invalid. A previously saved finite
`max_concurrent` or explicit embedder `maxConcurrent` keeps its global meaning.
It is never silently converted to an Agent-only limit or discarded as an old default.

One queue and runner lifecycle remain. The scheduler selects the next eligible
job when another class or thread is blocked, preserving ordinary eligible order
and existing Delegate-child precedence. Same-thread turns stay serialized;
Delegate retains its eight-child, depth-one, single-overflow contract under both
class and global saturation. Compact queued/active identities carry only the id,
class, thread and Delegate fact; admission never scans retained command history.
Every runner, including a model's route preparation, dispatch and result
settlement, remains in total activity and the shutdown/replacement drain.
Cancelling a running operation does not release its permit before settlement.

Strategy width remains independent: `runtime.max_parallel_candidates` defaults
to 4 active best-of candidates or scouts, `runtime.max_deep_scan_width` to 8
scouts, and `runtime.max_council_members` to 4 distinct members (minimum 2).
These three settings remain finite positive safe integers. Removing an admission
ceiling does not change requested strategy widths, account quotas or provider
retry policy, and it is not a physical resource guarantee or an automatic governor.

All six keys live in user-global `config.yaml` (the selected
`CLAUDEXOR_CONFIG_DIR`); their environment overrides are listed in
[INTEGRATIONS](INTEGRATIONS.md#environment-reference). Environment wins over YAML.
Caps and their source are captured once at startup. Config changes do not resize,
preempt or cancel running work. Settings and CLI report `runtime.concurrency`
configured/effective values, source (`default`, `config`, `environment`,
`embedder`, or unknown when a reader lacks evidence), and `restartRequired`.
`default` identifies absence; a saved or environment `unlimited` is explicit.
An older engine's missing class/source fields remain unknown, never zero or 24.
The independent strategy widths remain present even when admission is unlimited.

Daemon status preserves total `active`, `queue` and `running`, adds class counts
under `admission`, and reports effective `capacity`. A model operation's optional
`admission` is a synchronous observation of that exact job: queued/active and
known global-limit, class-limit, busy-thread or stopping blockers. It is not a
provider-dispatch claim or a durable receipt. After runner settlement the live
admission observation is null; older engines omit the field. The CLI control-service
projection reads it alongside the current operation state without another poller.

Runtime caps remain file/environment settings, not writable through
`POST /v2/settings`. Unrelated settings writes preserve absent keys and every
explicit value, including old 24 and explicit unlimited. Use managed replacement
after work drains to adopt changed caps; external environment changes are visible
only at next launch. The number-or-unlimited payload requires a compatible client;
protocol major 3 alone does not make a finite-only decoder compatible. Updating
first-party clients is coordinated with the engine release: engine 4.0 requires
application 4.0. The existing `appUpdateRequired` path keeps the old working
engine until the app is updated; no numeric sentinel hides unlimited from an
old client.

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

Runs a bounded read-only swarm (`intent: audit`, default width 4, capped by
`runtime.max_deep_scan_width`, default 8; see [Main Execution Paths](#6-main-execution-paths)).
The CLI `claudexor ask --deep-scan` maps here. Each explorer writes a per-attempt
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

#### Directory execution

Explicit `execution.workspaceKind: directory` keeps the ordinary Agent pipeline
and its requested strategy. `execution.isolation: live` operates directly in the
actual execution folder; `envelope` materializes the entire selected `scopePaths`
in the existing workspace namespace. Stable `scope.root` remains the project
identity. No directory path initializes Git or creates a mandatory full-tree
baseline copy. A direct footprint records selected preimage hashes and later
output bytes; typed observed file changes may add outputs whose preimages are
unknown. An empty or partial direct observation never proves `noChanges: true`.
The CLI exposes these fields as `--workspace-kind directory`, repeatable
`--scope-path <relative-path>`, and `--in-place` for live execution. An omitted
footprint selects no existing inputs; `--scope-path .` explicitly selects the
whole folder. A selected path may be absent at preparation and become a new
output. Selection controls copied inputs and capture coverage, not the native
harness's filesystem permissions.

Read-only live directory Agents keep the source root and existing harness HOME
selection, but skip write-oriented input inventory, baseline hashing and output
capture. They return an answer without a file manifest or delivery payload.
Delegated runs retain scoped HOME; ordinary in-place runs keep native HOME selection.
Scope metadata and native adapter access enforcement remain unchanged. Readonly
run facts use `noChanges: true` for the absence of a write-backed result, not a
filesystem comparison proving the absence of changes. Writable live and isolated
directory work keep their existing preparation and capture.

Writable directory work produces a `files` WorkProduct. Its `files.manifest` and
`meta.manifest_sha256` address a complete file manifest in the existing run
artifact tree, including source/execution roots, selection, completeness, modes,
symlinks and full content references at `final/files/manifest.json` and
`final/files/content/<digest>`. The source root is the tree the selection was
read from: a delegated run's bound `execution.workspaceRoot`, otherwise the
project. A best-of winner therefore delivers back into that tree, and an apply
aimed at any other tree is refused. Completeness refers to the declared footprint,
not to an unobserved whole source tree. Null preimages mean proven absence;
`unknown` cannot authorize overwriting an existing target. Copied inputs remain
available for fresh verification, and new outputs outside the initial selection
are retained. The artifact endpoint streams exact manifest-referenced bytes;
bounded previews are not delivery payloads. Apply uses the existing command authority,
target mutation lease, verifier and per-file preimage checks against the original
source root. File contents, modes, directory entries and symlink targets retain
their filesystem meaning; special entries or unsupported filesystem operations
fail explicitly. Copy delivery supports apply, not Git commit/branch/PR modes.
A partial selection records `appliedPaths` in `final/delivery_state.yaml` and
keeps `applyState: not_applied` while changes remain. Only complete delivery
sets `applyState: applied`.
Explicit `discard` closes remaining copy delivery without applying or reverting
anything. A conflict preserves unrelated target edits; if application stops after
some entries changed, the receipt names the applied paths and retains the rest.
It is not a whole-tree atomic transaction. Direct effects are already in place
and have no promised full rollback. Binary, large, GUI-created and file-only
outputs are evaluated from their recorded files, never from an empty text patch.

#### Git execution

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
non-git roots keep the announced auto-init only when a Git-backed shape was
selected; explicit directory execution does not take this path. If a
non-transactional Git step fails after
repository metadata may have changed, that same event carries `partial:true`,
the failed stage, and the proven progress before the workspace failure; CLI and
Control timeline render the incomplete initialization as a warning instead of
hiding it behind the terminal error.

Supported non-Git shapes remain available: Ask and Plan do not require
Git there, and explicit directory Agent execution supports both live and copied
workspaces. The legacy live Agent convergence path retains its copied baseline
when directory execution was not selected. A Git-backed shape instead refuses
before a provider starts when the
executable is missing, is Apple's developer-tools launcher stub, or fails its
probe. Direct `/v2/runs` keeps eager admission. A thread turn is persisted first,
then runs the same preflight in the durable daemon job immediately before
provider execution, so its typed problem survives reload and Exact Retry can
replay the unchanged target and options after Git becomes available.

Read-only turns provision a scoped harness HOME (and no new worktree) so native state —
plan files, session rollouts, transcripts — never lands in the operator's real
home. Claude and Codex transcripts are the exception by construction: their
adapters point `CLAUDE_CONFIG_DIR` / `CODEX_HOME` at the resolved account's
registry store (or the default native store), so those sessions live in the
profile store and survive the home — which is what lets a later try of the
same attempt resume them even from an isolated envelope. A one-shot ask/plan
gets a DISPOSABLE throwaway home deleted after the run. A read-only turn of a THREAD instead gets a DURABLE per-lane home under
`projects/<project-sha256>/lanes/<threadId>/<harness>-<profileOrDefault>/home`
(a lane = thread + harness + credential profile), a sibling of `workspaces/`
and outside every worktree (INV-063). The lane home persists across turns so
the harness's recorded native session is reachable for Codex app-server
`thread/resume` / `claude --resume` on the next lane turn (INV-034); it is
removed only by thread purge, credential-profile deletion, or the orphan-lane
retention sweep. The in-place candidate of a delegated thread's turn (readonly
Agent included) runs in the same lane home, re-keyed to the account the
attempt actually resolved, so Ask, Plan, and Agent turns of one lane share it;
an in-run account hop moves the spec and the recorded home and account
together, on success and failure paths alike. Best-of and other disposable
candidates keep their per-attempt envelope homes. Which vendor state actually
lives in that home is per route: Claude and Codex keep transcripts in the
account store as above, while state a route writes under the generic `HOME`
persists across the lane's turns.

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
branch for 30 days and exposes explicit restore/purge routes; once
`purge_after` passes, restore is refused and the next disk-retention pass
purges the thread (see the thread lifecycle routes and disk retention below).

### Agent --n (race) / --create

Each candidate gets its own `WorkspaceEnvelope`. The orchestrator reserves
budget, runs the harness, captures diff from git, runs deterministic gates,
reviews/revalidates findings when requested, optionally synthesizes a new checked candidate,
and arbitrates. Best-of requests review; ordinary Single and `--create` do not
unless explicitly enabled. `--create` runs the same envelope pipeline with the
create-from-scratch intent (the CLI verb `claudexor create` maps here).
A candidate whose patch holds secret-like strings is an ordinary working
candidate: it is gated, reviewed on its saved copy and arbitrated like any other
(INV-062). A candidate whose changes could not be captured is excluded when
another working candidate survives; an all-uncaptured race, an uncaptured
in-place candidate, or an injected Delegate-belt failure remains terminal for
the race.

### Agent --attempts / --until-clean

One envelope is carried forward across repair attempts. `--attempts` stops at
the explicit cap. `--until-clean` has no fixed iteration cap and stops on
convergence, cancellation, budget/quota exhaustion, or no-progress stall after
eligible harness rotation.
Explicit review-off capped repair keeps deterministic gates, policy findings,
and work-report completion as its convergence conditions; it does not wait for
a model review that was never requested.

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

### Processing and account catalogs

The optional Processing contract follows the
[single advisory rule](DEVELOPMENT.md#processing-preference). Model calls carry
`options.processingPreference`; Agent inputs carry `processingPreference` through
the captured task, helpers, reviewers, children and continuation. Adapter-owned
preparation resolves the actual account's native control before ranking and budget
reservation. `serviceTier` remains an exact native override. Requested cognitive
model and native variant stay distinct, and the per-spawn model gate validates
the actual account's chosen variant. Result/event Processing receipts separate
request, submission and observation; sessions may remain mixed or unknown.
Codex's Processing cost owner qualifies ordinary native Fast against the
subscription allowance described in the [Processing rule](DEVELOPMENT.md#processing-preference).
The same paid-policy resolver prepares routing, reviewers and final native
execution; final preparation recomputes the billing basis for the actual
credential route rather than retaining another route's included verdict.
The prepared `ProcessingCostBasis.kind=included` describes prospective allowance;
its optional `debit: "unobserved"` states that the route reports no actual debit.
Execution events carry that same basis: controllable cash stays exact while the
reported total stays unknown until an actual cash receipt, and token valuation
alone never proves zero cash. Without a preference, each governed spawn passes
the receipt its work unit already chose as the optional `chosen` field of
`HarnessProcessingSpec`. Only the Codex adapter honours it today, so a Codex
retry, rotation or continuation keeps that intent instead of reading the next
account's native setting; other adapters ignore the field and keep reading each
account's own setting. Routing freezes the intent per routed harness lane in
`context/processing_intent.yaml` (`RunProcessingIntent`) before any attempt, and
every governed spawn and rotation of the lane passes it. Exact Retry carries it
across runs: for a request with `retryOf`
and no preference, the daemon runner reads the source run's record and hands it
to routing as the run input's `processingIntent`; the retry records that
original (with its provenance), not its own fallback, so a retry of a retry
keeps it. A source without the record (an older run) inherits afresh. A new
command, including a new thread turn, chooses its own initial intent.

Existing catalog endpoints provide an opt-in `view=accounts` declared in the
operation catalog. It includes every enabled compatible account with its
availability/problem and its own catalog, provenance and observation time; one
failed account does not erase siblings, and manifest hints or cached observations
never acquire a new provider timestamp. Explicit profile selection narrows only
that account, execution keeps its own current readiness and model admission, and
legacy queries keep their strict response shape.

The operation descriptor's `view` parameter is the negotiation marker. Raw
`/v2/model-sources` metadata is enriched only with `view=accounts`, including
`processingPreferences`, `accountCatalog` and a source's structural
`imageGeneration` facet (absent means no image operations); Agent capability rows
expose their contract separately. Account model responses carry `source` or
`harnessId`, `accounts` and `partial`; each row keeps `credentialProfileId`,
`availability`, `problem` and a nullable catalog. A missing catalog sets
`partial:true`, and a quota-blocked account may still have a readable inventory.
Catalog union serves discovery, not an inference entitlement or a capacity
assembled from different accounts. A network failure stays unknown, not proof of
absent authentication. Native array-only inventories have no observation receipt
and use a null observation time; manifest hints stay identified as manifest data.

### Prompt-cache lifetime

`promptCacheTtl: "5m" | "1h"` on `POST /v2/runs` and `POST /v2/threads/:id/turns`
(CLI `--prompt-cache-ttl`) chooses the native prompt-cache lifetime of every
session a run starts on a harness that translates it. Omission is Default: no
native control is set or removed, so vendor defaults, profile settings and the
inherited environment keep deciding. An adapter declares the exact values it
translates in `capability_profile.prompt_cache_ttls`; `GET /v2/agent-capabilities`
projects them as `harnesses[].promptCacheTtls` (empty when undeclared), and
`runControlKeys` lists the request key, so a caller gates on the routed harness
row instead of a harness name and keeps the key off engines that lack it.

The value is frozen into the task contract (`context/task.yaml`
`prompt_cache_ttl`). Continuations follow the `continueFrom` rule in the
[Control API](#7-control-api) map. Exact Retry replays the
recorded request and re-injects the frozen value when that request omitted it.
Routing forwards the value to every task-producing lane, the continuity summary
pass and reviewers only where the adapter declares it; elsewhere it is an
`ignored_settings` disclosure on `harness.started`, or `review.preflight` for a
reviewer. Delegation-belt children carry the parent's value in their own
request (`CLAUDEXOR_DELEGATION_PROMPT_CACHE_TTL` hands it to the belt), and
their routing applies the same rule. Best-of synthesis emits no
`harness.started`, so an undeclared synthesis harness runs without the lifetime
and without that disclosure.

The Claude adapter sets both `CLAUDE_CODE_PROMPT_CACHE_TTL` and
`CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` (main conversation and every other
request bucket, Claude Code 2.1.242 or later). A process variable outranks the
profile's lifetime settings; `FORCE_PROMPT_CACHING_5M` still outranks it. The
adapter never removes forcing or disabling controls. It discloses, once per
session, the ones known to govern instead: with the CLI's own truthy parsing,
`FORCE_PROMPT_CACHING_5M` against a requested `1h`, `DISABLE_PROMPT_CACHING`, and
a per-family `DISABLE_PROMPT_CACHING_<FAMILY>` only when the session asked for
that bare alias. A CLI whose init frame reports a version before 2.1.242 is
disclosed the same way; an unreported version proves nothing. Profile settings
files and managed settings are not inspected.

Each Claude attempt records a `PromptCacheTtlReceipt` in `final/telemetry.yaml`
(`attempts[].prompt_cache_ttl`): `requested` (the lifetime routed to that
session; the captured intent stays in the task contract), `submitted`
(configuration, not provider proof), `reason`, and `observed` with `write_5m_tokens` and
`write_1h_tokens` summed from the result usage's
`cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`. The
split describes what that usage reports, not which request buckets it
aggregates. A result without the split makes the attempt's counts unknown;
zero writes are `none`, not disabled caching. Lifecycle, outcome and cost never
derive from the receipt, and `inputTokenUsage` keeps its three keys.

### Caller-owned model operations

#### Image generation and editing

`ImageCallRequest`, uploaded with `purpose: "model"`, uses `requestKind=image`
(omitted stays text). Kind joins stored parameters and same-key identity; the
existing command, queue, flush barrier, custody and whole-digest ACK serve both
kinds, without another scheduler or resource purpose. Request/result schemas own
verbatim edit bytes, explicit options, requested/observed model, unknown cash and
usable images beside rejected siblings. Rejected or absent images mean a failed
command with a ready result; viewing/sending remain caller actions. Codex image
model ids are hints, not entitlement or an allowlist: explicit models pass unchanged,
without the text catalog. The shared resolver selects source/model/account apart
from the conversation model; only fresh confirmed auth refusal revokes the bound
credential generation. Subscription never falls back to API. The adapter records
its wire anchor/bounds, sniffs magic bytes without decoding and derives a turn-id
header from the operation id, claiming no provider deduplication.

Large edits parse twice and validate base64 on the daemon thread; near-cap requests
can delay other clients. Admission quota refusal is `subscription_window_exhausted`;
provider image exhaustion is `image_generation_limit_reached`. Aggregate byte limits
use `image_request_too_large`/`image_response_too_large`; an oversized individual
edit image returns `invalid_request`.

Live model enumeration is qualified by the adapter's declared credential routes:
a declared producer is used only on a known supported route, otherwise manifest
truth applies. Codex account enumeration is native-session-specific, so API-key
and unscoped legacy queries keep their manifest source instead of borrowing a
subscription catalog. A failed supported live inventory stays unverifiable and
never falls back to a convenient manifest to admit a model; under advisory
absences, an unverifiable answer or manifest miss sends the explicit model
unchanged (above). Authenticated raw sources declare
`inventoryAbsence` on `ModelAdapter`: omitted means authoritative, while Codex
declares advisory, so a successfully read catalog lacking an explicit model
permits the exact Codex request and failed catalog acquisition stays a typed
failure. Auth and model-scoped quota still participate in account selection. An
authoritative miss keeps its own cause; a pool containing model/general
unavailability never inherits a quota-only reset promise from other accounts.

Claude's producer is the prompt-free `initialize` handshake of the installed
`claude` binary (`harness-claude/src/model-probe.ts`): one stdin frame, the
picker rows of the `control_response` (`value`, `displayName`, `resolvedModel`),
exit on EOF, never `--model` (the CLI echoes it as a row), `--setting-sources ""`
and `--strict-mcp-config` (no hooks or settings echo), model-override env
scrubbed. Scopes (owner decision 2026-09-24): a `config_dir_login` profile is
probed under its own config dir and keychain bridge, an `api_key`/`oauth_token`
profile with its own credential in its runs' env var under a scratch HOME (cache
keyed by profile id, never a secret), so the account view carries the account's
own rows; the unscoped listing runs credential-free under a scratch HOME with
non-essential traffic off and describes the binary alone. The probe resolves the
binary exactly as the spawn layer does (a caller's PATH patch replaces the
normalized PATH). Rows carry `origin` (`live`: picker selectors and their
resolutions as pinnable exact ids; `hint`: the frozen `CLAUDE_KNOWN_MODELS` ids
appended so presence never shrinks below the manifest) and diagnostic
`resolved_model` (the row id travels). The answer is total: any failure yields the
hint rows alone, reported as `source: manifest` with its frozen `verifiedAgainst`
stamp, not a live `api` claim. One cached single-flight capture per scope and
binary identity (realpath, inode, size, mtime; `harnessBinaryIdentity` in core)
lives an hour, a failure a minute, so an in-place CLI update is re-read without a
daemon restart. The `--help` effort memo, the readonly-flag probe and the
`--version` read behind the snapshot-trust gate use the same identity and follow
a run's PATH patch, so every question about "the binary this run executes" asks
that binary. Two stated bounds: the memo is one slot (a patched run alternating
with host-keyed callers re-reads `--help`, one bounded spawn per alternation),
and a relative patch PATH entry resolves as the daemon sees it, so a binary
reachable only through a project-relative entry falls back to the snapshot ladder.

The engine also accepts one raw model generation independently of Agent Runs.
`ModelAdapter` in core and the model-operation schemas define caller-owned
messages, function tools, tool choice, generation options, account selection,
native continuation and the observed result. The caller keeps its system prompt,
conversation, tool execution and cognitive loop; no Run, Thread, plan, workspace,
review loop, model fallback or internal compaction is created.

The Codex transport in `harness-codex` uses a selected managed ChatGPT profile,
the official CLI for an expired-token refresh and the raw account's model
catalog. Discovery varies with the declared client version, so a missing row
proves no minimum-version or entitlement refusal. The transport declares ITS OWN
verified level, `CODEX_HTTP_CLIENT_VERSION` (`http-client-version.ts`), raised to
a newer selected Codex CLI and never below the constant. The release-tested
native baseline is a different fact from this HTTP minimum and from the
managed install target. Installing a newer selected CLI CAN raise the HTTP
catalog's declared client version and change which model rows the same account
sees; that visibility is not proof of entitlement or generation. The account
view carries each catalog's declared `clientVersion` and source. Selected-account discovery can negotiate `includeAdmission=true` with
`requestedModel` for those facts and `admission: {requestedModel,
inventoryAbsence}`, which permits an attempt without a synthetic model row or
generation claim; the legacy query keeps its exact shape. The
constant moves with a recorded catalog fixture pair (`fixtures/models-http-*.json`)
whose shared rows must stay identical. Refresh work is serialized per canonical
managed home; a cancelled caller cannot release another past a still-live
refresh, and each caller rereads current authorization. Selection hands its
exact-profile catalog to the invocation, which rechecks the account fingerprint; no catalog or credentials are cached across operations, and an
unknown fingerprint keeps fresh discovery and cannot authorize native
continuation reuse.
Auto model operations now examine fresh per-account catalogs in selection order:
listed accounts precede advisory misses; a soft observation (a live pre-progress
refusal, or a served-model substitution of a non-preferred account) moves that
account/model behind both groups, and a temporary capability mark behind the soft
ones, because a soft observation may belong to one request.
`preferredProfileId` orders accounts within a group; it cannot override a mark,
a refusal or a listed alternative. History is the one exception: an unmarked,
unrefused preferred account to which a message's native continuation is bound
stays first even when its catalog omits the model, because that history replays
only there. A marked or refusing one yields, and the selected account rejects
the history locally with `invalid_continuation`. The resolver retains only
catalog hashes for invalidation, never catalogs for admission across operations.

A Codex inference HTTP 400/404 with an explicit model-not-found code or a narrowly
recognized model refusal becomes `model_capability_refused`. Explicit vendor
`model_not_found` after dispatch retains the existing model-scoped unusable
verdict (`capability_refused`); both Agent and model selection still read it.
Text evidence and `model_not_supported` demote through capability marks and the
shared observation; they never make an account unusable or disabled. Quota, authentication and
billing retain their existing channels. A pinned operation returns the typed
refusal without a retry signal or new mark. The host may submit one separate,
identical auto request with `retryOfOperationId`; the engine keeps one dispatch
and one route per operation. Success on the other account confirms the original
mark. An equivalent refusal retains both accounts' provisional evidence and
returns the first problem with both accounts' reasons; the next request can then
reach an unmarked third account. The host retry signal requires an unmarked
eligible alternative, so known deficiencies cannot authorize another retry. Correlation requires the same
source, model, messages, tools, options and continuation, and can be claimed once.
History continuation bound to the refusing account withholds the signal
(`retryBlockedBy=native_continuation`): another account rejects it before inference.

Any other definite refusal before generation on an auto operation (HTTP 4xx
other than 401, 408, 409 and 429; not a code that sign-in, quota, rate limits or
the processing fallback own; not a typed request fault such as a named non-model
parameter, `unsupported_parameter` or an exceeded context length) keeps its own
code and gains the same retry context with `capabilityKind=unclassified`. Both
kinds record the shared pre-progress refusal observation at once (Agent runs read
it too); an older in-flight refusal never undoes a newer model operation's
service. Its correlated
retry settles an unrecognized refusal: service elsewhere creates an ordinary
confirmed mark with the refusal's structural diagnostic as reason; another
refusal marks nothing for the first account, because the request itself may be
at fault. Every capability-attributed refusal also carries `modelMarks[]`, the
live marks of that harness and model with each mark's episode start (`since`),
and, for auto, `alternativeRemains`, whether another eligible account without a
capability mark is left (one sweep answers this and the retry grant), so a host
can tell an ongoing case from a new one without a timer.

The process-local capability ledger has a four-hour TTL
(`MODEL_CAPABILITY_TTL_MS`). Expiry admits one concurrent probe; success clears
it, a refusal renews it, and an uncertain/cancelled probe delays the next probe
by four hours. An in-flight probe sorts last, but never makes the last account
unreachable: a concurrent operation may dispatch there without owning the probe.
Correlated retries prefer any unmarked comparator over all capability rows,
including expired marks. Changed catalog content, account identity or managed credential
generation clears marks early. Codex computes a separate opaque capability
fingerprint including the token's plan claim: a plan change does not change
`accountFingerprint`. It is an engine-internal invalidation token that public
catalog responses omit. Changes are recognized on the next live catalog acquisition; the Accounts
display cache stays separate from execution admission.
Overlapping requests bind the credential/catalog generation; late outcomes cannot
recreate an invalidated mark or erase newer evidence. A login holding the
credential-mutation window makes the generation unknown, not changed: operations
are served, nothing is recorded, cleared or confirmed, and marks keep ordering. The ledger is bounded to
512 subjects/attempts and forgets evidence on restart.

Operations created with `captureRoutingEvidence=true` retain selection and
differential evidence in their receipt, detail and result; routing evidence read
with `includeCapabilities=true` exposes the temporary marks beside existing
routing observations. Both are opt-in, so strict clients of the earlier shapes
keep validating. The
[host contract](MODEL_CAPABILITY_ROUTING.md) specifies the request, refusal,
receipt and Accounts fields, compatibility signal and invalid-retry handling. The real daemon/control-API fixture in `model-services.test.ts` verifies
A's exact HTTP refusal, B's service, the status mark and strict pin behavior;
the same SQL daemon with a mocked adapter covers unrecognized refusals (service
elsewhere confirms a mark, a second refusal marks nothing, every excluded failure
class leaves ordering unchanged) and the soft-before-mark fallback order.

Its single inference POST follows a committed dispatch receipt and a completed
`flushed()` barrier. A barrier failure or cancellation while the adapter still
waits inside that callback sends nothing and keeps `not_started` with the attempt
stamp and route; once the callback returns, an uncertain outcome stays unknown.
Exact JSON bytes stream with Content-Length. `request-delivery.ts` observes public
callbacks on the existing dispatcher; its lazy `dispatcher-accessor.cts` preserves
native cold initialization, proxy, TLS and pool ownership. Positive connector or
incomplete-upload proof yields `transport_not_delivered`, and `ModelOperations`
refines the terminal to `not_started` only after publishing that proof, keeping
the attempted-send stamp and route; full handoff, unobserved transport, crash and
publication failure stay unknown, and no adapter retry is added.
Canonical instruction messages keep their roles and ordered text parts in
Ouroboros history. Because this subscription backend rejects `system` messages in
`input`, Codex's wire projection maps each canonical `system` message to the
high-priority `developer` role; existing `developer`, `user`, `assistant` and tool
messages keep their roles and order. Callers that provide both canonical `system`
and `developer` roles share the provider's `developer` level on this route; the
caller's history keeps the distinction. The string-valued
`instructions` field is always empty here, and its field limit is distinct from
the model's token capacity. Responses SSE is translated structurally, including
image blocks, original tool IDs and complete native output items. Unknown
model/window/usage/cash stays unknown; `maxOutputTokens` and `temperature` are
explicit unsupported options, not silently dropped, and CLI compaction percentages
do not reduce catalog capacity. Other installed harnesses remain Agent
capabilities, not raw model sources.

Catalog `inputModalities` is declared metadata (the `ModelCatalogEntry` field
states its semantics), not an admission gate: a text-only list or a missing model
row never stops a request on modality grounds. User and tool image blocks and
replayable native continuations are serialized and sent exactly as for any model, and the
provider's own answer decides. The declaration does not prove that a given image
reached or was understood by the model.

The optional top-level `nativeContinuation` carries live transport state in the
same private request/result resources, apart from historical assistant
`codex.responses.v1` output items. Omission preserves stateless result shapes;
null starts an empty caller-owned turn. `codex.turn.v1` binds the first successful
`x-codex-turn-state` response header to the actual source, profile, account and
model; matching calls replay it unchanged even after an incomplete body, and
changed or unknown route identity starts empty without refusing generation. The
caller keeps it through tools, steering and compaction within a live turn and
clears it at a new turn or cold restart; there is no daemon state map, checkpoint
token, automatic retry, or token in public receipts and usage.

Historical assistant `codex.responses.v1` items replay only under the exact
account, profile and model that produced them, so the binding stays truthful when
the vendor answers with another model. A turn the same account served with
another or an undisclosed model is sent through its canonical content and tool
calls with the original tool IDs instead. A message with nothing to send that way,
a changed or unknown account, or a continuation of the wrong format or payload
shape refuses with `invalid_continuation` before dispatch. That projection drops
an assistant turn's native item boundaries, phases and encrypted arguments; the
original payload stays in the caller's history. The live transport continuation
binds to the model the terminal response named, so a turn another model answered
is not replayed under the requested model, and an unknown model leaves it unbound.

`ModelOperations` uses the existing daemon command store, idempotency lookup,
queue capacity, cancellation and terminal boundary. Model runners use their class
limit and any explicit global limit described in [Main Execution Paths](#6-main-execution-paths);
their permit stays occupied until runner settlement, including cancellation, but
not while awaiting a client's result-digest ACK, and they are not Agent Runs. The command store holds content hashes and resource references, not the
conversation. A model-purpose upload uses `ResourceStore`'s atomic finalization;
its contents are not filtered for secret-like text, and it cannot resolve as an
ordinary Agent attachment. Engine authorization never enters the model payload.
This narrow content boundary is INV-062, not a general bypass.

Result GET returns exact digest-bound bytes without acknowledging them. A client
accepts custody before ACK and recovers a lost local reply through the same
operation identity. Request bytes are released at terminal state, response bytes
after ACK and unacknowledged responses 30 days after readiness; existing
maintenance reclaims crash residue. A recorded response expiry stays the release
timestamp through delayed cleanup and restart, while an ordinary ACK uses its
actual release time. Redundant uploads on an idempotent create are released
without touching another live command's input. Compact model receipts and
idempotency bindings are excluded from Agent history age/cap pruning, so an
expired or acknowledged result cannot trigger another generation. A provider
refusal, a never-dispatched operation and an unknown outcome after engine death
are separate facts. A crash after response bytes are published but before the
terminal SQL commit keeps an unknown outcome; uncommitted bytes cannot certify a
completed response and are reclaimed as crash residue.

Callers may request `captureEffortEvidence=true` on the model-operation POST,
discovered through its query descriptor, to retain the adapter's typed
`effortResolution` receipt. Omission and false strip only that field before
immutable result publication, preserving strict legacy result bytes. The literal
true choice is part of command parameters and idempotency identity: a rejoin keeps
it, and changing it under the same key conflicts. GET returns the stored bytes and
original digest for ACK without projection. The choice never changes the
inference request, real provider `appliedOptions`, dispatch or generation count;
historical results are unchanged.

Callers may independently request `captureFailureEvidence=true` on the same POST,
discovered through its query descriptor. Omission and false keep the legacy
command identity and strict result shape; true is bound to the idempotency key
and cannot change during a create rejoin. It is transport evidence intent, not a
generation option. For failed, incomplete or locally rejected processing,
the optional private `failureEvidence` in `ModelCallResult` holds every byte
returned to the reader, encoded reversibly, plus the original exception, causes
and aggregate members. SSE, non-success inference HTTP bodies and post-dispatch
fetch errors share one capture owner. An absent response contributes zero body
bytes. `bodyComplete` means observed reader EOF, independently of provider
terminal framing; an unreceived suffix is never claimed captured. Successful
completed results carry no duplicate wire. The evidence follows the existing
result resource, GET, ACK and expiry; only compact structural diagnostics enter
the problem, event ledger and status.
For a failed or unknown stream whose reader saw bytes, compact problem context
also carries `timeToFirstChunkMs`, `lastChunkAfterResponseMs`,
`silenceMs` and `largestSilenceMs`; `lastEventAfterResponseMs` and
`eventSilenceMs` measure the last parsed SSE event, so a later comment heartbeat
or unfinished frame advances only the chunk clock. All offsets start at response
headers, not request dispatch. They are measurements, not an idle watchdog or
retry signal: a missing terminal frame stays `transport_unknown` under the
existing custody/no-blind-retry rule.
Coherent provider terminal facts precede message conversion: unusable completed
or incomplete output keeps its provider outcome and usage, with null message,
`response_rejected`, `response_received` dispatch and failed operation lifecycle.
Provider failures keep their typed problem even when irrelevant output is
malformed. A caller must distinguish this known rejection from unknown dispatch;
neither authorizes an engine retry or a never-sent/free claim.

An opted-in advisory request may return `processing_unavailable` with context
`generationStarted: false`, `processingFallback: "standard"` and
`processingRefusal: "capacity" | "unsupported"`, only for a non-success HTTP
response: HTTP 429 `resource_unavailable` on submitted Flex, or HTTP 400
`unsupported_parameter` for `service_tier` on submitted Fast/Flex. An explicit
native `serviceTier` override never becomes an advisory fallback. The operation
still records the physical send and `response_received`: the proof concerns
generation, not dispatch, and a Standard follow-up is the caller's separate
request and reservation. No engine retry is added; generic auth/quota failures,
timeouts, unknown outcomes and in-stream failures provide no such proof.

The operation catalog and generated endpoint reference below are the wire SSOT.
Account Auto reuses the existing compatible pool, preferring the prior suitable
profile; an explicit pin never rotates. A typed catalog refusal excludes that
account for the rest of the selection epoch and hands selection to the next
candidate, while a pin refuses with that same typed refusal. A failed quota
observation feeds the pool's existing quota owner, with no second retry planner
or account store. Cooldown evidence is written only when the vendor named a reset
time or retry delay; a refusal carrying neither creates no cooldown rather than a
block until an invented time. Pool refusal is projected
from typed per-account causes: an all-quota pool is
`subscription_window_exhausted`, an all-authentication pool is `auth_required`,
and a mixed, unknown, empty or disabled pool stays unavailable with compact
`poolCause` evidence; `credential_pool_exhausted` alone does not prove quota
exhaustion. Legacy selected-account catalog reads obey the same current quota admission
without starting a generation. The opt-in account view enumerates enabled
inventories separately, as described [above](#processing-and-account-catalogs).

A terminal response may disclose a model other than the requested one, with no
error and nothing in the account's quota. The result then carries the optional
`modelMismatch` fact (`requested`, `observed`), set only for a completed or
incomplete response whose known observed model differs by exact id; outcome,
message, usage and custody are unchanged, and the engine neither retries nor
discards the generation. Accepting it or creating another operation is the
caller's choice. The same composition point records a
`ModelSubstitutionObservation` in the daemon's in-memory
`ModelSubstitutionLedger`: bounded, newest-wins per account and requested model,
kept 30 minutes (observation retention, not a vendor reset time), never cleared
by a later success, voided with the credential generation at the unusable
ledger's call sites, and never recorded while a login of that harness holds its
credential-mutation window (#363). While one is live, Auto selection for that
model ranks the account after every other selectable account without a capability
mark, oldest observation first, so a fully marked pool takes turns; it never excludes an account or
exhausts a pool, and a pin or usable preferred account resolves first. Agent Runs
do not pass it.

Catalog `provenance: "provider_http"` means the adapter read and validated a
successful upstream HTTP catalog response at `observedAt`; reuse keeps that time.
Other provenance values, including historical diagnostic strings, certify no
provider contact. The control API forwards these adapter-owned fields without
turning loopback reachability into upstream evidence, and catalog failure returns
the typed problem, never a refreshed timestamp on an earlier catalog.

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
`seq` before opening the stream. Its HTTP server keeps idle keep-alive sockets
for 65 s (longer than clients' idle-reuse windows, such as httpx's 5 s, which
would otherwise race the server's close), allows 66 s for request headers, and
does not bound the receipt of a request body, so a large upload during a busy
period is not cut; none of these limits applies to responses or SSE streams.
Once stopping, it closes each kept-alive socket as soon as its response finishes,
so the longer keep-alive window never delays shutdown.

HTTP handlers stop at entry when the client has already disconnected. Run detail
checks again after addressed lookups and before its cursor/artifact projection;
yielding run pages and thread projections stop before further expensive reads.
A normally consumed request body is not a disconnect: Node may mark it destroyed
while its response socket remains live. Already-running synchronous work cannot
be interrupted, and disconnect does not undo a mutation already admitted.

An admitted continuation whose predecessor record or run directory disappears
before execution fails with `continuation_predecessor_unavailable` (404, not
retryable), before orchestrator or harness startup. It never becomes a fresh run.

The authenticated read-only `GET /v2/daemon/status` exposes daemon health and
current memory facts (heap used/limit, RSS, external bytes, effective heap args),
plus the first normal-admission snapshot. It is also available in recovery-only
mode, where admission memory is null until normal admission has opened. Sampling
does not force GC or materialize retained commands; total job count comes from
SQL and active/queued counts come from the existing live runner lifecycle.
`loop` carries the last completed ten-second window of event-loop facts: delay
p50/p99/max from `monitorEventLoopDelay` (sampled at 10 ms, so an idle loop's
p50 sits near 10 ms, and reset every window), the `eventLoopUtilization` busy
share, and the GC pauses a `PerformanceObserver` saw (count, total, longest).
It is null until the first window completes; a stalled loop rolls its window
late, so `windowMs` grows with the stall. `claudexor daemon status` prints the
same window as one line. The status route reaches the daemon in process, so it
answers while the loop is merely slow.
The `store` facts report flusher state, interval, last barrier and lag, WAL bytes,
open obligations, busy waits, request-thread COMMIT timing since the store opened
([SQLite engine store](#sqlite-engine-store)), integrity and current import
progress. A field is null when its owner cannot observe it; pending integrity is
not a successful check.
The `routes` array in `timing` adds completed response/disconnect count and p50/p99/max latency
by HTTP method and operation-catalog template, both `lifetime` (since process
start) and `window` (the last completed loop window). SSE latency includes the
stream's whole lifetime. Unknown URLs/methods share `OTHER <unmatched>`; raw
URLs, query values and identifiers are never retained. At most 256 route keys
have two fixed-capacity microsecond histograms, with two significant digits;
maxima are measured directly and rounded to a microsecond. Before the first
window, window metadata and per-route windows are null; an empty completed
window has count zero and null latencies. The status request itself is counted
when its response finishes, so it appears in a subsequent read.
The `worstSync` array in `timing` retains only the 32 longest instrumented synchronous sections
since start (descending, later samples win ties), with operation, duration and
timestamp. Labels cover `store.begin_immediate`, `store.commit`, `store.external_write`,
`control.run_detail`, `control.run_summary`, and `scope.persist`; scope persistence
measures synchronous serialization, not its asynchronous file writes. These
samples may overlap and do not identify the cause of a delay. `store.commit`
also exposes lifetime `p50_ms`/`p99_ms` using the same histogram precision.
Older engines omit the new optional fields. The catalog still points to the
same `ControlDaemonStatus` response schema.
No memory, loop, timing or store measurements impose automatic admission thresholds.

`POST /v2/handshake` returns top-level `storeId`, the durable engine store's UUID (stable across restarts, absent when unavailable), only to a request sending `X-Claudexor-Store-Identity: 1`, so older strict same-major clients keep the legacy shape; a run 404 is meaningful only together with the same `storeId`.

Retained task-group reads are composed by `sqlControlReadSources` and
`readTaskGroupRuns`. The `taskGroupPage` method of `SqlCommandQueries` selects group membership
before projection, using the summary expression indexes and descending
`(created_at, id)` keysets. It selects at most `limit + 1` scalar rows from the
existing served-generation authority, without prompt, result, question-body or
artifact hydration, a full-history traversal, or a count. Selected jobs reuse
the body-free `readRunObservations` snapshots used by wait-many. A member's run
ID is null until actual binding; its accepted job ID remains addressable.

The served view hashes the set of partition name/epoch identities. A cursor
binds that view, group, lifecycle filter, durable store and last returned key.
An actual visibility change invalidates it; relinking the same project identity
does not. Byte pagination advances only past returned members and refuses an
unreturnable first member. CLI/MCP/HTTP are thin one-page projections of this
owner. The bounded wire contract and reconnect example live in
[Integrations](INTEGRATIONS.md#observing-and-directing-an-existing-run).
The `current_served_generations`/`retained_only` qualifiers describe current
visibility, not a permanent roster. Reads add no execution or approval authority.

<!-- BEGIN GENERATED ENDPOINTS (node scripts/gen-endpoints-doc.mjs; do not edit by hand) -->
- `GET /healthz`
- `GET /v2/account-pools`
- `POST /v2/account-resets`
- `GET /v2/account-resets/:id`
- `POST /v2/accounts-migration/rollback`
- `GET /v2/accounts/routing-evidence`
- `GET /v2/agent-capabilities`
- `GET /v2/credential-profiles`
- `POST /v2/credential-profiles`
- `DELETE /v2/credential-profiles/:harness/:profileId`
- `PATCH /v2/credential-profiles/:harness/:profileId`
- `GET /v2/daemon/status`
- `GET /v2/filesystem/directories`
- `GET /v2/global/events`
- `POST /v2/handshake`
- `GET /v2/harnesses`
- `POST /v2/harnesses/:id/auth-readiness`
- `GET /v2/harnesses/:id/models`
- `POST /v2/maintenance/gc`
- `GET /v2/maintenance/harnesses`
- `POST /v2/maintenance/operations`
- `GET /v2/maintenance/operations/:id`
- `POST /v2/maintenance/operations/:id/cancel`
- `POST /v2/model-operations`
- `GET /v2/model-operations/:id`
- `POST /v2/model-operations/:id/ack`
- `POST /v2/model-operations/:id/control`
- `GET /v2/model-operations/:id/result`
- `GET /v2/model-sources`
- `GET /v2/model-sources/:id/models`
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
- `GET /v2/runs/:id/events/:id`
- `POST /v2/runs/:id/interactions/:id/answer`
- `POST /v2/runs/:id/messages`
- `GET /v2/runs/:id/produced`
- `GET /v2/runs/:id/produced/<path>`
- `POST /v2/runs/:id/retry`
- `GET /v2/runs/:id/run-again`
- `GET /v2/runs/:id/time-limit`
- `PATCH /v2/runs/:id/time-limit`
- `POST /v2/runs/wait-many`
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
- `GET /v2/task-groups/:id/runs`
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

The control API, model operations and harness maintenance run inside the
daemon process and reach its RPC dispatcher in process (`DaemonLocalClient`):
there is no socket round trip and no transport timer, so a busy event loop makes
such a call slow rather than failed. Params, results and problems keep the
socket's JSON value semantics, and both transports rebuild problems through one
projection. Socket clients (the CLI, the stdio bridges, runtime replacement and
the startup transport proof, which dials the socket itself) keep the ten-second
transport bound: a timeout answers `503 daemon_busy`; connection failures, closed
sockets and invalid responses answer `503 daemon_unavailable`. Both are retryable
and preserve an unknown mutation outcome. Daemon-authored refusals keep their
status, code, safe context and required actions through RPC and HTTP, including
continuation chain heads. Request validation remains a typed 400; transport does
not retry automatically.

- `POST /v2/runs` with `continueFrom: <runId>` continues a terminal run of this
  daemon — stopped, limited, cancelled, interrupted or finished — as a new
  run, the next link of its continuation chain. One shared admission rule
  (`continuationRefusal` in `@claudexor/schema`) answers typed:
  `predecessor_unknown` (404, also another daemon's ids), `predecessor_live`
  (409), `continue_from_with_thread` (400; a thread continues through its
  turns), `continue_from_unsupported` (400; only a single-candidate Agent or
  an Ask run can carry the predecessor's session — not plan, best-of,
  attempts/until-clean, deep-scan or council) and `continuation_superseded`
  (409, context `head` = the newest link of the chain). The daemon applies it
  inside the enqueue RPC immediately before acceptance, so the accepted
  successor command is the durable claim: while the predecessor's command
  record is kept, its successor claim is exempt from command pruning, preserving
  one accepted successor across every ingress and restart. After the predecessor
  record is pruned, its id is unknown and the successor can be pruned on a later
  pass. A successor refused before
  its run started holds no claim, one that ran and failed stays the head.
  Exact Retry and `rerun_with_feedback` replay the original request, so for a
  successor that ran they answer the same `continuation_superseded`: the
  caller continues the head instead. Omitted `mode`, `scope`, `execution`, `harnesses`, `primaryHarness`, `model`,
  `models` and `promptCacheTtl` come from the predecessor before request defaults. Setting either
  `harnesses` or `primaryHarness` inherits neither; setting either `model` or
  `models` inherits neither. With no caller model choice, the first try pins the
  predecessor's attested model only when the target route lists that id, ahead
  of a changed settings default; otherwise the inherited request/default applies.
  The receipt discloses the actual `observedModel`; terminal telemetry compares
  it with the composed first try's requested model, including an inherited pin.
  An explicit `promptCacheTtl` replaces the inherited lifetime, but the request
  has no spelling for Default, so a successor of a run with a lifetime keeps one;
  going back to Default takes a new run.
  Nothing else is inherited;
  `prompt` is the
  caller's continuation text — empty only here. The first try of the
  successor's first candidate attempt is planned through the in-run
  continuation planner from the predecessor's session capsule and terminal
  `resumable` facts: `native` (same account, resume by id), `native_moved`
  (the session moved into the successor's account store), `packet` (a fresh
  session briefed by the evidence index) or `fresh` (the predecessor did no
  work: the index carries its work order); another harness gets the packet,
  and `continueCarrier: "packet"` forces the re-brief. A native carrier never
  resends the original prompt: the continuation notice (cause, any undelivered
  input) plus the caller's text is the user prompt, and a follow-up on
  finished work uses the caller's text alone when delivery is certain; an empty
  follow-up gets a neutral continue notice, including with a packet carrier
  and when a rejected native first try falls back to a later in-run packet.
  A different-root notice includes the predecessor's saved `final/patch.diff`
  path when available. If no capsule/workspace recorded a root, the predecessor's
  inherited project scope root is the comparison baseline. The chain's work order
  (predecessor's work order + continuation text) is recorded as
  `context/work-order.md`. An earlier continuation's caller text without a
  confirmed first-try delivery is carried as an uncertain reference to reconcile,
  never blindly replay; the receipt reports `inputDelivery: "uncertain"`.
  Each uncertain input stays separate across run successors and unstarted
  in-run retries, including a stopped ancestor's admitted steering message
  without delivery proof, until a newer run of the chain has started a process
  with it. Inline quotes share a 2,048-character
  budget filled newest first; every cut gives the shown and complete character
  counts and an absolute path to the complete text. The engine reuses the saved
  work order when it contains that text, otherwise it saves a context file.
  That try's `run.continuity` receipt names the
  predecessor (`from.runId`) and `workspace` `same_root` / `different_root`;
  its later tries continue in-run with the predecessor's sticky `acted` and
  evidence sources for the whole predecessor chain (steering delivery, retained
  answer, unresolved tools and artifact paths). A later native rejection or
  typed-limit hop whose session cannot be moved re-briefs from those sources
  as well as the successor's own run, so a
  failed first try never falls back to a context-free replay. Workspace: an
  explicit `execution.workspaceRoot` or live isolation wins; otherwise a
  predecessor whose isolated envelope was kept (below) is continued IN that
  envelope — same path, files and base, one cumulative patch. Delegate-belt
  children start from the project base even when their predecessor has a kept
  envelope; that predecessor's custody stays retained. A successor that
  fails before adoption remains the head: continuation walks its ancestors to
  the nearest retained envelope and available session/evidence. An Ask head
  leaves the retained tree available for a later Agent successor. Adopting that
  ancestor's tree or explicitly selecting the same retained root reports
  `same_root`, even when the Ask ran at the project base.
  Predecessor
  references are recorded in `context/continuation.json` before announcement;
  a failed head's `resumable` projection names its inherited carriers. Without
  an ancestor's terminal block, its retained custody supplies the cause, or
  `host_restart` is derived from that ancestor's interrupted state. `GET
  /v2/runs/:id` projects `continueFrom`, `resumable` (the engine's terminal
  block with the CURRENT workspace overlaid; a run the daemon found running at
  its restart gets a derived block, cause `host_restart`, from its session
  capsule and custody), `continuity` (the per-try receipts; run detail only —
  list rows omit it) and `retainedEnvelope` (root, disk use, cause).
  `continueFrom` appears in `GET /v2/agent-capabilities` `runControlKeys`.
- Threads are the chat/session-first conversation SSOT (run lineage + native
  harness sessions). A thread declares a `workspace.mode`: `in_place` (default)
  mutates the live project tree; `isolated` keeps a persistent git worktree per
  thread once a mutating turn materializes it; `delegated` runs every turn in
  the caller-owned `workspaceRoot` bound at creation (External-orchestrator
  workspaces, above). It also carries sticky routing — `primaryHarness` and
  `eligibleHarnesses` — that its turns inherit; `PATCH /v2/threads/:id` renames /
  archives a thread (title + open/closed state) and switches the sticky
  routing. Its optional `folder` label is daemon-owned and persisted with the
  thread; the client derives folder sections from those labels rather than
  keeping a second local folder store. A PATCH that changes only `folder` is
  filing, not activity: it keeps the thread's `updatedAt`, so the list order
  and the CLI `--resume` target (the most recently updated active thread of
  the project) do not move; any other field still bumps it.
- `POST /v2/threads/:id/turns` enqueues a follow-up run anchored to the thread.
  Mutating Agent turns run IN-PLACE in the execution tree — the live project for
  an in-place thread, the thread's worktree for an isolated thread, or the bound
  workspace of a delegated thread. Read-only turns reuse an existing isolated
  worktree or read the stable project without materializing one (a delegated
  thread's read-only turns read its bound workspace) — so the
  routed harness resumes its own native CLI session and the next turn sees the
  work. A best-of-N race runs candidates in isolated envelopes and auto-applies
  the winner to the execution tree. When a turn runs on a lane that has not seen
  the whole conversation (a lane switch or an A→B→A gap), the engine hydrates it
  with a bounded continuation packet delivered as `context/THREAD.md` and
  discloses it via a typed `session.continuity` event + a `continuity` field on
  the turn record (INV-137); a plain in-lane turn resumes natively with no
  packet. An in-run account hop that MOVED the lane's session (claude, codex)
  is disclosed on the same channel as `native_resume` with `lane_switched_from`
  naming the previous profile — the conversation continued natively on another
  account; the per-try run receipt (`run.continuity`) carries the carrier. Past a byte budget the packet's oldest turns collapse; the engine
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
  never need it, and a delegated thread's workspace is never delivered.
- `POST /v2/threads/:id/trash` moves a thread into recoverable trash for 30 days
  (`trashedAt`, `purgeAfter`); a trashed thread refuses edits and new turns, and
  a turn already running finishes normally. `restore` returns it to its
  pre-trash state until `purgeAfter` (afterwards `410 thread_trash_expired`).
  `purge` requires trash (`409 thread_not_trashed`) and answers `409
  thread_busy` while ANY turn of the thread is queued or running, because an
  Ask/Plan turn can run inside the lane home purge deletes; trash and restore
  delete nothing and never refuse a busy thread. What purge deletes and keeps
  is listed here once; DESIGN_SYSTEM (the Delete Now dialog) and the FEATURES
  row refer to it. Purge commits the `purged` state first, which takes the
  thread out of every listing, then deletes the thread's own directories: the
  isolated worktree, with any changes never applied to the project, and its
  `claudexor/thread-*` branch, and every lane home (the per-thread HOME of its
  Ask/Plan turns, of a delegated thread's turns, and its cached continuation
  summaries). A delegated thread's caller-owned workspace is never deleted, and
  its recorded binding stays on the purged record. A directory error
  after that commit (ENOTEMPTY, EBUSY, a Windows lock) fails the request
  although the thread is already purged and no longer restorable, so a client
  re-reads the list instead of promising Trash, and reads the thread's absence
  as a purge only from a list whose `problems` name no skipped project and
  whose rows it could all decode; a repeated purge or the next disk-retention
  pass (below) finishes the cleanup, and nothing makes a partially deleted
  thread restorable again. Purge does not erase the
  conversation: thread, turn, session and checkpoint rows and original prompt
  bodies stay in the engine store, run trees
  follow the run retention below, native sessions that a route keeps outside
  the lane home stay in the agent's own storage (Agent turns, and Codex
  config-dir login profiles and Antigravity, which keep sessions in the
  account's directory), and project files are untouched. (ACP's view of
  trashed threads is in INTEGRATIONS.)
- Refused turns are honest end-to-end: when a turn's run dies BEFORE it starts
  (the trust gate refusing `access: full`, preflight validation, an enqueue
  throw, or an Implement whose plan still has open questions and no explicit
  override — a typed `plan_not_ready`; a delegated thread whose bound workspace
  is missing — `delegated_workspace_unavailable`; a daemon restart after the
  turn's command was accepted but before its run started —
  `daemon_restarted_before_start`, recorded at restart recovery from the
  interrupted command), the daemon persists the reason on the
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
  request, and performs fresh normalization/preflight. Retained terminal
  product commands follow the global age/cap policy and continuation exemptions
  in [SQLite engine store](#sqlite-engine-store). There is no separate prompt-byte
  budget that shortens Exact Retry's retained-command lifetime. `GET
  /v2/runs/:id/run-again` instead returns an editable draft and explicitly
  lists server-owned fields omitted from that draft. The CLI projects these as
  `claudexor retry` and `claudexor run-again`. Durable idempotent replay is
  resolved before mutable resource, Git, or harness preflight: once a request
  was accepted, a later environment change returns the original command/run
  handle rather than replacing history with a new refusal. A project root that
  was never registered is a caller fix, not an unreadable replay index:
  `POST /v2/runs` and Exact Retry answer typed `404 project_not_registered`
  (`retryable: false`, required action: register the root with
  `POST /v2/projects` or declare `scope.ephemeral`) instead of the retryable
  `503 idempotency_status_unavailable`. The lookup also preserves canonical
  `409 idempotency_conflict` and `400 invalid_idempotency_key` refusals. Other
  lookup failures retain the retryable 503 and same-key recovery: their safe
  cause and `lookup_before_preflight` / `lookup_after_preflight` stage travel
  in the existing problem context, with the preflight error separately retained
  when that second lookup failed. Neither failure proves no prior acceptance.
  If no command was
  accepted, a replay may reuse its one persisted runless turn only while that
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
  `nextActions`, and the vendor's own typed failure, when the harness keeps one,
  rides `failure.vendorFailure` as opaque evidence that carries no remedy.
- `POST /v2/runs/:id/decision` records a typed operator decision on a blocked run:
  `accept_risk` / `override_needs_human` commit the auditable patch-hash-bound
  decision and its idempotency binding in the owning partition generation before
  ACK. The run artifact
  `arbitration/operator_decision.yaml` is only a compatibility projection for
  artifact-only CLI reads; the apply gate reads the stored decision. A same-key
  replay reads that stored authority before the thread's current idle gate and
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
  than total retained records. Each summary yields with `setImmediate` before
  the next. The LRU remembers file identities for delivery, tombstone, continuation
  sources, every local/ancestor retained-envelope pointer and its addressed custody
  file, plus ancestor roots/tombstones (GC can reclaim an ancestor without a
  pointer). Unchanged polls only stat that set; any dependency change rebuilds it.
  Active runs also track mutable artifacts, including the task contract and
  structured-output conformance receipt; terminal artifacts are otherwise frozen.
  The bare call returns the newest 200 with a cursor to page the rest.
- `GET /v2/threads` projects every thread in store order and validates the response
  once. Its inbox bit resolves only head command ids (batches of 1000), then reads
  attention artifacts only for succeeded heads, including operator decisions.
- Retained-command RPC reads require one strict addressed selector: a job/run
  `id`, a set of `ids`, `turnId`, `threadId` (optionally active only), `threadIds`,
  active commands, direct Delegate children, transitive Delegate descendants,
  a predecessor's forward continuation chain, or a keyset page. Empty, omitted,
  mixed and unknown selectors are typed 400 refusals. Selection precedes public
  projection inside the daemon. Single-id and latest-turn reads retain full
  params for detail and Exact Retry; collections carry only the typed summary
  whitelist and the existing redacted 240-character prompt preview, with no raw
  prompt, instructions, arbitrary params or full results. Thread selections also
  include their direct Delegate children for turn cards, even when the child
  has no thread id. A page crosses RPC
  with at most `limit+1` records; HTTP keeps its existing summary and cursor
  contract. SQL uses addressed indexes and bounded keyset pages before projection.
  The transitive cancellation cascade stays uncapped; traversal runs inside the
  daemon before serialization. Continuation preflight and synchronous enqueue
  inspect the addressed predecessor and successor chain before acceptance,
  without materializing retained command history.
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
optionally `--n N`) turns it into a multi-harness draft-then-merge: round 1
runs N members as parallel planner attempts (each the SAME vendor-native
read-only planner spawn the solo loop drives, in its own lane on a thread turn;
Cursor uses native read-only Ask so the final-message WorkReport remains available), whose
drafts land as file-backed artifacts (`council/draft-<harness>.md`). Each input
also has `attempts/<attemptId>/council-input.yaml` with its attempt outcome, WorkReport
evidence and draft reference. One admitted member then runs ONE merge iteration
(intent `synthesize`), preferring the first accepted draft in primary-first order.
Its prompt points at both files by absolute path; full draft text never rides
the prompt bubble. The `## Open Questions`
parser runs on the MERGE output only, so `final/plan.md` + `final/questions.json`
are shape-identical to a solo plan and the readiness/freeze/Implement flow above
is unchanged. Council owns no new state machine: it is round-1 attempts plus a
merge attempt, with a `council/membership.yaml` projection served on
`ControlRunDetail.council` (requested/drafted/degraded/mergedBy + per-member
role and status) and mirrored on the MCP run/read structured results so a host
can machine-verify the roster without reading local artifacts. Degradation is
disclosed, not silent. On a native WorkReport channel a nonempty draft whose
otherwise valid WorkReport says
`completed` with nonempty `required_inputs` may reach the merger as explicitly
UNVERIFIED input, with its original report and failure preserved (on an
instructed-footer route that attempt does not fail: the draft is an ordinary
accepted input whose `work_state` is `unverified`). Real harness,
required-web, cancellation and terminal context failures are not eligible for
this retention path. The planner attempt stays failed and cannot become a
successful draft merely because the same lane later merges. `drafted` counts
contract-accepted draft inputs; `degraded` also discloses unverified input.
If no accepted draft survives, the first eligible unverified lane may merge;
zero eligible inputs remains a typed failure. The existing merger decides how
to use the ideas and resolve contradictory or missing information. Its own
WorkReport and final-plan checks remain unchanged, and a failed merge never
substitutes a draft as the final plan. Council shares the
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

Plan-only WorkReport guidance applies to solo, draft and merge prompts:
completion describes preparation of the assigned plan, not its future
implementation. Questions about future implementation may remain in a complete
plan; `required_inputs` records information genuinely needed to produce the
current assigned result. The engine never clears that list to force completion.

### Event streaming contract (snapshot-then-subscribe)

The run-detail timeline preserves typed harness text as `textKind`
(`thinking` or `message`) plus `textDelta`. Its `detail` is the full redacted
text with original whitespace; `title` may be abbreviated. Only an adapter's
explicit `payload.delta: true` marks a fragment. Consumers can concatenate
consecutive same-kind, same-attempt deltas verbatim without inserting event
separators inside model prose. Complete messages, tool/status events, and rows
without text metadata remain separate; historical rows do not acquire guessed
fragment semantics. Cursor thinking deltas use the native `subtype: delta`,
while its complete assistant flush remains a complete message.

Every `RunEvent` carries a monotonic per-run `seq` stamped by the engine's
EventLog at emit time (control-api audit appends continue the same sequence).
In the daemon composition root, the lifecycle-significant events — `run.created`
(journaled with the prompt's sha256 digest and byte length in place of the
prompt text), `interaction.requested`, `interaction.answered`,
`interaction.timeout`, `interaction.withdrawn`, `output.ready` and the terminal
`run.completed|run.failed|run.blocked` — also commit to the SQL event ledger of
its global/project partition generation before live bus publication. Per-token
`harness.event` deltas and every other progress event reach only the per-run
`events.jsonl` and the in-process bus, so scoped event streams replay the run
LIFECYCLE after restart, never token-level progress. Failure to commit a retained
lifecycle event fails its producer/run instead of being swallowed as a live-only
gap; progress outside that set does not enter the SQL sink.
`GET /v2/runs/:id` returns the snapshot together with `lastSeq` — the highest seq
already reflected in that snapshot, read from the live writer's in-memory counter
or, for a finished run, from the log's last line (a full scan only when that line
cannot decide) — so a client subscribes to
`GET /v2/runs/:id/events` with `Last-Event-ID: <lastSeq>` and applies deltas with
no gaps and no duplicates. The per-run stream replays from the run's
`events.jsonl` — the one complete per-run event record; the SQL event ledger
holds only the lifecycle subset above, so it can restore a run's terminal tail
but never rebuild the full stream — (old pre-seq fixture lines fall back to
line-number ids) and is
push-driven by the daemon's in-process run-event bus, with a file-tail poll as
fallback; `output.ready` is guaranteed to precede the terminal
`run.completed|run.failed|run.blocked` event in every mode, so a client that
has applied the terminal event provably has the output. The EventLog's
once-only terminal-preparation hook also builds and validates the immutable
`RunFacts` receipt in memory and embeds that exact object in the terminal
event. One SQL transaction commits the command result, immutable `run_terminal`
event, scoped event copies and a `pending` terminal-files obligation. The file
owner then materializes telemetry, `final/run_facts.yaml` and the per-run terminal
line before best-effort live publication. A file error leaves the SQL terminal
and its obligation intact; immediate reconciliation or startup retries those
same file effects without another generation or a second terminal authority.
The obligation becomes `materialized` only after every effect completed, then
is removed after its registered generation passes the flusher barrier. Per-run
SSE does not emit `end` while it is `pending`, even if a terminal line is already
present in the file. An absent or materialized obligation permits the existing
file/terminal end rule. There is no separate terminal-recovery flag.
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
the turn. An explicit Stop commits `user_cancelled` and projects cancelled;
`RunControl.reason_code` (closed enum, validated at BOTH the HTTP boundary and
the raw daemon RPC) additionally types host-initiated stops as
`host_cancelled` (daemon shutdown drain, MCP host teardown, the delegation
budget authority) or `owner_task_gone` (an integrating host whose owning task
died — fabricated by no first-party site), riding the abort token into the
terminal writers through one mapper; the projection labels them "Stopped by
host" / "Owner task gone". `write_mechanism` similarly types how
workspace_write is confined per harness (`fs_sandbox` | `tool_policy` |
`none`) so lane choice by confinement never branches on a harness name;
`fs_sandbox` names the base sandbox, and a native automatic reviewer (Codex
workspace_write `auto_review`) may still admit single actions outside it.
Control API, CLI, MCP, ACP, and macOS consume those typed facts rather than
rewriting every cancellation as user intent; a legacy cancellation with no
reason stays unknown/cancelled instead of receiving a fabricated cause.

Cancellation wins only until the synchronous terminal commit starts. An abort
observed before the terminal barrier replaces the prepared outcome with
cancellation facts while retaining the independent checks/review/no-change/
work-state evidence already established for the run. Once a terminal has
committed to the engine store, Cancel is a NO-OP: the committed terminal
wins, a later abort cannot rewrite the durable result, EventLog refuses every
later terminal emit, and the daemon keeps reporting the committed outcome.
The `aborted -> cancelled` mapping survives only as the daemon's fail-closed
fallback classification for a malformed runner result with no recognized
lifecycle.

`GET /v2/global/events` and `GET /v2/projects/:id/events` read the retained SQL
event rows for the current partition generation. Live delivery uses that same
retained set: a row superseded before a poll is not delivered. The protocol-3
`ControlJournalEvent` shape and opaque `{v,p,e,s}` cursor encoding are unchanged;
import preserves original epochs and sparse sequences, including a folded-away
last frame. A foreign partition/epoch or ahead sequence is rejected with 409 and
`resnapshot`. The API claims no total order across partitions and has no separate
live-only stream. `thread.entities_upserted` is state in tables, not a streamed
event. Model/account-reset event copies expire after 30 days; their command
receipts remain retained independently.

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

`GET /v2/runs/:id/events/:seq` (query `offset`, `limit`) reads one bounded part
(at most 64 KiB, never splitting a character) of one event in exactly the redacted line
the stream delivers, with its total size and SHA-256, so a reader whose page
cannot hold that event reassembles it instead of skipping it. It locates the
event in the run's `events.jsonl` by the id rule it shares with the stream,
serves only complete, valid event lines (`run_event_not_found`,
`run_event_invalid`), and answers the retention tombstone like the artifact
routes, including a run reclaimed while it reads; it is no path or whole-log
reader. Its scan yields to the daemon's event loop after every 64 KiB read, but
each part rescans the history before its event, so an N-byte event costs about
N/limit scans of that history.

### Daemon lifecycle (signals, orphans, crash GC)

The engine-store migration is forward-fix only. Before publishing imported SQL
state, startup advances the existing root-authority semantic floor to the
running engine version. Older engines then refuse that root with
`root_authority_floor_regression`.
Keep preserved journals, SQL evidence and run artifacts; an older backup must
not automatically replace later work. Logical partition recovery and physical
whole-store recovery are described under
[Legacy import and recovery](#legacy-import-and-recovery), and a complete
pre-upgrade backup under [Upgrade backup and restore](#upgrade-backup-and-restore).

Every shutdown trigger — SIGTERM/SIGINT, the `claudexor.shutdown` socket RPC,
a startup failure — enters ONE state machine (`DaemonRuntimeShutdown
.beginShutdown(reason)`): abort in-flight runs, complete their committed
terminal transitions, await storage/worker cleanup and close the SQL store under
one shared bounded escalation ladder (hung-stop deadline, then a post-stop leaked-handle sweep, every rung
disclosed in the log). Awaiting-user interactive login runners are the one
exemption: the shutdown drain does NOT signal them (a detached Terminal login
survives an ordinary daemon bounce and is reconciled on the next start;
explicit cancel is the only killer). A hung participant cannot immortalize the
daemon whichever trigger asked it to die. Runtime replacement uses a separate
internal socket operation: in one synchronous event-loop turn the daemon checks
its queued/running/in-flight command authority, the composition root checks the
setup authority, including terminal jobs whose process termination remains
unconfirmed, and only an idle result enters `beginShutdown`, whose
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
recycled pid is never signalled) before reporting success. Scripts can trust
that exit code for the pinned generation; canary disposal additionally checks
the current writer lease for a successor. The lease is acquired before the
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
data root. Before any store or import work the daemon validates/installs a permanent
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
first acquires that authority and binds/proves the real socket and
Control API with product admission closed. Health, handshake, status, shutdown
and recovery remain reachable in `recovery_only`; product operations receive
`daemon_recovery_only`. Only then may the storage owner open or import SQL and
complete recovery/admission duties. The current global generation must be ready;
a logically damaged project generation stays isolated while healthy projects
serve. Physical corruption closes product admission for the whole store.
Recovery access overrides `CLAUDEXOR_NO_CONTROL_API=1` when needed. A successful
explicit recovery rebinds the existing SQL/quota/setup owners and re-runs the
same admission completion in process. The handshake retains `servingMode`;
the app waits in its existing Connecting flow during import/recovery and does
not launch a fallback daemon.

SQLite checkpoints, retained-row pruning and the existing maintenance worker
replace writable journal compaction; their ownership and durability are defined
below. Startup memory/loop/store measurements remain observations, not an
automatic resource governor.

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
No-project command state, setup and the project registry use the current global
SQL generation. Each registered project's commands, threads, turns and sessions
use `project:<stable-project-id>` with its own generation. Enqueue commits before
ACK; process-crash durability and the separate power-loss barrier are defined in
[SQLite engine store](#sqlite-engine-store). Create keys keep their exact client,
partition, operation and key digest, additionally scoped by owner and generation.
Restart interrupts accepted nonterminal commands; it never automatically replays
a mutating command or provider generation.
The deliberately empty-on-v2-start registry is global. `GET/POST /v2/projects`
list/register canonical local roots and
`POST /v2/projects/:id/relink` moves an existing stable project id. A
registration answer carries `created`: true only when that registration made the
project, false when the root was already registered; an `Idempotency-Key` replay
repeats its retained answer across restart and import, so a
caller can tell a project it created from one it merely found (`claudexor
project register` prints `created` or `existing`). Each project
discloses its nesting relations with other registered roots (`inside` /
`contains`, never a refusal); the list computes them for the whole registry in
one pass, each root checked only against its own registered ancestors.
`DELETE /v2/projects/:id` retires a project — it removes the registry entry and
archives its current partition generation through a SQL status/visibility
transition, retaining its rows and leaving run artifacts to normal GC. The typed
receipt's `archivedPartitionPath` is the logical locator
`partition:<name>@<epoch>`, not a filesystem path. Registering the same root
after archive creates a new project id and generation. Removal is refused with
a typed `409` while any non-purged thread or
live/queued run still references the project. The live/queued-run fence is a
SNAPSHOT, disclosed as such in the receipt (`activeRunCheck: "snapshot"`): the
active-run root set is read once through the in-process command activity
projection and consumed by the synchronous removal in the same event-loop turn.
There is no await where enqueue could interleave between check and mutation.
Activity includes the global and healthy project partitions,
and retention consumes that same prompt-free projection without a self-RPC. The CLI
projects the same surface as `claudexor project list|register|relink|remove` and
auto-registers the current root before a run; no v1 config, thread, or run path
is imported as a project registration. Relink updates project-thread root
projections without changing their partition identity.
The daemon also owns DISK RETENTION (W3.6): a bounded GC pass over
engine-owned runtime artifacts — per-project run trees and standalone
`.claudexor/reviews/diff-*` debris — scheduled 60 seconds after ownership+ready
(never blocking boot), then hourly, with a one-second continuation after a capped
500-tree pass. Shutdown and store recovery stop the timer and drain its current pass.
It enumerates plain hashed project directories under the owned runtime root, including
unregistered and archived projects. A private SQL reference read spans all retained
generations (including archived threads and pending interactions); unreadable references
fail closed, and unavailable project generations protect their namespaces. Unknown
project roots are disclosed as their runtime namespace. Bulk inventory yields
to admission; SQL history uses rowid-keyset pages without holding a cursor or
transaction across a yield. Each run deletion rereads changed SQL owners and mutable filesystem protections
after its asynchronous byte walk and retirement preparation. Connection-local TEMP
triggers observe row identities while the pass runs; no durable schema or writer is
added. Typed reference reads are shared with the initial inventory. Each distinct immutable command request is parsed once per pass by its content digest, including changed-owner refreshes. Combined run/native retention shares one SQL inventory and observer; standalone native retention owns and closes its own inventory. No durable schema changes. Quota/event
writes and unrelated metadata do not restart it. References accumulate during a pass
and lifecycle records refresh before the synchronous last proof and expiration marker.
Large change batches yield between reads; an unreadable owner, changed project/generation
topology, or a burst exceeding one final synchronous read page keeps remaining candidates
and schedules a fresh pass. The pass releases its observer even after failure. Stop, restart and storage recovery cancel all admitted retention passes, including queued manual requests. Inventory checks cancellation between rows/projects and deletion between candidates/native files; the receipt is truncated and the next pass resumes unfinished work. A published expiration marker retains its recovery intent until cleanup completes. Patch-cache
retirement rechecks directory identity and current link counts before unlink.
It is also exposed as the schema-first control op
`POST /v2/maintenance/gc` (dry-run first-class, typed receipt disclosing
every deletion AND why every survivor survived); `claudexor gc` is its thin
client. It deletes ONLY terminal, unreferenced, non-actionable trees past
the configured age (`retention.*` in the global config: runs 30d, reviews
14d, newest N for active registrations and archived registrations whose roots exist,
and the built-in no-project scope): an orphaned namespace has no keep-last owner,
when it has no live registration. Active registrations keep recent history even when their roots are unavailable. Archived registrations whose roots are gone (ENOENT or ENOTDIR) are orphan namespaces for keep-last; their references still protect runs. Other root-availability errors preserve keep-last with a named receipt line and do not stop the pass. Thread-derived root names
do not establish that ownership. All other protections remain: live/blocked records, runs
referenced by any non-purged thread's lineage or retained command dependencies
(queued claims included: continuation predecessors and their full ancestor chains,
Exact Retry sources and frozen plans, plus durable continuation source lists after
command-history pruning), undelivered/applyable
patches or copied-file results, and trees with no terminal evidence are protected
fail-closed. Lane sweeping derives root ownership once from the shared thread inventory and synchronously rereads changed owners immediately before each root’s sweep, so unrelated writes do not starve cleanup or multiply global-thread parsing by root count. An invalid shared proof defers lane sweeping with one receipt line, including topology changes during the loop. A per-root ownership failure names only the skipped root.

A `quarantined` generation and project generations owned by its replaced global registry are retired journal evidence: its rows do not own references or keep unsettled commands active, and completed quarantine does not stop retention. Terminal metadata may still date its old payloads. Archived projects in the current registry remain reference owners. Pending or unknown recovery states hold all run namespaces, with one named partition/status hold per pending generation in `errors[]`: scope roots do not bound cross-project dependencies. Partial file delivery retains that protection; explicit discard
ends pending delivery but does not delete artifacts immediately or bypass other
retention protections. Unsettled delivery commands keep the pass closed: their
historical params do not reliably identify every source file used after an await. A
retired run leaves a tombstone projection behind. Tombstone-aware artifact and
admission surfaces answer with typed 410 `run_expired_by_retention`; the HTTP Apply
route's patch prerequisite is the existing exception described below. The
last protection check and exclusive publication of the small prepared tombstone
do not yield. Continuation admission refuses an expired predecessor. If older links expired, it uses the runtime carrier’s evidence reader to find an intact capsule, resumable or output source; ordinary unexpired admission does not scan evidence bodies. Earlier expired ancestors are excluded from file reads and disclosed in the successor notice. Exact Retry of expired evidence directs the caller to Run Again. Exact Retry, frozen-plan and delivery admission
use the same expiration fence. Existing idempotent delivery receipts still replay
at the command layer. The HTTP Apply route rereads the patch before command replay:
repeating the same Apply key after retention removed that patch returns 404, while
the durable command receipt remains reusable. This route behavior predates retention
changes; receipt replay does not promise that an expired artifact is still available.
An expired directory cannot become evidence again. Durable `context/continuation.json` lists are published through a private temporary file, file flush, atomic rename and directory flush. Unreadable reference errors name the file or SQL row and partition. A bad run-local work-product or custody file keeps that run; unreadable SQL or continuity owners hold the pass because their references can cross namespaces. Pending recovery holds run retirement install-wide until recovery completes.
Readers see that expiration while recursive deletion of the previously
inventoried contents runs asynchronously; no directory rename blocks admission.
A durable intent in the parent's private `.retiring` directory binds the source
identity and child names, letting the next pass finish interrupted cleanup within
the same deletion cap. Diff reviews use a private expiration marker and the same
owner. Preparations without a published marker leave the source untouched. A failed physical cleanup is disclosed
and retried, and completed deletions remain in the receipt even if bookkeeping
cleanup fails. The
receipt also carries an advisory `data_root_unrecognized` listing — names of
top-level data-root entries the engine does not own and never touches
(absent, with an `errors[]` entry, when that scan fails). The same pass purges
EXPIRED TRASH: a trashed thread whose `purge_after` has passed goes through the
one thread purge owner (the service behind `POST /v2/threads/:id/purge`) before
run candidates are judged, so the runs only it referenced become ordinary
unreferenced candidates. A thread with a queued or running turn is kept for a
later pass and disclosed in `errors[]`, as is a failed purge; a dry run purges
nothing and previews those threads' runs as unreferenced. Before that, the
pass FINISHES PURGES whose directory cleanup failed after the store commit:
every purged thread whose isolated worktree or lane home is still on disk goes
through the same owner again (it commits no new purge and deletes what is
left); a cleanup that fails again is disclosed in `errors[]` and retried by the
next pass, and a dry run only lists them. The receipt's `purged_threads` names
the purged (or would-be-purged) expired trash and `purge_leftovers` the
finished (or would-be-finished) purges; like `data_root_unrecognized` both are
opt-in (`trash_purge_report`, sent only by a lockstep CLI), the startup pass
requests them for its log line, and `claudexor gc` prints them.
NATIVE HOME RETENTION uses each adapter's `nativeHomeLifetime` contract. The
same pass applies the run-age window (30 days by default) to Codex rollout files
under its owned default home and every registered config-dir profile, including
disabled profiles. A full reference inventory precedes deletion: all non-purged
SQL thread sessions across retained generations, every retained attempt's typed
session capsule, and every retained run's typed resumable record protect their
native session IDs across all homes of that harness. Archived threads and pinned
account continuations retain that protection. Missing artifacts have no reference;
malformed or unreadable references, linked artifact directories, unavailable
project generations, uncertain command ownership, or active/unconfirmed setup work prevent
native pruning. SQL rows and filesystem inventory yield to admission. Active and
queued product work protects its named sessions and continuation sources, without
holding unrelated cold sessions. The pass rereads changed SQL owners and each active
or newly changed command's output files before unlink; this includes a capsule
published without another SQL update, or work that starts and finishes during the
scan. Durable continuation addresses include sources outside the hashed run layout.
Native references accumulate in a live set; the adapter normalizes session IDs initially and again only when that set grows. Already read terminal ancestry is shared
within the pass; active output files are reread. A late reference keeps its entire
session and allows unrelated groups to progress. Each unlink rechecks setup state,
references and current file identity synchronously, without a yield between proof
and deletion. An unreadable owner keeps the remaining files and preserves any
completed deletions in the receipt. Retaining a run can retain its session even if
that run no longer needs resume.

Codex owns only the recognized `sessions/YYYY/MM/DD/rollout-…-<uuid>.jsonl`
and `.jsonl.zst` candidates. All parts of a referenced session survive; a recent
part protects the whole group. File identity and modification facts are rechecked
before deletion. Each pass removes at most 500 native files and promptly continues
when capped. Credentials, configuration, SQLite logs/indexes, archived sessions,
unknown filenames/layouts and symlinks remain untouched. Codex SQLite reclamation
is **not pruned: no proven independent row/file lifetime contract**. Claude is
**not pruned: its CLI owns transcript expiry and the engine has no independent
sidecar deletion proof**. Cursor, Agy and OpenCode are **not pruned: their native
session/index relationships have no proven independent pruning contract**. ACP is
**not pruned: the protocol supplies no vendor-independent native storage contract**.
The adapter is the owner of those declarations; the engine never guesses a format.

The opt-in `native_home_report` request returns `native_homes` with per-home
retirement counts, deleted paths, errors, and a reason for retained/unsupported
formats. Cleanup runs for older clients too; only the disclosure is negotiated.
The lockstep CLI prints those reasons. Dry-run performs the same proof and previews
the bytes without unlinking; it accounts for runs/threads that this pass would
retire. This does not delete conversation records or promise full account-home
reclamation: unsupported vendor databases and still-referenced sessions remain.

STOPPED ISOLATED WORK IS KEPT for `continueFrom` (A9): a daemon-owned,
single-candidate, mutating Agent run records `live` custody of its isolated
envelope (`continuation-custody.json` in the envelope base, written before
any harness runs). Retention settles with the final run outcome, after review
and budget reconciliation: any non-success terminal, or a `succeeded` run
with a `needs_input` / `incomplete` report, keeps the envelope when there is
something to continue (a diff, a session capsule, or a tree that differs from
its base), the envelope — tree and scoped home — is kept (custody
`retained`, the run-dir pointer `final/retained-envelope.json`, a
`workspace.retained` event; disk use is measured once and projected as
`retainedEnvelope`) instead of disposed. Terminal deferral is released even
when settlement or its terminal artifact update throws. Route-scoped auth that Claudexor
itself seeds in that home (the Codex API-key `auth.json`, the Claude Keychain
bridge link) is removed when it is kept; the adapters re-create it on the next
spawn. Nothing removes a kept envelope automatically: a successor adopting it
(custody moves, the tree is never deleted), applying the run's result, or the
`discard` decision releases it, and disk retention keeps a run tree that holds
one. Discard releases the kept tree; a later accepted continuation starts from
the project base. Command pruning also exempts retained holders and successor commands
while their predecessor record remains in the kept set, preserving the
continuation handle and its single-successor claim across retained-event pruning.
After a predecessor is pruned, its successor becomes eligible on a later pass.
The crash sweep never treats a kept envelope as an orphan (its auth is
stripped again, and a missing holder pointer is rebuilt from authoritative
custody); an envelope whose holder died mid-attempt with a changed tree or a
valid session capsule is kept with cause `host_restart`. Delegate belt children
start from the project base even if their predecessor holds a retained envelope;
they do not adopt or retain it. In-place runs and race/synthesis/review envelopes
keep their ordinary lifecycle.
While running it snapshots its live harness child process groups to
`daemon/pids.json` (checked every two seconds, written asynchronously and only
when the set of children changed; shutdown waits for that write before its final
synchronous snapshot); the NEXT startup reaps recorded orphans that survived a
crash (pid liveness + command-name recycling guard) and sweeps workspace
debris under daemon-known project roots. The reap is not a stop proof: it sends
SIGTERM to each recorded group, deletes the record, and only schedules SIGKILL
three seconds later without awaiting the group's exit, and a child spawned after
the last two-second snapshot is not recorded at all. A run the restart
terminalized as `interrupted` (`resumable.cause: host_restart`, with its
`workspace` root) therefore has unknown process custody; a caller that owns
that workspace keeps it and reconciles quiescence itself before refreshing or
reusing it. An in-run cancel reaps its own process tree and discloses any
unconfirmed death as `termination_unconfirmed` on the harness's completion
event. Independently of that cancel ladder, every run owns a process SCOPE
(INV-144): `run()` mints a `CLAUDEXOR_RUN_SCOPE_<id>=1` marker and records it in
`daemon/run-scopes.json` before the first launch; every harness spec env of the
run carries it, as does every deterministic gate the run launches — candidate
gates, its final verification and adoption (`gateSpecsFromContract` binds it;
nothing is ended per command); a `clean` env also forwards an enclosing host's
grammar-shaped markers; the same pids tick takes one asynchronous process-table snapshot and
records each live harness root's descendants (pid, group, birth) into the run's
entry, after the root's own group (pgid and the leader's measured identity)
was recorded synchronously the moment it was registered — its `lstart` birth
is added once a table read confirms the same leader before and after the
read, and the scope floor is `opened_at` until a birth is known. Every announced run holds its terminal event (the
deferred-terminal mechanism) until the whole-run barrier has ended the scope's
members by measured identity — environment-marker members (`ps -E` on macOS,
read only for processes no older than the scope after a cheap `pid,etime`
listing — elapsed time rather than a start timestamp, so both sides come from
the same clock at the same moment and zones or DST cannot hide a member; a
minute of slack absorbs small backward wall-clock steps, and a larger one
during the run can hide a marker-only member (recorded groups and captured
descendants do not use the filter); a failed listing falls back to the full
read, and `ps -p` exiting 1 counts as "every selected pid vanished" only with
nothing on stderr —
`/proc/<pid>/environ` on Linux), members of recorded process groups under the
pgid-reuse rule and recorded descendants, TERM then a bounded KILL, each signal
after a fresh birth read (a member is the same process by its kernel birth even
after it moved to another process group; signalling a whole group still requires
its recorded leader in that group) — and attempted to write `final/process_scope.yaml` (what was
ended, what survived, what was unreadable, which recorded groups were skipped
as reused, `completeness`, and `incomplete` when the single settlement
deadline expired first — one absolute budget that starts when the daemon's
custodian enters settlement for the run, also bounds the run's own pending
seed refinement and never waits for another run's seeds; scanning and
signalling stop at that moment — no read starts after it, never a late signal); only then is the terminal published — also on the path where a
delegated child drain failed (the record step is the barrier's `finally`) — so a
host that sees the terminal in the SQL command state or on the SSE stream already
finds the settlement done and, when the write succeeded, the record on disk. The
write is best-effort evidence, not a gate: a write failure, or an outcome that
fails its schema, is swallowed, the verdict is published unchanged, and that run
has no record. Recording is attempted once, without a second write or retry.
`GET /v2/runs/:id` projects the record compactly as `summary.processScope`,
which an engine that has the field always sends: the compact object for a
terminal run whose record is readable and valid, otherwise an explicit `null`
that means unknown, never clean — the run is not terminal yet (even when the
artifact already exists), the record is absent (a run that predates it, or whose
write failed), or it is unreadable or invalid. The run list leaves it a constant
`null`; read the detail. Engines that predate the field omit the key, which is
equally unknown; the generated JSON Schema lists the property as optional (it
declares a default of `null`), although this engine always sends it. The reap
never changes the verdict. The next start settles or discloses entries whose owning daemon is no
longer live BEFORE this sweep and never touches a marker absent from the index.
Limits are disclosed, never failures: Windows has no environment census
(`tree_only`, and such entries are retired after disclosure); on macOS SIP
hides Apple platform-binary environments, so a system binary started in the
background by a shell that exited before any capture cannot be ruled out —
`completeness` is `not_provable` there even when settled, and `complete` only
on Linux when every census source succeeded and every same-uid process
environment was readable (another uid cannot inherit our environment through
ordinary spawn and is not counted; a setuid binary is a disclosed residual).
An unreadable same-uid or unknown-uid discovery candidate is not a known scope
member and receives no signal. Once known members settle, that discovery
uncertainty limits completeness without forcing `settled` false; a host may
release its copy under the known-member settlement policy while disclosing
`not_provable`. Unsupported or failed census, surviving known members and
unknown receipts do not certify that release.
A host cancel that arrives during the settlement barrier does not rewrite a
completed run as cancelled: the cancellation decision is frozen when the
strategy's terminal is held.
`daemon/run-scopes.json` is a stable contract a host may read directly when
the daemon is dead. Its compact schema, in the field names the daemon writes:
`{ "schema_version": 1, "entries": [ ... ] }`; per entry `run_id`, `marker`,
`state` (`open` | `unresolved`), `opened_at` (ISO time: the floor the daemon
uses while no `lstart` birth exists), `scope_start` (`lstart` text or null),
`root_groups[{pgid, leader_pid, leader_birth | null, leader_identity?}]`
(`leader_identity` is the daemon's opaque kernel birth token, comparable only
by the daemon's own identity helper; `leader_birth` is filled once a table
read confirmed the same leader) and `captured[{pid, pgid, birth}]`; every
birth is `ps -o lstart=` text under the C locale in local time
(`Mon Oct 12 14:08:47 2026`, 1 s resolution) and is only ever compared with
another `lstart` reading, never with the identity token. A host without the
identity helper follows this rule when `leader_birth` is null: a live process
with `pid == pgid` cannot be verified as the recorded leader, so the host
skips that group; when no process with `pid == pgid` is alive, the group's
remaining members born at or after the floor belong to the scope (the kernel
does not hand out a pid that is still a live process-group id). The sweep covers orphaned envelopes (with their
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

### SQLite engine store

`packages/daemon/src/store/` is the single production persistence owner for each
daemon data root. `SqlDaemonStorage` opens it after transport proof and supplies
the complete SQL graph. Structural store ports expose domain methods, addressed
queries and global pruning; they do not select a storage mode. The existing
scheduler, runner, cancellation and setup lifecycle use those ports. Quota and
setup retain their established reducers over selected logical `EventLedger`
rows. The old writable journal graph is retired, with the historical decoder
kept only for cold import and an independent frozen copy kept for tests.

- One database `engine.sqlite` per daemon data root, opened through the
  `EngineStore` adapter: `node:sqlite` is imported lazily — on the request
  thread when a store opens and inside each worker when it starts — so the
  daemon package itself loads on a Node without that module, and the open
  proves the bundled SQLite is at least 3.51.3 (the WAL-reset corruption fix)
  or refuses typed (`engine_runtime_unsupported`) before store bytes are touched;
  the file's
  application id and schema version are checked before any write
  (`store_schema_unsupported`); the connection pragmas are applied and read
  back. The request thread is the single row writer: a mutation is a
  synchronous transaction (BEGIN IMMEDIATE … COMMIT, ROLLBACK in `finally`,
  asynchronous bodies refused) under WAL `synchronous=NORMAL`. Return/ACK means
  committed and durable across an engine process crash or kill, not power loss
  or kernel panic: recent commits can be lost until a completed flusher barrier.
  Provider generation and native account-reset I/O await `flushed()` before the
  external effect.
  Bodies up to 64 KiB live inline in the `blob` table; larger bodies are
  content-addressed files under the resource store, written in the same tick
  as the owning transaction.
- Schema version 2 adds the INV-135 `account_last_service` table to the
  version-1 DDL in place; no other row changes. Opening the store applies it
  automatically, before startup advances the root-authority floor, and the
  adoption is one-way like the rest of this store's forward-fix migrations: no
  downgrade path is promised. An engine that serves only version 1 — including
  an older build of the same release version, which the semantic floor cannot
  tell apart — refuses the upgraded file with `store_schema_unsupported` before
  any write.
- Schema version 3 adds two expression indexes over accepted command-summary
  `params.taskGroupId`, ordered for group pages and group/state pages with the
  live product, valid-JSON and guarded non-null group predicates. Untagged rows,
  JSON null groups and non-JSON BLOB summaries remain writable and occupy neither
  index. Building the indexes still scans existing rows, and writes still evaluate
  their predicates. Membership is committed in the original
  acceptance transaction, before ACK/dispatch; there is no group table, backfill
  or retention pin. Fresh DDL and the atomic 2→3 migration have the same indexes;
  version 1 follows 1→2→3, and reopening the current version is write-free.
  A version-2 reader refuses the upgraded file before writing. Downgrading an
  upgraded store requires restoring a compatible complete backup made with all
  writers stopped; swapping only the executable is insufficient. Source and
  isolated-fixture qualification do not migrate an installed store.
  Earlier unpublished schema-3 stores keep their broader indexes on reopen and
  remain query-compatible with this reader; they retain the original storage cost.
  No automatic rebuild is added. Earlier experimental binaries whose forced-index
  queries lack the tagged predicate cannot query the narrower indexes. Do not swap
  experimental binaries against the same store; the complete-backup rule applies.
- The flusher worker owns the power-loss barrier. Every 200 ms it fsyncs each
  directory registered since the previous pass, reads `data_version`, runs a
  PASSIVE checkpoint for space, and — whenever anything was committed since
  its last proven barrier — issues one explicit fsync of the WAL file (an
  F_FULLFSYNC on macOS, also a device-wide barrier for `O_DSYNC` file data
  handed to the drive before it). The barrier is never derived from a
  checkpoint result, and a freshly started or restarted worker treats its
  first pass as dirty. Every connection that can checkpoint — the writer and
  the flusher; the serving maintenance connection is read-only and never
  checkpoints — sets `checkpoint_fullfsync`, so the checkpoint that completes a backfill
  syncs WAL → database → reuse in order and database pages become durable
  there, not through the WAL fsync;
  the writer's `wal_autocheckpoint` of 4000 pages (about 16 MiB) is the
  trigger threshold of that checkpoint, not a physical bound: under a pinned
  reader (a maintenance integrity check or export, a long statement) or a
  large transaction the WAL keeps growing and resets once the reader
  releases, after which `journal_size_limit` truncates the file; the first
  such checkpoint after a long pinned read copies the accumulated backlog in
  one longer stop on the request thread. The writer's automatic checkpoint
  runs inside a COMMIT call once the WAL reaches the threshold, and a COMMIT
  that restarts the WAL syncs the new WAL header, so `synchronous=NORMAL`
  removes the per-commit WAL sync, not every native sync on the request thread.
  The request thread itself calls no
  Node storage-sync primitive: external files use `O_DSYNC` on POSIX and
  libuv's write-through open flag on Windows, where Node does not export the
  POSIX constant. The temp is renamed and its directory goes to the flusher via
  `registerExternal`. Registrations and `flushed()` waiters carry monotonic
  generations; a pass acknowledges every generation it received before it
  started, a dead worker rejects its earlier waiters typed
  (`store_flush_unavailable`, retryable) and is restarted with its
  unacknowledged registrations replayed.
- Obligations (`effect_obligation`) are rows created in the same transaction
  as the decision whose file effects they protect (terminal files, blob
  publication, archive/purge/quarantine steps). The row stays `pending` until
  the owner has performed every effect and materializes it, recording the
  generation of the last registration in `materialized_g`; only a barrier
  covering that generation deletes it. Startup replays every open row through
  an idempotent per-kind handler, so their count is unfinished work, never
  history.
- Blob files are collected through that same rule: only after the barrier of
  the latest transaction that changed a reference to the digest, by a
  single-flight per-digest handler that re-checks newer changes and every
  reverse index in one synchronous section before unlinking and deleting the
  file-mode `blob` row. The maintenance worker — its own
  read-only connection, never the flusher's thread — runs the integrity check
  after admission and on request, exports a consistent snapshot copy, and
  enumerates orphan candidates (blob files, temp files and upload parts older
  than the process start that no row in its snapshot owns); every removal is
  decided on the request thread by one rule: the main thread records the
  generation of every committed change to a file's owner rows, the unlink
  waits for the barrier covering the latest one and, in a single synchronous
  section, retries if the owner moved, keeps if an owner exists, else unlinks.
  `EngineStore` owns this generation map; blob helpers, obligation completion
  and maintenance share it automatically, including when constructed separately.
- Retention applies the existing fold verdicts as SQL retire/slot/group/drop
  operations. Slot and group deletions name the partial indexes `event_slot`
  and `event_group`, so each is an addressed `(pid, key)` lookup whose cost
  depends on the rows it actually removes, not on the partition's other
  history, during appends and cold import; retention query-plan tests pin those
  plans. Thread/turn/session/checkpoint state is kept in tables and is never
  age-pruned; thread-entity snapshots consume sequence but are not event rows.
  Resolved interactions remain resolved across restart until command pruning.
  Model/account-reset stream copies have a 30-day lifetime independently of
  their retained command receipts. Command rows carry a `kind` set once at accept
  (`commandKind`) and a `live` flag for the served generations; the bounded
  prune uses one default global cap of 500 terminal product/delivery/maintenance
  commands and admits victims only after 30 days. Exempt and younger commands
  can keep the total above that cap. Each pass selects at most 100 oldest
  eligible victims through keyset pages over a partial
  index, with needs-decision rows outside the candidate index and continuation/
  retained-envelope exemptions checked once per candidate. Remaining excess is
  handled on later passes; model and account-reset receipts are exempt. No
  separate 256 MiB prompt budget shortens this lifetime. Journal
  cursors keep their encoding and map onto the current partition generation;
  a stale epoch or an ahead sequence is refused with the same 409
  `journal_cursor_invalid` and `resnapshot` as today.
- Facts for the daemon status (measurements, never verdicts): `flush_lag_ms`,
  the last barrier time, `wal_bytes`, flusher state and counters,
  `busy_waits`, `commit`, `obligations_open`, the integrity verdict, and the
  importer's phase/current partition/partition and byte progress. CLI daemon
  status consumes that progress and the COMMIT summary; unavailable facts stay
  null and a pending integrity check is not reported as passed.
  `commit` covers the request thread's `transaction()` COMMIT calls since this
  store opened (a new store, including an in-process replacement, starts
  again): attempts, failures, and the last and longest duration on a monotonic
  clock at microsecond resolution. Only the native COMMIT call is timed, so a
  WAL header sync or checkpoint SQLite runs inside it is included, while BEGIN
  (timed separately as `store.begin_immediate` among the worst synchronous
  sections), the body, error mapping, ROLLBACK, open-time schema setup and the
  flusher's later barrier are not. It is one lifetime summary, not aligned with the
  event-loop window; a long COMMIT is evidence of where the request thread
  waited, not proof of a disk cause. Before any COMMIT the counts are 0 and
  the durations null; a store that is not open reports null, and older
  engines omit the field.

Typed refusals of the core: `engine_runtime_unsupported`,
`store_schema_unsupported`, `store_flush_unavailable`, `store_full` (ENOSPC
or SQLITE_FULL), `store_corrupt`, `store_busy` (the busy timeout is a fuse;
hitting it is the `busy_waits` fact). The store workers travel inside the
single-file daemon bundle: the bundle is their worker entry and the embedded
worker modules self-start on `workerData`, while the daemon's direct-entry
check ignores worker threads.

#### Legacy import and recovery

The supported engine runtime is Node 24.15.0 or newer with bundled SQLite at
least 3.51.3. Unsupported SQLite/module availability is refused before opening
the data store. Protocol major remains 3; the application floor for engine 4.0
is application 4.0 because older finite-only decoders cannot read unlimited
capacity. The existing updater requests the app update and keeps the working
older engine until then.

On first startup without `engine.sqlite`, an existing `journal/` is imported by
the maintenance worker into `engine.sqlite.import` while transports serve
`recovery_only` with progress. That worker is the sole connection/writer of the
temporary database; progress crosses worker messages, not a second reader.
It uses the existing read-only frame/intent parser under `store/legacy-journal/`
and the domain row reducers, preserves ids, exact idempotency digests, original
epoch/sequence/time and disk chain state, and compares the imported retained
records/state before publication. A valid pending append contributes only the
validated prefix before its recorded intent; unexplained damage retains evidence and marks its logical
partition recovery-required. Unknown records remain explicit `unclassified`
evidence. Interrupted imports resume from verified partition receipts with source
fingerprints and integrity checks; source journals are never repaired in place.

Publication closes the sole writer, proves no import WAL remains, explicitly
syncs the database, advances the semantic floor, renames the database and
preserves `journal/` as `journal-legacy/` (a distinct archive name on collision),
then syncs the parent directory before service. An existing `engine.sqlite`
takes precedence over legacy import, including after a crash between these steps. A new
empty root creates a fresh SQL store through the same transport/admission owner.
The import can take minutes and materializes one legacy partition at a time;
steady startup still replays retained quota/setup events, not all command history.

Historical `resource-store/idempotency/<digest>.json` files remain authoritative
for unreplayed caller-supplied upload keys. SQL probes only the requested digest on an enabled
miss and adopts that binding in the same mutation; startup never scans this
large directory. A confirmed ENOENT or a valid known-expired historical binding
permits the request to proceed; an unreadable, malformed, or identity-mismatched addressed binding instead
refuses the request with `legacy_upload_binding_unavailable` (503). The refusal
mints no upload, part file or receipt and leaves the file untouched. Its problem
`context` names the operation, key digest, `read_failed`/`invalid` reason and
any errno code; the message repeats the digest and root-relative file for
clients that keep only the message. Neither carries the raw key, record bytes,
absolute path or native error text. `retryable: true` means only that the same
request and key may be resubmitted after the operator restores that file or its
read access; waiting does not heal it, and a client that cancels after a failure
(the CLI cancels its upload when finalize fails) does not resume. A
directory-level read failure refuses every caller-key SQL miss, including fresh keys; SQL
hits are unaffected. New daemon-produced model/image results mint their create
and finalize keys inside the resource owner, without historical replay lookup.
They keep the same SQL receipts, byte validation, publication obligations and
cleanup. Caller keys stay strict even with `purpose=model` or internal-looking
names. The persisted presence flag disables the fallback when absent.
Bindings expire 30 days after a resource's known release/expiry, never from a
guessed file timestamp. An expired lookup deletes that target's SQL bindings
before the historical read, so a damaged copy still refuses afterwards. Repair
before expiry replays the receipt; after it, the key is admitted as a new upload
and an old finalize answers `upload_not_found`, not the expired receipt.
Manually removing the historical directory can turn a later replay into a
missing result or a new upload. Retiring serving code does
not delete legacy journals, account/credential stores or these key files.

Logical archive/quarantine changes status and generation visibility without
deleting the old rows. A global-generation replacement hides the old project
registry and its generations together; uploads keep their independent pid0
scope. Logical recovery exports a consistent SQL snapshot with its referenced
external bodies. Its manifest discloses excluded upload `.part` files, legacy
upload idempotency-key files not yet adopted into SQL, and per-run event logs,
run artifacts and setup operational artifacts; those remain at their existing
locations. Physical corruption instead uses the existing `engine-state`
recovery target: its raw database/WAL/SHM export is diagnostic evidence, not a
complete restorable backup. Explicit whole-store quarantine closes storage and
archives the database files with `resource-store/` (bodies, uploads and legacy
keys) under the same recovery artifact before creating a fresh store. The new
store's GC cannot delete archived bodies; its empty resource directory inherits
no old upload replay authority. Accounts, runs and `journal-legacy/` stay in
place. The same idempotent recovery operation resumes before ordinary startup
selection; it never reimports legacy state or replaces newer work automatically.
This migration is forward-fix only.

#### Upgrade backup and restore

Store migrations are one-way. There is no in-place downgrade, and selecting an
older runtime (an executable-pointer rollback) does not restore data: an older
engine can serve recovery only with `store_schema_unsupported` when startup
stopped after the migration but before the floor advanced. After the advance,
`root_authority_floor_regression` refuses startup before any transport binds. No built-in
command takes a complete backup; logical and diagnostic exports are not one.

A complete pre-upgrade backup is taken while the daemon and every other writer
are stopped, as an independent copy that preserves owners and modes and
contains no hard links. For the default layout it covers all of `~/.claudexor`
and `~/.cache/claudexor`. For an explicit `CLAUDEXOR_CONFIG_DIR` it covers the
complete config root, `~/.cache/claudexor`, every externally referenced
Claudexor-owned store and, for the desktop app, `~/.claudexor/runtime`.

To return to it, stop the daemon, move the newer state aside and keep it
untouched, restore the backup to its original absolute paths, and start a
matching pre-upgrade build compatible with the backup's recorded floor; starting
a newer build can simply migrate the restored data again. The root-authority marker
grants authority only as a regular, singly linked file owned by the running
user with private permissions. A copy restored at another path is not a
supported restore. Work created after the backup is not included, and restored
credentials may be stale and need sign-in again.

### Interactive runs (waiting_on_user)

Harnesses with the `interactive` capability (Claude Code's bidirectional
stream-json questions and Codex app-server's native action approvals) can raise
typed requests mid-run; the
orchestrator OFFERS the interaction channel only to routes whose manifest
declares `interactive`. The
engine emits `interaction.requested` (questions, options, nullable timeout deadline),
parks ONLY that attempt, and the daemon commits the pending interaction and its
event in the run's global or `project:<id>` partition generation before exposing it via
`GET /v2/runs/:id` (`pendingInteractions`, `summary.waitingOnUser`). Answers
arrive via `POST /v2/runs/:id/interactions/:id/answer` and are delivered into the
live session only after the resolution is committed (`interaction.answered`).
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
Adapters can also revoke one obsolete native request without cancelling the
run: a runtime-only per-request abort signal releases the durable interaction as
`interrupted`, clears the wait and never authorizes a late answer. The engine
announces that withdrawal once as `interaction.withdrawn` (never a timeout), so
`claudexor follow` and the macOS card close the obsolete prompt instead of
letting it block the next question; an answer accepted in the same tick is
disclosed as `interaction.answer_discarded` (`request_withdrawn`).
Declined/timed-out interactive flow-control tools are benign timeline events,
never blocking tool errors.

Delegate children use this same interaction contract. A parent/list child
summary may carry `waitingOnUser:true`, but it does not own the question body;
the macOS client therefore performs a coalesced fresh child-detail read even
when that child had been hydrated earlier, renders the answer against the child
interaction's canonical `runId`, and exposes a truthful retry if the detail read
fails. Answer delivery remains the same commit-before-delivery child endpoint above; no
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
global SQL event ledger. Each event has an opaque cursor plus the exact request-relative
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
flag) and Cursor (`cursor-agent login`, or `agent login` through a verified
Cursor `agent`) use daemon-hosted URL disclosure; Claude
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

**Transient login disclosure (event-store authority, INV-062):** the one-time
`userCode` and every captured sign-in URL ride ONLY a transient
`runner-devicecode.json` sidecar the runner writes and a read-time overlay on
`ControlSetupJobSnapshot` / `ControlSetupJobEvent`; they are NEVER fields of
the durable `ControlSetupJob`, never logged, and never written to the durable
result receipt (the event ledger records only THAT something was disclosed, via the
`awaiting_user` transition). The sidecar is removed on terminalization so the
disclosure stops projecting. Snapshot/event schemas accept the overlay for any
active login job in `awaiting_user` — codex app-server flows carry a
`userCode`; the daemon-hosted `url_disclosure` (cursor) and
`url_disclosure_with_input` (claude, agy) modes carry the captured `oauth_url` /
`oauth_url_input` sign-in link with an empty code. For
`url_disclosure_with_input`, the user's pasted completion value arrives via
`POST /v2/setup/jobs/:id/input`, rides a one-shot transient
`runner-input.json` sidecar to the vendor CLI's stdin under the same
transient-only rule, and a second submission conflicts instead of replacing
the first. Stateful UI clients replace the overlay from each authoritative frame,
retain it only across a bounded same-job Extend/reconnect transition, and clear
it on Cancel, detach, terminal/non-awaiting state, final stream loss, or poll
failure. Every point response and SSE event must identify the setup job named
by its request; cursor and sequence then fence ordering within that job.
Every machine fallback and UI continuation takes its credential `profileId`
from the server-owned setup job, never from the sheet or caller that happens to
be observing it.
CLI login follows the declared disclosure flow for each accepted daemon job.
URL-only flows wait without requesting a code; URL-plus-input sends the pasted
value to that exact job. A corrected URL replaces its earlier disclosure.
`--json` returns one disclosure or terminal object: a disclosed active login is
not a completed login. Repeating the same login command while its target remains
active reuses that job; after termination it starts a new login, so machine
observers poll the returned job ID instead. The remote Mac view observes that
same exact-job lifecycle through its selected GatewayClient, preserving its
connection/action lease and keeping Close distinct from Cancel.

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
runner's hash-bound result is committed as a setup event before verification. For a
DEFAULT-store login, exit zero enters a fresh, source-targeted native probe
followed by an isolated same-harness capability smoke over the normal adapter
stream; only the exact `vendor_native` / `native_session` route may pass.
One silent effort-omission status may precede `started` for the smoke's explicit
null effort preference. It remains preparation evidence in the stream digest;
the native `started` event alone supplies credential route/source proof. Repeated
pre-start preparation, other pre-start activity, and events after completion still fail.
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
persisted job deadline remains the mutable authority across extensions; the
immutable manifest instead seals a 10-second permit window measured from the
actual runner start, and the daemon refuses to issue that permit after the
persisted deadline. Duplicate create for the SAME target store
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
such. Native executables and standard npm Node entrypoints use one launch
description; Node entrypoints preserve the vendor script and its interpreter
arguments instead of passing prompt text through a command shell. An unknown
custom batch file is not silently reinterpreted as a standard npm launcher.
Terminal-stdin setup wraps that resolved invocation with the adjacent ConPTY helper
only after its real `--probe` succeeds; doctor/quota print probes instead use
a detached, console-free runner with piped stdin closed immediately. A null
device is insufficient because the vendor treats character devices as interactive
input. Their bounded reaper
and passive registry retain normal cancellation and unconfirmed-child custody.
An ordinary daemon
stop/restart no longer terminates an awaiting-user login runner (that regression
killed the operator's own pending login in the 2026-07-21 incident); explicit
`setup cancel` and the login deadline's timeout escalation are the only signalling
paths. Group probes keep polling within the existing grace through transient
uncertainty (including macOS exit-time permission errors); only proven emptiness
closes the credential-mutation window. Persistent uncertainty stays unconfirmed.
Restart consumes an existing
terminal result first, then adopts a live runner only on positive evidence — a
matching durable handle, the same leader identity, and a nonempty process
group; a proven-dead group with no receipt is the unrecoverable
`cancelled_on_restart`, and identity uncertainty stays fail-closed as
`termination_unconfirmed`. A capability smoke with no durable completed receipt
becomes `interrupted_unknown` and is never auto-replayed. Terminal outcomes distinguish
`completed`, `not_supported`, `launch_failed`, `command_failed`,
`auth_not_ready`, `capability_verification_failed`,
`credential_route_mismatch`, `timed_out`, `cancelled_by_user`,
`cancelled_on_restart`, `interrupted`, `interrupted_unknown`, and
`termination_unconfirmed`. `interrupted` records a live monitor proving the
recorded group empty without a result; `cancelled_on_restart` describes that
evidence during restart reconciliation.

The global SQL event ledger is the only setup lifecycle and event authority;
the existing setup reducer and lifecycle binding consume that generation. Per-job `0700` directories under the daemon data root contain
only runner manifest/state/result/permit/launcher artifacts. There is no
per-job `job.json`, `events.jsonl`, metadata snapshot, or imported v1 registry.
Unreadable setup state fails closed; operational artifacts cannot reconstruct or
override lifecycle truth.

Every endpoint is loopback + bearer-token guarded. Apply endpoints read
`final/patch.diff` for Git work or the digest-bound manifest for copied-file
work; read-only modes without an applicable result return a real error instead
of local fake apply state.

`POST /v2/runs/:id/control` is capability-based. The implemented verb is `cancel`:
daemon abort closes the active harness stream and the process helper sends a
cooperative interrupt with hard-kill fallback. (The former `interrupt` control
kind was deleted as a fake knob — it mapped to the same daemon cancel.) Live
input into a running attempt is its own typed surface,
`POST /v2/runs/:id/messages`, described under "Live messages into a running run"
below; the former `/runs/:id/input` endpoint and `RunInput` DTO stay deleted (a
stub that always answered `unsupported` was dead code, not a channel).

A run blocked by the winning candidate's `NEEDS_HUMAN` findings (reviewer
escalation, protected-path change, critical-risk diff) retains lifecycle
`succeeded` with review-blocked outcome facts, projected as `run.blocked`.
Its findings surface inline on the blocking turn and in the
run-filtered workspace's Outcome facts (there is no separate Review Queue
screen). The gate is winner-only and fail-closed: losing candidates' findings
are disclosed run evidence that never blocks the selected deliverable, while a
winner missing its review evidence record blocks exactly like an escalated
one. The human decision is a typed server action:
`POST /v2/runs/:id/decision` records `accept_risk` / `override_needs_human` as an
auditable, patch-hash-bound record in the owning partition generation. The single-owner
Control API apply gate reads that authority; the mirrored
`arbitration/operator_decision.yaml` remains a compatibility projection for
artifact readers. `accept_clean_patch` delivers through `verifyAndDeliver` and
`rerun_with_feedback` enqueues a follow-up run. A mutated patch invalidates the
override. UI must not fake local accept/unblock state. The CLI resolves a run from
any cwd (project store, user Ask store, or — only when a daemon is already running —
the daemon registry); read-only lookups (`inspect`/`apply`) never auto-start a
daemon, while acting paths (`agent`/`best-of`/`create`, `decision`) do.

A successful run can be applied when its requested review passed or its frozen
`review_requested` is explicitly false and its review result is `not_run`.
Historical absence preserves the review requirement. Independent failed checks,
policy findings and unfinished work still block; the existing patch-bound risk
override remains separate. A clean cross-family verified review is sufficient
verification even without a deterministic test gate.
`DecisionRecord.verification_basis` (`none | deterministic_checks | cross_family_review | both`)
records actual evidence, so permitted unreviewed work never claims approval and
a no-test reviewed run never claims tests passed. Immediately before any envelope patch
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
`review_not_run` outcomes without a recorded opt-out, the apply gate states the real path forward (add a gate
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
of native sessions from the former live cwd are one engine-store mutation;
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

### Live messages into a running run

`POST /v2/runs/:id/messages` places a message into a run's ACTIVE agent
attempt while it runs (the nanny's correction that used to wait for the
terminal or cost a cancel+restart). The body is `{text, expectedAttemptId?}`
(1..65,536 UTF-16 code units, secret-like values refused like every prompt
ingress), the `Idempotency-Key` is REQUIRED and IS the message id, and the
route is served through the durable delivery ledger (`run.message`): a replay
under the same key returns the recorded receipt, a different body under the
same key is `409 idempotency_conflict`, and a command left non-terminal by a
daemon restart answers `409 delivery_interrupted`. HTTP carries only transport
facts (404 unknown run, 501 no service, 400 malformed/secret/too-long/missing
key, 409 idempotency, 500 receipt-save failure); EVERY typed outcome is HTTP
200 — deliberately unlike the answer and control routes — so a client reads
`outcome`, never the status code. The protocol major stays 3; clients discover
the route by its row in `GET /v2/operations`.

Three boundaries are reported separately and never conflated:

- **Daemon admission** — the run's `events.jsonl` gets a `message.accepted`
  row through a failure-PROPAGATING append BEFORE any native dispatch. When
  that append throws, nothing is sent and the receipt is `rejected` with
  reason `admission_persist_failed` (a new key is needed to try again).
- **Native acceptance** — outcome `accepted`: the harness's documented
  acceptance boundary was observed (Codex: `turn/steer` returned `{turnId}`,
  carried as `nativeTurnId`; Claude Code: the `command_lifecycle queued`
  frame for the message's uuid); consumption is unproved. No second row is
  written: the receipt is the answer and replays under the same key.
- **Native consumption** — outcome `delivered`: a correlated native
  consumption event was observed (Codex: the `userMessage` echo whose
  `clientId` equals the message id; Claude Code: the `--replay-user-messages`
  echo `{type:"user", isReplay:true, uuid}` or the `command_lifecycle started`
  frame for that uuid) and a `message.delivered` row closes the
  message. Obedience is still unproved — the model may ignore the text. The
  receipt reads `delivered` only when the echo reaches the adapter before it
  answers; for Codex `turn/steer` replies first (the echo followed 2.9 s
  later in the 0.156.1 recording), so the usual receipt is `accepted` and the
  echo then surfaces as the adapter's status event with code live_input_delivered — a
  `harness.event` timeline row carrying `message_id` and `native_turn_id` —
  which a client reconciles against its message id. No `message.delivered`
  row is written retroactively for an already-answered receipt.

Every non-delivery closes with a `message.refused` row carrying `outcome` and
`reason`: `rejected` (an explicit refusal of THIS submission: a vendor RPC
refusal on a still-active turn `rpc_refused`, a caller error `multi_attempt`,
or `admission_persist_failed`), `not_active` (no eligible target before
dispatch: `run_terminal`, `no_live_session`, `attempt_mismatch`,
`no_active_turn`, `interaction_pending`), `unsupported` (no live-input channel
for this harness/transport/run scope: `no_live_session` for an adapter that
declares `none` or lacks `message`, `thread_bound` for a thread turn), and
`delivery_unknown` (the message MAY have landed: `transport_lost`,
`response_timeout`; a receipt-save failure is the ledger's 500).
`accepted:false` on `delivery_unknown` never means "safe to resend under a new
key" — reuse the key to read the recorded verdict. Reasons come from adapter
and registry state only, never from vendor prose (INV-049). The payload of
every `message.*` row is `{message_id, attempt_id?, harness_id?, outcome?,
reason?, live_input?, native_turn_id?, text_sha256, text_bytes, text, title}`;
the retained SQL event copy in the owning partition drops `text` (like the
`run.created` prompt digest), the per-run `events.jsonl` keeps it, and the
timeline shows it as the row detail.

The daemon's in-process `LiveInputRegistry` (`packages/daemon/src/live-input.ts`)
is the one live-handle owner, fed by the orchestrator at the agent attempt
scope through `RunInput.onLiveAttempt` (a LIVE session-id getter, because a
native transient retry mints a new session id per try) and released in that
attempt's `finally`; `dropForRun` runs beside the interaction registry's on run
terminal. Its decision order: an unknown-and-terminal run → `not_active`
(`run_terminal`); a thread turn → `unsupported` (`thread_bound`: the
continuity packet would lose the message, INV-137); no live attempt →
`not_active` (`no_live_session`); several live attempts (race `n>1`) without
`expectedAttemptId` → `rejected` (`multi_attempt`); a mismatching
`expectedAttemptId` → `not_active` (`attempt_mismatch`); a pending interaction
→ `not_active` (`interaction_pending`) with NO vendor write, since a steer
beside an open `AskUserQuestion` would neither answer it nor be a work tool
(INV-048); an adapter without `message` or a profile of `none` →
`unsupported`; no native session yet → `not_active`; otherwise the adapter's
verdict passes through 1:1. Candidate attempts (including the synthesis
attempt) and the read-only ask/plan/report attempts register; reviewer lanes do
not and therefore answer `not_active`.

Steering lifetime is attempt-local: a native transient retry keeps the
registration (the getter follows the new session), while a convergence
attempt, an Exact Retry or a `rerun_with_feedback` run is a new attempt that
never re-injects earlier messages — the message was addressed to a session,
not to the task. Three disclosed residuals: a receipt that lands after the run's
terminal commit (the adapter answered late) is file-tail-stamped into
`events.jsonl` (`message.*` rows are in the post-terminal audit allowlist next
to `control.*`, so terminal-authority validation accepts them) — durable and
visible on the next timeline read, but the live SSE push for that row is
missed; a closing row that arrives WHILE the terminal is being committed
answers `500 message_receipt_unavailable` (the replay stays 500; the message
may have landed); and a consumed steer is not inactivity-watchdog progress until the
model's next output, so a message into a stalled session does not prevent its
timeout.

The channel is a per-adapter declaration, not a doctor probe:
`HarnessCapabilityProfile.live_input` (`mid_turn` | `next_tool_boundary` |
`none`, default `none`) is projected as `liveInput` on the `CatalogHarness` row
of `GET /v2/agent-capabilities`, and an adapter that declares a channel implements
`message(sessionId, {messageId, text})` beside `cancel`. Codex declares
`mid_turn` (app-server `turn/steer` against the snapshotted active turn; a
turn gap answers `not_active`/`no_active_turn`, an app-server without
`turn/steer` answers `rejected`/`rpc_refused`). Claude Code declares
`next_tool_boundary` through the native queue fold of its stream-json stdin
(`packages/harness-claude/src/live-input.ts`, recorded on Claude Code 2.1.283
through the real adapter path: `fixtures/stream-json/recorded-live-fold-2.1.283.jsonl`
and `recorded-live-final-text-2.1.283.jsonl`, replayed 1:1 by the conformance
tests): the message is written to the live stdin as a user frame whose `uuid`
is the message id, Claude Code queues it at once (`command_lifecycle queued`
within ~10 ms = `accepted`) and picks it up inside the same turn right after
the current tool batch (the replay echo, `command_lifecycle started` or
`completed`, or the result's `user_message_uuids` = `delivered`, surfaced once
as the `live_input_delivered` status event keyed by `message_id`). The managed
vendor pin (2.1.281) carries the same frames and flag; the pickup itself is
recorded on 2.1.283. A
message that arrives while the model composes its final text stays queued
and runs as the NEXT native turn inside the same run: the run loop's
`session.onIo` seam hands the adapter the live handle, `closeStdinOn` returns
false while a message is written-but-unreceipted, `queued` or `started`, or a
run-owned background task is open (`system/task_started` with
`is_backgrounded: true` … `system/task_notification`, so a background
continuation is kept too), the second `system/init` folds into the one
`started` (a `native_turn_started` status marks the turn), each result's
`usage.cost_usd` is the delta of the cumulative `total_cost_usd`, and the last
result's final text is the run's answer. No `queued` frame within 2 s answers
`delivery_unknown`/`response_timeout` (the stdin handle swallows write errors,
so a dead pipe surfaces this way), a session closed with the message still
unreceipted `delivery_unknown`/`transport_lost`, and a `cancelled|discarded|
refused` lifecycle state before consumption is typed `live_input_refused`
without failing the run. A one-shot argv run (no interaction channel; never
the daemon's shape) has no live session and answers `not_active`/`no_live_session`. Cursor declares `none` (no
persistent live-input channel: its prompt is piped once, then EOF); agy,
opencode, copilot and raw-api declare `none`. MCP exposes the existing channel
through `claudexor_run_message` (see [MCP controls](INTEGRATIONS.md#observing-and-directing-an-existing-run)).
There is no CLI message verb yet (`claudexor follow` is the later surface), and the
ACP server's `session/prompt` on an active session is refused rather than
bridged into a steer.

### Live-tree mutation paths

Every path that can mutate the live project tree is enumerated here with its
fence (Bible INV-113); an unlisted mutation path is a release blocker:

1. **Envelope delivery/apply** — `POST /v2/runs/:id/apply` and CLI
   `claudexor apply` both go through the delivery-owned `verifyAndDeliver`:
   the shared apply gate authorizes the run, a fresh verifier checks the exact
   patch, and an unchanged target preimage is required before mutation.
   Copied directory results use the same delivery owner and target lease with
   complete manifest-bound content, reproduction on the retained selected baseline,
   and per-file preimage checks. Partial delivery retains the remaining paths;
   direct effects and discard do not enter this apply path.
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
   same shape) executes directly in the live project tree. A delegated run
   that records `execution.workspaceRoot` (every delegated thread turn, and
   every new mutating one-shot) executes in that caller-owned tree and never
   mutates the project tree. Fences (the same
   machinery for Git-backed turns): a pre-turn snapshot is taken at turn/run start and a
   post-turn snapshot at turn end (the per-turn diff base, so prior dirty state
   is never attributed to the turn), and the server-owned `revert_run` decision
   uses an external content-addressed pre/post anchor (overlapping later user
   edits are refused, below). Explicit directory execution records its selected
   footprint and observed effects instead; it does not promise a whole-tree
   baseline or full rollback.
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
   success cannot launder an earlier blocked contribution). This preflight
   defers only a missing per-run final verifier, because turns may already be
   adopted into the isolated thread workspace. Review intent, independent
   checks, work completion, patch hashes and original-root binding still gate
   every contribution. Secret-like content is not a refusal: the thread
   delivers its live worktree capture, so `apply`, `branch` and `commit` carry
   the exact bytes the agent wrote; only `pr` refuses, inside
   `verifyAndDeliver`, for a text match or a blob-only binary finding, before
   the fresh verifier and any push (INV-062). Delivery reuses
   `verifyAndDeliver` with a fresh
   verifier and exact target preimage. Success advances the persistent thread
   branch and watermark with committed thread state.
5. **Automatic git init** — a NON-GIT project folder is initialized before a
   Git-backed mutating run shape crosses its boundary (`git init`, deterministic
   baseline commit). This includes the first mutating isolated-thread turn and
   Git-backed Agent write-envelope paths; explicit directory, read-only and
   supported non-Git in-place shapes do
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
8. **No secret-diff rollback** — the engine performs no mutation on behalf of
   the secret-like check. The reverse apply that used to remove an in-place
   candidate's bytes (and ran without the repository mutation lease) is gone:
   secret-like output is kept and only its saved and served copies are masked
   (see [Secret-like output: keep and mask](#secret-like-output-keep-and-mask)).
   The only extra write is the private exact patch object beside the revert
   anchors, outside the project tree and the run directory.
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

Review intent is resolved by `resolveRunReviewRequested` at command acceptance,
before global reviewer defaults are merged, and persisted in accepted params
without changing the original idempotency digest. New TaskContracts and outcome
facts carry `review_requested`; the field remains optional without a parse-time
default so historical hashes and review-required semantics remain intact. Exact
Retry, Run Again and feedback reruns preserve the source intent.
Review-off runs skip reviewer resolution, its preflight, evidence preparation,
sessions and budget leases. They retain deterministic policy findings and report
`review: not_run`, never `approved`. `reviewAllowsApply` is the shared predicate
used by arbitration, delivery, RunFacts validation and in-place projection;
the latter reports `applied` with a not-reviewed label instead of a false block.

Reviewer selection is Agent-only and schema-owned. Ask and Plan reject reviewer
panels, review switches and protected-path approvals; Council is Plan's critique path.
When requested, the automatic Agent selector uses provider-family
diversity plus optional per-family `reviewerModels` / `reviewerEfforts` hints.
For release and dogfood gates, the `reviewerPanel` field on
`ControlRunStartRequest` carries an
ordered list of explicit `{ harness, model?, effort?, credentialProfileId? }`
entries. An omitted profile uses the canonical model-first account pool. An
explicit `credentialProfileId` is strict: an unknown, disabled, mismatched,
unready, or quota-blocked row fails the explicit panel and never falls back to
another identity. Automatic panels disclose and skip a family whose pool is
unavailable. The CLI spells an unpinned panel as `--reviewer-panel` with
comma-separated `harness=model:effort` entries
(model and effort optional), e.g.
`--reviewer-panel "claude=claude-opus-4-8:max,cursor=gemini-3.1-pro"`. That panel is
used verbatim: repeated harness ids are allowed for multi-model Cursor passes,
no provider-family dedupe is applied, and unknown/unavailable/disabled/fake-only
or review-incompatible harnesses fail the run before review starts. If an
adapter can enumerate models, an explicit reviewer model must be present in that
inventory, and an empty/unavailable inventory is treated as unverifiable for
that explicit model. If an adapter cannot enumerate models, the explicit model
must match the harness manifest's known-good list; otherwise
the run fails loudly with a `claudexor models --harness` hint instead of letting
the native CLI fail later as unparseable review output.
Same-family panels are allowed for diagnostics and repeated-model comparison,
but they do not make a clean verified review gate by themselves: the gate still
requires at least two distinct observed provider families. UI clients may
send the same DTO but must not invent reviewer readiness outside doctor/status
and declared intent. The round-trippable CLI spelling for pinned entries is
`--reviewer-panel-json '<array>'`; MCP, ACP, and the macOS client carry the same
`credentialProfileId` field. Every reviewer slot receives a disposable generic
scratch/state HOME, while the adapter-owned profile credential store remains the
identity authority. Route proof, findings, and reviewer telemetry record the
requested/effective profile plus any profile id emitted by the harness, so a
requested pin cannot be mistaken for observed identity.

Reviewer prompts review the selected candidate through its patch or complete
file-manifest contract. The
retired standalone Plan-review subject has no runtime or surface representation.

Paid budgets use an explicit tagged contract: `{kind: unlimited}` or
`{kind: finite, maxUsd >= 0}`. CLI `--max-usd N` is syntax sugar for the finite
form, including `--max-usd 0`; zero and null never mean unlimited. The default
comes from `budget.paid_budget_per_run`. A single root ledger grants leases to
planner, candidates, synthesis, and review, and settles
observed spend even when work errors. Every route carries cost knowledge
(`exact | estimated | unknown`), billing knowledge, source, and provenance.
Ordinary included-subscription token valuation (estimated or exact, for
candidates and each reviewer route) is telemetry, not a cash debit. It is
projected BESIDE cash on `ControlBudgetSnapshot` (`valuationUsd` +
`valuationKnowledge`, also on the MCP read result), so proven included ordinary
work reads as exact `$0` cash with a non-null valuation; an unknown valuation
stays null, never a fabricated `$0`. A Processing cost basis carrying
`debit: "unobserved"` (every verified Codex subscription route) is the exception:
the route reports no actual cash or credit debit, so its reported cash stays
unknown (`spendUsd` null) while `controllableSpendUsd` and `remainingUsd` keep
the exact part the finite cap governs. The terminal decision record applies the
same split: `budget_summary.spend_usd`/`cash_usd` are null when the ledger's
reported cash is unknown, `controllable_cash_usd` carries the cap-governed part
(null when that is unknown too), and `claudexor inspect` prints
`budget: spend=unknown controllable=<usd>` instead of the known subtotal. Codex's token-only usage stays unpriced
unless explicit `CLAUDEXOR_CODEX_PRICE_INPUT`, `_OUTPUT` and `_CACHED` rates cover
every used token category; model names never imply a fallback tariff, and
included ordinary subscription cash is never priced from that optional
valuation. Premium native processing is separately qualified before ranking and
reservation; verified login alone cannot prove inclusion. Observed amount basis is
independent: vendor list prices are valuation, while unknown cash or credit
consumption stays unknown. Current native transports expose no authoritative
paid-credit debit amount, and the engine never invents one from token prices or a
session-level Fast setting.
Persisted routing cost averages carry a cost-evidence generation in the existing
metrics file. Older unclassified costs are read as unknown while duration,
sample counts and auth routing survive. A new explicitly unpriced attempt
clears the cost average; auth-only updates preserve compatible observations.
Mixed review panels classify
each observed amount separately from its prospective billing basis;
their aggregate is never blindly charged as cash. Panel admission keeps
declared Processing costs and already-observed slot costs;
an unvisited ordinary slot without a receipt does not invent an unknown-cost
hold. Later included slots cannot erase an observed paid or unknown hold. Candidate and reviewer
retries classify EACH usage event by that event/current typed credential
route and Processing evidence; a native→API-key retry cannot hide later metered spend under the first
native route, and an undisclosed route remains cost-unverifiable. A typed auth
fallback disclosed before the vendor process starts selects the carried route
but does not create a billable interval; only a real `started` interval can end
without a receipt and make cash cost permanently unknown. Candidate and reviewer
streams feed the existing lease hold with cash and unknown amounts on potentially
paid routes. A reviewer cap stops the panel while retaining partial usage;
unknown ordinary-included amounts do not become paid holds. `finite(0)` admits
only proven-zero or subscription-entitlement work; a positive finite cap permits
at most one unknown-cost paid unit in flight. A later exact charge above the cap
is retained and ends `budget_overshoot`; permanently unknown controllable cost
ends `cost_unverifiable` rather than fabricating `$0`. The cap governs only
controllable cash and never promises a provider-credit limit: an unobserved
included debit is settled as reported-unknown cash (`budget.cash` carries
`cash_knowledge` beside `controllable_cash_knowledge`) and is neither unknown-paid
debt nor a cost-unverifiable terminal, while an earlier paid interval without a
receipt keeps the family unverifiable. The Delegate belt commits a child's
`controllableSpendUsd` against its draw when the child's total spend is unknown. Later parallel race
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

Quota is typed, vendor-owned, never inferred from prose. Exact `applies_to_models`
and producer-declared `applies_to_model_prefixes` scope models. Without either,
model scope is vendor-wide. Independent `applies_to_request_kinds` defaults to text and image.
Codex maps codex/default to text, image_gen to image; full reads and rollout
`token_count.rate_limits` omit unrecognised buckets rather than invent applicability.
Notifications retain unknown buckets as diagnostic payloads, not constraints.
An image 429 reset supplies image-scoped `codex_image_response` for that credential
generation until its reset or a newer matching full window. Image admission uses
image scope; Agent/text admission, run pressure and Accounts summaries stay text,
while raw image windows remain visible and labelled. AGY declares Gemini and
Claude/GPT prefixes once: new family IDs inherit limits, unknown families no group.
Display, budget, routing, pacing and profile headroom share applicability; a spent
Fable window cannot cool Opus. Each recognised Codex window retains usage, duration,
reset, provenance and freshness. The global event ledger is authority. Elapsed
reset marks stale and requests refresh, never zeroes usage; unknown stays `null`.
The exhaustive schema trait registry classifies sources on four independent axes:
vendor-authenticated credential evidence, primary harness whose absence demands
refresh, top-level refresher production, and full-inventory versus incremental
replacement. Refresh demand is per enabled credential subject. Display/routing use
current-time freshness: without an earlier reset, fresh through exactly five minutes,
stale only afterwards.
Passive consumers can request `GET /v2/quota` with `view=constraint_freshness`
directly; discovering the GET quota operation's `view` enum in `/v2/operations`
is optional and must not block a passive read. The 3.24 engine
ignores the selector and returns its legacy shape; 3.25.0 and 3.25.1 reject it
with HTTP 400 (`view must be resources`). The strict
`ControlQuotaFreshnessResponse` adds required `constraints[].freshness` (`fresh`,
`stale` or `unknown`) from the raw snapshot's freshness and observation time, the
same five-minute TTL (stale only after 300000ms) and only that constraint's reset
(stale at or after reset). Raw stale/unknown stay so, null resets add no expiry,
null usage stays null, and evidence observed before an account reset cutoff is
stale for every window, as for the aggregate. An expired 5h window therefore does
not stale a still-fresh weekly sibling in this display projection. The historical
Codex `reset_credits` label is not a quota window: it carries the freshness of the
resets facet its count was read from, or `unknown` under an unknown snapshot.
Snapshot freshness stays the conservative aggregate; no usage, reset, observation
time or availability is rewritten, and elapsed resets never imply refill. The
read uses existing pruning rules without refresh or event writes. The legacy GET,
POST refresh (whose `view` stays `resources` only), Accounts responses, raw
schemas, routing and refresh demand keep their contract. Supporting engines reject
empty, unknown and repeated `view`; the catalog's `ControlQuotaQueryResponse` is a
union of four strict whole-response shapes (legacy, `resources`,
`constraint_freshness`, `resources_freshness`). A caller accepts only valid explicit or
legacy response; missing nested freshness in valid legacy data keeps conservative
snapshot freshness and never implies independent freshness or refill. Malformed or
partial explicit metadata, including mixed explicit/legacy constraints or
snapshots, is rejected without stripping metadata or silently downgrading. Only an
engine's explicit HTTP 400 for the selector permits one plain-GET fallback with a
strict legacy response check; transport failures, HTTP 500/other statuses and
malformed successful payloads do not. Neither the direct read nor that fallback
triggers provider refresh.
Background demand also looks through the next 60-second poll tick, so a matching
primary snapshot whose TTL or reset boundary is due by then (including equality)
no longer satisfies demand. Typed absence is a successful, displayable
observation that keeps soft demand under exponential pacing; reactive
rollout/retry and status-line evidence stays available to display and routing
without triggering or satisfying primary demand. The poll lifecycle is a
single-flight sweep paced PER VENDOR LANE: each vendor with a registered refresher
owns an independent completion-anchored exponential RETRY backoff (15-minute
ceiling) that advances after partial/absence outcomes and resets when credential
or routability state changes, so one vendor's unsatisfiable subject never pins a
sibling vendor's cadence. The ladder paces subjects that produced no evidence and
never postpones RENEWAL: a lane whose satisfied primary evidence (from its own
cycle, an explicit foreground refresh or an ingested harness event) is due by the
next tick runs even mid-ladder, so a revoked, never-logged-in or failing sibling
cannot hold its vendor's healthy subjects past their five-minute freshness; they
renew on the last tick before expiry like a lane with no absent subject, and a
vendor window reset within the next tick of the observing cycle is picked up on
that tick. A subject's poll rate-limit floor is never bypassed. An absence-only
lane keeps the pure ladder, and a lane whose last satisfied subject disappears
continues at its earned rung. Every refresher learns whether the cycle is an
explicit foreground refresh or a paced background poll, so a source may
re-present on request a credential it otherwise leaves alone. A typed
`rate_limited` poll absence arms a subject-and-route floor in the same
pacer/store. A bare 429 has unknown vendor bucket scope: policy holds the
observed subject and known token-identical aliases while unrelated accounts
continue serially at their normal cadence; token hashes are transient alias
evidence, never persisted. Missing Retry-After uses the subject's exponential
ladder. Foreground refresh respects these floors, and `refresh_skipped.subject`
names individual omissions. Old vendor-wide persisted floors stay in force until
their recorded deadlines. A credential change clears soft demand backoff, not a
rate-limit floor. Poll pacing is not inference quota and is never stored as an
exhausted window. Failed or suppressed refreshes stay explained beside stale data: refresh-gap
absences (`refresh_failed`, `rate_limited`, `probe_skipped_rate_limited`,
`poll_paced`) are silenced only by a FRESH full-source snapshot under the
coverage rule, so a new incremental window cannot hide a failed full refresh. A
paused subject lacking fresh cover and a stored absence is stated as a derived
`poll_paced` row (a live projection, never a stored event), so an exhaustion
reader that skips stale snapshots stays fail-open instead of promoting a stale
spent window into "window exhausted". A registry-owned credential generation
fences a provider cycle after validation and before its first event, memory,
absence, marker, response or cursor write. A foreground caller from a newer
generation waits for obsolete work to retire, then such callers coalesce into one
current-generation cycle; an obsolete poll cannot restore removed evidence or
satisfy a post-login refresh. Within one cycle the selected refreshers run
concurrently, validate every fulfilled snapshot and absence before the first
write, then fold in declaration order so first-claim and marker semantics stay
deterministic; each refresher's per-account vendor calls stay serial. `/v2/quota` and the atomic Accounts response decorate snapshots with the
same server-owned model-aware availability projection; stored event records and
projection signatures stay undecorated, and clients never promote a model-scoped
exhausted window into an account-wide percentage or block. A refresh persists a
subject's snapshot only when its evidence changed (all but `observed_at`; a
freshness flip counts): an unchanged re-observation keeps the
fresh observation time in memory, and the projection marker still publishes it.
After a restart a replayed snapshot therefore carries the observation time of its
last persisted change until the first admission poll (immediate on arm, then
every 60 s) re-observes it, so for up to one poll interval it may read stale or,
past the 24-hour window, drop out of the projection. The marker's
`projection_signature` is the sha256 digest of the projection (snapshots plus
absences), compared only for equality. A later recognized
primary observation reconciles old reactive constraints at the registry write owner;
its witness and changed reactive snapshots commit in one SQL event transaction, even
for timestamp-only re-observation. Reversed arrival uses the same witness, so a
delayed old refusal cannot revive a retired block, and request-start timestamps
keep an older in-flight poll from erasing a newer refusal. A generic unclassified block
can yield to a successful response without measured windows (usage stays unknown),
while independently identified or model-scoped windows need matching measured
replacement; a Codex refusal's text scope limits what it blocks, not which read
retires it.
This permits purchased or vendor-granted early resets without waiting for an obsolete
timer. Malformed Codex responses never become successful empty observations.

Native Claude `rate_limit_event` measurements and Codex's execution app-server
`account/rateLimits/updated` notifications use incremental sources
`claude_rate_limit_event` and `codex_app_server_event`: ordinary singleton-window
snapshots with independent observation time and freshness. For these sources
`quotaSnapshotIdentity` adds the stable vendor window identity, duration and
applicability, including normalized model-prefix sets, to subject, route and
source; empty prefix sets keep existing identities, and percent, reset instant
and observation time never change identity. Registry, budget cache and event
retention/replay share that key; control projections derive `snapshot_id` for
Swift so the UI does not duplicate source policy. Full-reader sources still
replace their complete inventory. Incremental observations neither refresh
siblings nor satisfy full-inventory demand; fresh applicable values keep the
ranking/headroom meaning, and missing windows stay unknown.

Incremental snapshots use `quota.window.observed` in the global event ledger,
with window slots grouped by subject for removal and retention. Historical records
keep their typed shape; the importer fabricates no primary/cooldown snapshot for
them.

A newer authenticated full read can supersede an older incremental observation
of the same measured window, duration, applicability, account and route: the
registry writes its full witness and `quota.window.superseded` in one SQL event
transaction, then removes that exact effective window. Its cutoff survives later
full-inventory replacement, display aging and event retention, so an old delayed
event cannot resurrect a cleared limit. A window recorded before request-kind
scope applies to both kinds; a measured replacement declaring a kind retires it
only with the same id, model scope and identical duration (unknown matches only
unknown), including the rollout `primary` → `codex:primary` mapping, and
explicit text and image scopes never retire each other.
Newer partial evidence is admitted again; equal timestamps stay conservative.
Missing or unmeasured windows never supersede known limits, and subject removal
clears observations and cutoffs together.
Unknown native applicability stays numerical diagnostic evidence, never an
account-wide restriction, and an overage name identifies no additional model
family. Each adapter translates numeric units: Claude stream utilization is a
ratio, Codex `usedPercent` a percentage.

Historical quota payloads remain readable: a scoped snapshot, or one whose
source postdates v3.2.0's strict enum (`cursor_rate_limit`), is first prepared
under a typed record an older engine ignores, then committed by the established
upsert with an explicit v3.2.0 field allowlist and the nearest v3.2.0 source label
in the base, which omits image-only windows rather than widening them to text.
Imported journal pairs keep their adjacency and new pairs commit in one SQL event
transaction; current reducers apply the exact scope and true source only when the
matching base follows. This encoding does not let an older engine open a migrated
SQL root; the semantic floor and forward-fix rule still apply.
A background cycle uses the same vendor refresher sweep; explicit foreground
refresh runs all eligible subjects. Paused subjects return last-known data with
`refresh_skipped` subject identity and deadline; only a legacy broad floor skips
the whole vendor lane. Join semantics are asymmetric: a
poll joining an in-flight foreground FULL cycle keeps that cycle's result (a
superset of what it wanted), while a foreground caller that joined a
lane-scoped poll cycle re-runs a bounded full cycle once the scoped one
completes — an explicit refresh never silently returns with sibling vendors
unre-fetched and no disclosure. Every served response remains the complete
projection.
`auto` ranks by the binding `min(elapsed_fraction - used_ratio)` pacing slack,
`quality` uses only exact user-declared `{harness,model,effort}` tiers, and
`economy` minimizes known incremental cash spend with quality tiers only as a
tie-breaker. Credential transport alone never proves a route free. Typed rate
limits that reject or block a run create cooldowns. A Claude rejection whose
typed `rateLimitType` proves an Opus or Sonnet family carries that same model
scope into both the live projection and persistent event ledger; generic or unknown
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
run evidence (`RunTelemetry.routing_rationale`), not an event: the ordered pool,
the ids dropped by `paid_fallback`/cooldown, the decisive `reason`
(`subscription_entitlement_first` / `lowest_incremental_cash` / `quality_tier` /
`expiring_quota_slack` / `all_incremental_cash_unknown` / `declared_order`), and a
per-candidate `{billing_knowledge, incremental_cost_usd, eligible}` tuple. It is
axis-aligned with the ranker, so it can never disagree with the order taken.
Mode-qualified billing evidence outranks ordinary auth-route evidence: verified
included ordinary service proves `subscription_entitlement`, so that route
survives `paid_fallback: never` and ranks with a real economy tuple instead of
reading as unknown/paid. Surfaces project the rationale verbatim (run detail) and
never reconstruct the order from prose. A named account's ordinary billing
evidence needs vendor-backed verification: an authenticated adapter response, or
the exact-profile full-reader vendor observation over a passing local probe.
Numeric quota expiry does not erase the fact or time of that contact; a newer
applicable refusal still overrides it. Local store presence, stale local
readiness and passive window notifications alone do not prove subscription
entitlement, and default-store doctor evidence applies only to a profile-less
route. The admission probe is reused for ranking and the initial reservation.
Each physical dispatch rereads its actual account's current verification, even
for an unchanged account ID, and re-admits it against the budget lease and
paid-fallback policy, including inline continuity summaries, rotation and runs
without Processing controls. A newer vendor observation is not frozen to the
initial selection; a valid positive reservation estimate stays independent of
billing verification. A Plan refused before any physical send releases its lease
and keeps the typed policy cause; started work without cost evidence stays
unknown. A policy refusal is a configuration failure, separate from a
monetary-cap or provider failure. The ranking rationale stays the original
selection evidence; the execution receipt names the account that ran.
A deep-scan swarm reserves n>1 subscription
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
spawn-failure / exit code / `harness_reported_error`) — never prose. The
centralized retry policy gates on each observation's `retryable` verdict rather
than a bare "saw a transient" boolean. The per-category table is the default for
signals an adapter disclosed mid-stream: adapter-disclosed transients and rate
limits retry with backoff (rate limits also feed W5.4 profile rotation), while
deterministic refusals (auth/capability/config) terminate. Give-ups — terminal
exit evidence, an adapter throw, an inactivity-watchdog abort — always carry an
explicit `retryable: false` whatever their category: they never schedule a retry
themselves (a typed mid-stream transient on the same try still decides as before).
A signal kill keeps `process_crash` and carries no vendor evidence. The typed
category rides `route.transient.detected`/`exhausted`, is persisted on the attempt
telemetry's `transient_failures`, and drives required-actions — authentication
guidance appears ONLY on a classified `auth_failed`, never on a timeout, rate
limit, or crash. `route.transient.exhausted` reports `retries` as the number of
same-profile retries that actually ran (zero when the failure was never
retryable) beside the configured ceiling `max_retries`.

A harness that voiced its own error and then exited non-zero did not crash. The
shared CLI run loop marks the terminal `completed` payload
`harness_reported_error: true` only when an `error` event was translated from the
harness's own stdout frames (the adapter's parse or its session handler) — never
for a spawn failure, an unconfirmed termination, a stderr-only failure, or the
loop's own synthesized "exited with code N". The classifier labels such a
non-zero exit `unknown_harness_error` (neutral next actions) and keeps
`process_crash` for a signal kill — whatever preceded it — and for a silent
non-zero exit. This is a label, not a policy: retry, account rotation, cooldown
and credential verdicts read exactly the inputs they read for a crash.

Vendor failure evidence: where a vendor keeps its own machine-readable failure
record, the adapter reads it after the process exited and attaches it to that
same `completed` payload as `vendor_failure`. Codex is the one producer: its
session rollout's last `task_complete.error` (`codex_error_info` + message), read
fail-soft from the run's own `CODEX_HOME` and bound to the turn this process ran
(the record must be the last completion, match the last started turn when the
rollout carries turn markers, and not predate the spawn second; any doubt yields
nothing — disclosed residual: an earlier turn that failed within the same second
as a resumed spawn that wrote no turn marker of its own). The orchestrator
forwards it to the terminal failure record as
`vendorFailure: { code, message, source }` for the attempt that record speaks
for (candidate lane: the first candidate; read-only lane: the last attempt;
budget, plan and deep-scan terminals carry `null`). The code is OPAQUE evidence,
forwarded verbatim with no mapping table: no Claudexor code path branches on
its value, it is never an input to retry, rotation, cooldown or credential
verdicts, and it never changes the record's `category`/`code`. Every other
harness, and any missing or unreadable record, yields `null`.

On every terminal path (zero exit, nonzero exit, abort), the shared CLI run
loop attaches a bounded, adapter-redacted `stderr_tail` to the terminal
`completed` payload — raw diagnostics on the attempts channel (events.jsonl /
SSE / `--json-stream`), never a verdict axis. Persistence into attempt events
is guaranteed for consumers that drain the stream to completion; an
orchestrator-side abort that stops consuming before the terminal event does
not persist it (bounded residue). AGY observes redacted stderr lines before tail
eviction, retains only confirmed native denial and projects it as typed run evidence;
a nonempty typed final remains usable with a warning, never proof of tool success.

Structured output: routes whose manifest declares `json_schema_output`
receive `HarnessRunSpec.output_schema` — a CALLER-supplied per-run schema the
run's final answer must conform to (agent race / ask answers), normalized and
strictified
for vendor strict modes (every object: `required` = all keys,
`additionalProperties: false`; inline root — both live-verified: codex
app-server `turn/start.outputSchema`, claude
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

Strict transport optionality is adapter-owned for the production review
contract. A caller schema keeps its original optional property semantics as the
conformance authority; for inline object properties and nested array `items`,
when the strict vendor form emits `null` for a property that was optional and
non-nullable in that original schema, the engine restores omission before
validation. Required or caller-nullable `null` values retain their original
semantics. Branch-dependent applicators, maps and conditional schemas remain a
typed conformance failure rather than being guessed. The receipt records the
number of restored adapter-created nulls as `normalized_optional_nulls`, while
the raw answer and invalid diagnostic stay unchanged.

Retained output is separate from completion authority. Sanitized assistant events
reach the per-run `events.jsonl` before live-preview suppression; candidate log
writes are not optional observer callbacks. Cursor buffered snapshots are tagged
as evidence and do not enter accepted-answer or retry predicates. The event-log
package projects this ordered stream into `final/retained-output.md`, separating
attempts and physical `session_id` values while retaining explicit delta bytes.
It excludes reasoning, tool output and status prose, and collapses only exact
adjacent delta/flush/final repetitions. A missing WorkReport still means an
unverified work state (a contract failure on the native channels, a disclosed
`unverified` on the instructed fence); no additional generation is performed to
repair the format.
A final-only successful answer without captured files needs no duplicate retained
document. Captured media references are added from the existing attempt capture, using distinct
attempt-scoped handles; the original text remains intact. The full retained
Markdown fetch is redacted like other text, but is not restricted by the log
preview fetch ceiling. Inline/native rendering keeps its own preview limits.
The direct observer delta cap does not truncate public event replay, whose
existing backpressure and client display bounds remain in force.

Retained output is also a source of the in-run EVIDENCE INDEX: when an
attempt continues on a fresh session (`packet` carrier), the successor's
prompt carries the retained assistant output beside the original work order,
the admitted steering messages, the tool-call index and the diff stat.

The announced-run guard materializes and announces retained output before the
existing terminal preparation fence, including deferred terminals. RunFacts
selects its report primary for diagnostic presentation; normal accepted output
remains primary on success. The retained filename never participates in accepted
plan/deliverable discovery. If storage fails, the original terminal cause stays
in force and a best-effort status names the preservation failure. Control detail
can reconstruct only the addressed interrupted run lacking a committed terminal
from surviving events, without changing its lifecycle, command record or RunFacts. Lists
and startup do not scan old logs; intentional retention remains authoritative.

Cancelled Git candidates retain their patch and actual execution-tree effects
through WorkProduct. Direct effects record the current pre/post snapshots and
existing revert anchor when available; isolated drafts are not adopted. A
convergence attempt captures its postimage before an early cancellation exit,
so it cannot advertise the previous attempt's anchor. Revert uses the recorded
execution root rather than a thread's later location or the stable project root.
Multiple unselected candidates retain separate patch links, without a winner.
Non-success Git evidence cannot be applied and follows ordinary age/reference
retention rather than an unfinishable pending-apply hold. A live run's Revert remains
available while that evidence is retained; a non-purged thread reference preserves it.

WorkReport envelope (D-16): on a `work_report_transport: constrained` route the
engine COMPILES a transport ENVELOPE `{ work_report, output }` that wraps any
caller `output_schema` and rides `HarnessRunSpec.output_schema`; the caller's
original schema stays the conformance authority for `output` after unwrap (the
contract keeps both). With no caller schema a `final_message` route (codex)
wraps the markdown deliverable as `output: string`; a `side_tool` route
(claude's `--json-schema` materializes a StructuredOutput tool) arms a
`{work_report}`-ONLY schema so the prose final stays the deliverable and the
report rides the tool payload (the adapter surfaces it on the final message's
`work_report_side_tool` payload); a `validated` route (cursor, agy, acp — no
native schema) ASKS the model to write its complete markdown answer normally and
end with a fenced `{work_report}` metadata block that the finalizer validates
off the last fenced block. Historical fence-only `{work_report, output}` replies
remain readable through a compatibility fallback; a nonempty markdown prefix
is always canonical, and legacy `output` is consulted only when that prefix is
empty. The three tiers
are one resolver (`resolveWorkReportEnvelope`) and one unwrap
(`unwrapWorkReportEnvelope`, keyed on the envelope `channel`;
`workReportEnvelope.ts`). The unified
attempt finalizer (`attemptFinalize.ts`) removes the transport beside
`finalizeStructuredOutput` — `answer.md` persists the deliverable, never a
valid envelope/footer — and validates the model-authored
`WorkReport { state, required_inputs }`. On the two NATIVE channels
(`constrained_json`, `side_tool`) a missing/malformed report is a typed
`work_report_contract` failure (never a prose success): there the envelope is
the only witness that the final is the model's own. On the INSTRUCTED fence
(owner decision 2026-10-05, partially revising the 2026-10-04 strict reading)
nothing enforces the footer, so any footer problem — no fence, a last fence that
is not JSON or not an object, an object without `work_report`, a malformed or
contradictory report (completed with `required_inputs`, needs_input without
any), a historical fence-only envelope with a non-string `output` — is a CLEAN
outcome: the lifecycle succeeds, `work_state` is
`{state: unverified, source: validated, unverified_reason}` (the typed reason
rides attempt telemetry and the run's outcome facts, and the shared outcome
banner renders `work state unverified: <reason>`), and the deliverable is
the COMPLETE answer text with nothing cut: a trailing fence that is the
consumer's own JSON or code stays, and so does a broken footer attempt, so a
malformed `needs_input` claim cannot veto but remains readable in the answer.
Only a VALID report is metadata and leaves the deliverable. The contradiction
claim is also retained as evidence (`reportProblem`) and a Council draft with it
is an ordinary accepted draft. A valid `needs_input`/`incomplete` report still
becomes a `work_state` veto on every channel; on the instructed fence it also
outranks an unusable historical `output` slot. The canary
`[INV-116:work-report-contract]` pins the native-channel failure.

Claude API-error results retain the originating attempt's vendor message and
nullable machine code as opaque failure evidence. A native stdout error result
carrying `api_error_code: claude_code_version_too_old` additionally produces the
`vendor_cli_too_old` request refusal: it names the selected entrypoint and observed
CLI version when known, recommends updating that installation and stops account
rotation. A generic HTTP 400 or a model answer quoting the error cannot produce
that refusal. Older CLI streams can omit the machine code; their original message
survives, while ordinary structural account failover remains available. No model
minimum-version table or prose classifier substitutes for missing evidence.

Context signals (D-16c) are a sibling of the transient-retry taxonomy and NEVER
enter the retry loop. The claude adapter maps FIXTURE-PROVEN 2.1.165 frames onto
the typed `context` field of `HarnessEvent`: result `terminal_reason` (`prompt_too_long` and
the rapid-refill breaker `rapid_refill_breaker` → `capacity_exhausted` with a
typed cause), the `compact_boundary` system frame → a compaction event, and the
top-level typed `rate_limit_event` → the existing `rate_limit` signal (a routine
`allowed` or `allowed_warning` heartbeat may carry independent measured quota
windows but never arms rotation). Codex exec's
recorded oversized-input refusal remains separate: the app-server preserves
RPC data and emits `request_refusal`, which reaches final failure as
`input_too_large` with Unicode-scalar measurements and no quota reset. It stops
account rotation, same-harness fallback-model and convergence retries; ordinary
failover remains unchanged. `capability_profile.input_limits` declares the
verified native turn-text bound only on the observed CLI version. The catalog's
`inputLimits` entry's `askPromptBudget` subtracts shared thread-pointer framing for ordinary
ASK initial attempts (`prompt-framing.ts`), including thread turns. Other shapes
remain unbudgeted; no predictive native refusal or guessed model window is added.
The native input cap excludes separate instructions and is not token capacity. A terminal `capacity_exhausted` with no completed
WorkReport maps to `interrupted / context_capacity_exhausted`.

One-shot continuation (D-16d): when an eligible terminal `capacity_exhausted`
(cause `repeated_refill` only — `prompt_too_long` may be an irreducible packet)
leaves no completed WorkReport, `continuation_count == 0`, and the run is
read-only or enveloped (in-place excluded), the engine launches ONE fresh native
session (`nativeResumeAvailable: false`) re-grounded by a mechanical-first
checkpoint packet synthesized via the continuity module (sibling of
`resolveContinuity`). The continuation is disclosed as a typed `run.continuation`
event with the count; on completion it supersedes the exhausted attempt as the
run winner. Context exhaustion keeps this thread-packet path; the in-run
continuation ladder below handles account and transport stops and discloses
its terminal through the same `resumable` block (cause `context_exhausted`).

In-run continuation (Agent and Ask only; the ladder inside one attempt): the
candidate loop and the Ask read-only chain hand every settled try to ONE
per-attempt planner
(`packages/orchestrator/src/inrun-continuity.ts`, pure decision in
`carrier-planner.ts`). The planner observes the stream — the native session id
on `started` becomes the attempt's durable SESSION CAPSULE
(`attempts/<attemptId>/session-capsule.json`: harness, session id, holder
profile, the located history file and its sidecars, cwd, requested model;
re-located through the adapter after the try settles), the typed limit that
ended the try, this try's attested model, the identity of a resumed session
(compared on `started` for adapters with the `continuity` capability, whose
resume keeps the id; codex compares the `thread/resume` reply before
`turn/start`; on other harnesses a new id after a resume is recorded as the
session) and the adapter's typed rejection of carried state. "Acted" is a
sticky fact of the attempt (an accepted answer, agent progress, a file change
or a diff in any try). An attempt that did not act keeps the rotation and
transient rules above, except typed context exhaustion and native permission
refusal end the attempt rather than replaying the same limitation. AGY's adapter
recognizes exact native-stderr auto-denial, not empty output or model prose.
Only a nonempty typed final keeps an answer with that warning; narration
cannot make the refusal successful. `permission_denial` records
`capability_refused`/`permission_denied` without upgrading access or retrying.
A DONE tool without output is diagnostic, not successful read evidence. After progress: a typed vendor limit on an
unpinned `rotate` route hops to the next eligible account and the next try
carries the work — `native_moved` when the adapter's `continuity` located the
session and moved it into the target store (claude: `<sid>.jsonl` + `<sid>/`
sidecars; codex: every rollout part). The capsule's holder is the source, even
if another account's packet try failed before starting. A move copies and
verifies all parts, then the engine writes the target capsule and invokes the
adapter's retirement callback; a failed move removes its destination copies.
When moving is unavailable, the carrier is `packet` (a fresh session whose
prompt is the original prompt plus the bounded evidence index; owner answer
1B) — never a fresh replay; a transport death (errored, not aborted, not a
typed refusal, not context exhaustion) resumes the same session on the same
account (`native`), or `packet` once a typed fact (locate miss, identity
mismatch, adapter rejection, no session ever reported) proved the native
carrier unusable, bounded by
`transient_retry.max_retries` per account; hops are bounded by the profiles
already tried. Claude's failed terminal CLI diagnostic naming a missing session
also rejects the native carrier; generic execution errors and model prose do
not. Existing transcripts misplaced outside the correct holder store are not
migrated automatically: a locate miss retains them and uses the evidence packet.
A bare backoff frame (`retry_delay_ms`, no reset, no
constraint) is transport when a session exists to resume. On a native carrier
the user prompt is one constant notice ("the previous process stopped …
continue from where it stopped … a cut-off tool call may or may not have taken
effect … finish with a self-contained final message") — the original prompt
is never resent and `instructions` are untouched (Claude resends its recorded
system prompt on resume). Native and packet continuations pin an initially
unspecified model to its attested id only when the route lists that id; observed
display labels are never sent as model ids. An input whose delivery is uncertain (a try that died
before its first `started`, a steering message admitted but not echoed) rides the notice
as a reference to reconcile, never a blind replay. Pinned accounts, `fail` /
`ask` policies and a spent pool end typed. Thread session/checkpoint publication
follows an accepted handshake; mismatched and packet-born sessions never replace
the lane binding. A packet continuation updates the thread disclosure to `packet`,
including a preceding lane switch. The next turn hydrates that lane through the
existing thread packet. Retained assistant evidence spans all accepted tries;
identity-mismatched tries contribute no assistant output, and their stream stops
at the mismatch. The evidence index pairs tool results by try and tool-use id,
includes pending edit calls, filters steering by attempt, and preserves full
evidence paths and tool counts when prose is truncated. Only begun continued tries settle with a
`run.continuity` receipt (try index, carrier, cause, from/to profiles, memory
full/partial/unknown, instructions as_sent/vendor_snapshot, re-ingested
tokens, this try's observed model and mismatch, identity check, input
delivery) beside the existing `route.profile.rotated` evidence. Every terminal
whose work is unfinished — non-success lifecycles and succeeded runs whose
work state is `needs_input`/`incomplete` — carries `resumable` on its
terminal event and in `final/resumable.yaml` (cause, `resetsAt`, window and
evidence, the carriers still usable, the native session and the workspace),
decided by the work outcome, never by the lifecycle word. Completed harness tries
also retain continuation facts when gates, review or arbitration leave acted work
unfinished (`cause: other`). Cancellation includes these facts for Ask as well as
Agent. An in-place or read-only execution root is `workspace: in_place`; an
isolated envelope is `none` in this release. Limit fields belong only to the
terminal limit cause and its try; pool exhaustion uses the pool's earliest typed
reset. A mid-stream hard budget cap ends the attempt without preparing another
try. The separate Plan pipeline keeps today's behavior: it does not use this
controller and does not emit these in-run `resumable` facts. Live plan checklists
ride typed
`HarnessEvent.plan_progress` (codex `todo_list` items; claude
TaskCreate/TaskUpdate accumulation — TodoWrite kept for older CLIs), forwarded
as last-wins `plan.progress` run events and projected on the run detail as
`planProgress`; per-candidate evidence cards are projected on the run
detail as `candidates` from attempt/review/decision artifacts.

Repository release review is independent of the product's internal review
engine. Current publication accepts a reference to the complete independent
report and dispositions plus the responsible maintainer's confirmation, and
binds the release to its exact successful CI candidate. The protocol is defined
in [CHECKLISTS](CHECKLISTS.md#release-review-protocol-inv-125inv-139); no local
per-commit hook, named model pair, timing overlap or signed review envelope is
required. Historical signature contracts remain readable through the archived
review verification helpers. Product reviewer selection, cross-family gates,
arbitration and delivery rules above remain unchanged.

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

Set `runtime.harness_inactivity_timeout_ms: null` in the config to disable
only inactivity timing; ordinary cancellation, stream cleanup, resource limits
and explicit run deadlines remain in effect. The numeric environment override
still takes precedence over this setting. A numeric window longer than Node's
single-timer limit (about 24.8 days) is waited in chunks rather than shortened;
`withInactivityWatchdog` is the one owner of that conversion. No existing persisted value is
rewritten, and omission retains the 60-minute default. Whole-run limits are
independent: optional soft/hard deadlines can be changed on the live run through
the [integration controls](INTEGRATIONS.md#embedder-run-controls-v21).

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
context/processing_intent.yaml?   (routed lanes' frozen speed intent; Codex applies it, §7)
attempts/aNN/attempt.yaml       (Agent candidate evidence)
attempts/aNN/answer.md?         (selected answer, even if capture failed)
attempts/<envelope-attempt>/retained-envelope.json? (inspection-source address)
attempts/pNN/council-input.yaml? (Council planner input evidence)
council/draft-<harness>.md?
council/membership.yaml?
attempts/aNN/patch.diff
final/files/manifest.json?    (directory WorkProduct)
final/files/content/<digest>?
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
final/retained-output.md?          # received text and captured-media handles, not acceptance
final/retained-changes.md?         # separate unselected candidate patches
final/explore.md?            (legacy deep-scan output; current runs write final/report.md)
final/explore-findings.yaml?
final/omissions.md?
final/report.md?
final/plan.md?
plans/<harness>.md?           (plan mode)
attempts/aNN/events.jsonl?    (read-only modes)
```

Patch writers publish identical bytes through a per-project content-addressed
`patches/<sha256>.patch` cache. Attempt/final `patch.diff` paths and private
`anchors/objects/<sha256>.patch` paths are ordinary hard links to those bytes;
replacing a saved patch publishes a new inode atomically. Ordinary saved copies
retain the existing non-flushing artifact-write contract; an anchor flushes the
shared inode before publishing its durable authoritative link. The cache path is
advisory. A mismatching cache object is atomically replaced with fresh supplied bytes before linking a new publication; existing links to the old inode are never rewritten. Filesystems that cannot link receive independent byte-identical copies. Masked display copies
and their different exact bytes remain separate objects. Existing plain-file
run trees and anchors stay readable without migration. Retention removes cache
entries only after their last run/anchor link is gone; an anchor keeps its
existing independent lifetime.

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

Attempt `processing`, `processing_cost_basis` and `usage_cost` preserve service
intent/submission/observation, prospective billing, and observed cash/valuation/
unknown amounts with independent knowledge. The optional
`attemptExecution` array on `ControlRunDetail`, also projected by MCP run reads,
contains `attemptId`, `harnessId`, and optional `processing`,
`processingCostBasis` and `usageCost` from those existing attempt records.
`usageCost` carries `cashUsd`, `valuationUsd`, `unknownUsd`, `cashKnowledge`
and `valuationKnowledge`. `unknownUsd` is a reported amount whose meaning is
unknown, not an estimate of all unobserved spending; zero components with
unknown knowledge do not prove zero cost. Clients can consume these facts
without fetching raw telemetry or reconstructing receipts.

Attempt `usage` and run `usage_totals` optionally include `input_token_usage`:
complete input `total_tokens`, `cache_read_tokens`, and `cache_write_tokens`, each
explicitly nullable. Codex reports inclusive input directly; Claude and Cursor
report fresh input separately from cache reads and writes, so all three components
must be measured to derive their total. Legacy token fields retain their original
harness-specific meanings. The attempt telemetry owner folds the new fields
strictly across token contributions and attempts: any unknown contribution keeps
that field unknown, while an unknown write does not hide known total/read counts.
`ControlRunSummary` projects this stored aggregate verbatim as `inputTokenUsage`.

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
and validates this object once. The terminal event carries that exact value;
the terminal-files owner projects it into `RunTelemetry.run_facts` and the
standalone receipt through its obligation after the SQL terminal commit.
`GET /v2/runs/:id` (`runFacts`),
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
inventory the legacy candidate plane is limited to diff-touched postimages.
Directory results instead supply the complete selected postimage manifest,
including unchanged selected inputs needed to review the result, through
`candidatePaths`. A text diff may be empty. The evidence
directory never inherits either rule: it is copied through its own explicit
redacted or sealed-packet boundary. Each reviewer artifact records which
inventory mode was used.
Reviewer scratch may initialize its own disposable Git metadata for native
read-only tooling; this never initializes the source directory or changes its
execution geometry.

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
  (`/v2/settings`, `/v2/secrets`), and partition/engine-state recovery
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
  to an external write-through temporary file; finalize binds the request,
  hashes and publishes immutable digest-bound bytes through the engine store's
  publication obligation, and returns the resource ID. `/v2/runs` and
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

Releases `3.8.0`, `3.9.0`, and `3.9.7` are owner-authorized publication
exceptions: their
GitHub Releases omit `runtime-manifest.json` and
`remote-runtime-manifest.json` rather than shipping unsigned substitutes.
Consequently, an existing app cannot update its engine in place to those
versions, and the app cannot perform a first-time remote bootstrap from them.
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
connected host). Claude, Copilot and OpenCode ensure their exact release
baselines while preserving an already runnable newer managed copy; explicit
maintenance installs the selected exact version. Codex's
ordinary CLI install preserves an already runnable managed copy at or above its
tested baseline; otherwise it resolves npm latest once into an exact semver
before disclosure and installation (`cli/src/harness-install-version-selection.ts`
owns that non-mutating choice before the install/proof owner mutates anything; it
never installs or takes the lease, but proves an existing local managed copy
with its bounded `--version`, and Codex's lookup is one bounded registry read,
so a dry-run runs both). An unavailable/malformed registry answer
refuses without silently substituting the baseline; the refusal names the two
explicit choices and, in JSON mode, is repeated on stderr because an SSH caller
of a failed dry-run receives only stderr. A missing bundled npm is refused as the
local `embedded_npm_missing` before any lookup, with no registry-retry remedy.
`--release-tested` selects that baseline explicitly instead of the latest
lookup and also keeps a runnable managed copy at or above it; installing the
baseline still needs the npm registry. `--vendor-version <exact>`
selects an exact npm version for either target. A refusal before the default
Codex selection discloses its harness, target and install location but no
command, version or evidence class rather than the baseline. Every npm recipe installs an
exact version, never a floating `@latest`; npm checks its integrity checksum.
The vendor-version constant remains the release-tested EVIDENCE stamp, not the
Codex install-default ceiling: model-hints and effort snapshots read it only
as a statement of what was measured. For claude it is
the effort-snapshot stamp, while the Claude known-model hint list keeps the
literal version it was last actually re-verified against (a pin bump never
restamps unrechecked ids). The pin records this release's verified baseline,
not a verification claim about a newer selected CLI (a recording that needs a paid live run
keeps the version it was captured from, as its fixture manifest states); the
opencode pin is a deterministic install target, not a verification claim —
no recorded fixture covers it yet, as its `vendor-cli-version.ts` discloses.
Cursor ships no npm artifact and cannot be pinned:
its vendor script is downloaded in full (`curl --fail`, never piped to a
shell), its size and SHA-256 are printed, and it executes in the visible
embedded PTY where the operator watches it — the human is the verifier, the
same principle as interactive SSH auth. Nothing installs without disclosure:
the CLI prints the exact selected package/version/destination install recipe
(`~/.claudexor/remote/vendor/bin`, which the remote wrapper puts first on
PATH) and requires a TTY confirmation or an explicit `--yes`, and the macOS
confirmation dialog shows the remote CLI's own `--dry-run --json` disclosure
before opening the terminal sheet. The app first reads the `current` pointer's
immutable `versions/<id>` target (the runtime installer's validated owner),
runs the dry-run through that closure's CLI and confirms through the SAME
closure, so a runtime switch while the dialog is open cannot change which CLI
executes. An npm dry-run of a current CLI carries
`versionBinding: "vendor-version"` (dry-run only; executed receipts keep their
keys), and the app then confirms with `--vendor-version` and the disclosed
version rather than resolving latest again. An older runtime omits the field and
rejects that flag, so it receives the legacy `--yes` confirmation and installs
exactly the fixed release version it disclosed; an unknown or contradictory binding yields no
prompt. A refused dry-run (for example `latest_unavailable`) is shown from the
CLI's stderr, unclipped and selectable; a `current` that exists but is not the
runtime symlink exits 73 with its own stderr reason rather than a blank refusal. An older app confirming against a current runtime cannot pin the
looked-up version: that runtime resolves latest again at execution and prints
its final disclosure in the terminal before running.
The typed evidence class
(`release_verified`, `deterministic_only`, or `human_observed`) that selects the
same honest version wording as the CLI: `release_verified` applies only when
the selected target equals the measured baseline; a newer latest is
`deterministic_only` even when its package installation succeeds. A remote
operator-watched npm exit does not prove installed version or native app-server
compatibility. Failures are typed and loud — a
failed or unreadable download refuses without executing, a non-zero installer
exit never reads as success, and Harness Doctor verifies the result
afterward. Every npm, curl, and vendor-script child receives the shared minimal
runtime environment, including proxy and trust settings but no provider
credential variables.

The installer recipe producer also accepts the explicit `local` target used by
host integrations. Npm harnesses then install under the existing managed Node
root (`~/.claudexor/node`, launchers in its `bin` on POSIX), which is already
shared by local resolution and
native harness PATH resolution; Cursor keeps its vendor-selected destination,
and normalized harness discovery covers both `~/.local/bin` and
`~/.cursor/bin`. An explicit `--target local --yes` is suitable for an
unattended Connect action that already carries the user's authorization. Cursor
is still unpinned in that flow: the typed evidence class is
`unattended_unpinned`, and the execute receipt records the exact downloaded
script's SHA-256 and byte length rather than claiming human observation. Local
installs take a user-scoped cross-process lease and recheck both the selected
exact npm target and its target-contained, non-empty launcher under that lease before
mutating the shared prefix; a partial package without its shim is repaired.
Every automatic selection (neither `--vendor-version` nor `--release-tested`)
also keeps a runnable managed copy at or above the release-tested baseline that
appeared after its selection read — for example from a concurrent Maintenance
update — the same rule the selection applied; a selected copy that broke or fell
below the baseline is reinstalled at its disclosed version. `--release-tested`
keeps such a copy through the ensure rule and otherwise installs the baseline,
and explicit versions still install exactly. Once npm ran, the executed receipt
names the version it installed; a copy kept under the lease is reported as
`installedVersion`.
Before any success receipt, the absolute launcher must execute `--version` and
prove the exact npm version. Cursor similarly rechecks the supported `cursor-agent`
name through the target-aware normalized harness PATH, permits the vendor's
official launcher symlink layout, and records its bounded non-empty version
line. Child exit zero without this proof is the typed
`install_verification_failed` outcome. A live owner gets a bounded wait. A dead
or old owner-less lock fails closed as `install_lock_stale` with the exact lock
path and a verify/remove/retry remedy; waiters never rename an observed stale
pathname because a new owner could have replaced it between observation and
mutation. An unexpected filesystem or child-process exception is normalized by
the canonical CLI projector as `harness_install_failed`; JSON mode still emits
one object containing every disclosure field already decided (before Codex's
default selection: harness, target and install location only).
On Windows the installer and harness resolver use the package's declared entrypoint:
a native program runs directly and a standard npm Node entrypoint runs through
its selected interpreter. Managed Codex and Claude installs and user npm prefixes
on the effective PATH share this owner. The logical vendor entrypoint remains
the identity shown by doctor and used by version/help/model probes; a Node
runtime alone is not a vendor identity. Script bytes remain part of login
executable evidence, with the selected invocation carried through the existing
manifest and permit. Ordinary missing PATH candidates are silent; a present
broken preferred entry remains diagnostic even when a usable fallback is found.
Explicit executable overrides never select a different installation implicitly.
Installer success still requires the declared version to execute, so a placeholder
file left by an incomplete package install cannot certify success.
A `.exe`/`.com` the resolver would start (a PATH candidate, a standard launcher's
declared native target, or a Node interpreter) must have the PE minimum shape: `MZ`,
then `PE\0\0` at the header's offset, read through the descriptor that supplied
the identity facts. A readable file without it, such as the npm placeholder left
when the package's postinstall did not run or a zero-filled download, is never
started. A skipped candidate or launcher target is named and a later healthy
candidate is used; a broken `node.exe` is passed over for a later healthy
interpreter without a diagnostic and is named only when none remains. When nothing
is selected, spawning the bare name would let libuv search again, the cwd first and
then PATH. The launch is refused before any process starts when the resolver proved
the install broken, so that search cannot start a file nobody selected (an image in
the cwd or under a relative PATH entry), or when the search would reach a proven
non-image. The refusal carries the spawn error the OS reports for that file
(`EFTYPE`) and its message leads with the file and the verdict. Claude doctor,
discovery, the broken-install advisory and bounded auth-status detail name the
unlaunchable file; Codex appends that detail to its missing-CLI summary. Windows
PATH is read as libuv reads it: normalization preserves quoted entries containing
`;`, an unclosed quote consumes the remaining PATH, a child env without PATH
searches the daemon's own PATH, and an empty PATH searches no directory. On every platform, relative PATH
entries resolve at the daemon's cwd, for a run and for the probes that vouch for its
binary alike, and the run is given the selected file's absolute path; an explicitly
relative override resolves from the child's cwd. The shape is not loader validity:
an image for another architecture or with damaged headers still reaches the OS, an
unreadable file or failed read is not proof. An incomplete header during an in-place
update can be refused for that inspection; the next resolution rechecks it.
POSIX executability rules are unchanged. The Windows
smoke is `scripts/windows-local-install-smoke.mjs`; native Windows login and Agent
execution are separate acceptance claims, not consequences of package resolution.
The omitted target remains `remote`; the SSH installer's destination and PATH
precedence are unchanged. With a current app and runtime, its approval binds the
disclosed exact version, including when the CLI resolved npm latest for the
initial dry-run. After any
successful local install, the embedding host
must request the existing fresh doctor/status projection before retrying login;
it must not trust a pre-install readiness cache, and this needs no new setup-job
or daemon API.

Local CLI maintenance uses `harness inspect` and `harness update --vendor-version`
(`cli/src/harness-maintenance.ts`), the same recipe/proof/lease as Ensure. Codex,
Claude, Copilot and OpenCode support exact npm targets; latest is resolved once
before installation by the shared bounded resolver in `cli/src/harness-latest.ts`,
also used by an initial Codex CLI install. Cursor and Antigravity on supported POSIX installations run
their native foreground updater at the selected canonical launcher under the
installation HOME. They expose latest only: the vendor resolves the target, and
unchanged version evidence never means "updated" or proves newest. External
overrides are identified, not silently replaced by a managed copy. Existing
Windows recipe limits remain.

`harness-maintenance-service.ts` exposes `/v2/maintenance/harnesses` and the
maintenance operation routes through existing command admission, queue,
idempotency, cancellation and retention. Blocking work runs in a custodied CLI
child. Before-version and target evidence precede mutation; failures, interruption
and unconfirmed termination retain their real effects without automatic replay or
rollback. Previous-version return uses retained proved before-evidence and
reinstalls it, so it depends on package availability. Inspection separates selected
version, managed copy, release baseline, available observation and supported
targets; `canCheckLatest` prevents a native update-only recipe advertising an
unimplemented check. Effects invalidate affected observations for on-demand reads.
Active maintenance is visible in readiness; it neither restarts the daemon nor
starts account probes, login or model generation. Operations use ordinary queue
slots and may wait behind active work.

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
image links use the registered-project-scoped, size-capped file endpoint (a
delegated run's image names that run, and is read from its recorded
caller-owned workspace under the same project id, above):
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
`3.8.0`, `3.9.0`, and `3.9.7` exceptions documented above deliberately have no signed
manifest assets, so clients refuse rather than weaken this verifier.

The app updates its **engine runtime closure** in place without a new DMG. The
update unit is a `claudexor-runtime-<version>.tar.gz` containing the engine-owned
resources: the bundled daemon, the setup-login runner, the Browser MCP
deployment, the native process-identity helper, and the reviewed operator CLI
used by embedding hosts. App-owned Node, UI, and icons stay outside the
closure, so a Node bump ships a new signed DMG.
Each release also publishes a **signed** `runtime-manifest.json`. The independent
`scripts/build-engine-resources.sh` stage bundles the engine; on Darwin, it signs
native helpers before both the app and `scripts/build-runtime-closure.mjs` consume
that same tree. Linux stages omit Darwin helpers and cannot produce the universal
update closure. The app does not re-sign those helpers; CI compares every engine
entry after app signing/notarization. The closure builder materializes
internal package links into regular files/directories, rejects links escaping
their closure entry, special files, and `.node` addons, and suppresses macOS
AppleDouble sidecars. The shipped file bytes therefore come from the exact app
resources the release gates smoke-tested while the archive itself needs no
POSIX symlink semantics.
`release/runtime-min-app-version.json` is the tracked `minAppVersion` floor
(validated `<=` the release version by `scripts/verify-version-parity.mjs`), the
app-vs-engine skew guard. Engine 4.0 requires application 4.0. An older app
reports `appUpdateRequired` and keeps its current working engine; updating the
app supplies the compatible decoder and Node before engine activation.

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
`<node-root>/lib/node_modules/npm/bin/npm-cli.js` (Windows: `node.exe` and its
adjacent `node_modules\npm\bin\npm-cli.js`), with no ambient-PATH npm
fallback. The root package's
supported runtime floor is Node 24.15.0, and the store checks bundled SQLite
3.51.3 or newer before opening data. A supported version declaration alone is
not proof of a release-built closure; embedders retain exact-toolchain smoke evidence. The pin also
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
are ignored. The additive `launch:{nodeArgs,basis:{memoryBytes,source}}` gives
the engine-selected Node heap flag: half of the container memory limit when one
is below physical memory (an unlimited Linux cgroup reports `UINT64_MAX` and does
not count), otherwise half of physical memory, capped at 16384 MiB and never below
the plain Node process default. `source` is `cgroup` or `physical`. Run probes with
plain `node <entry> --probe`; put the returned `nodeArgs` before the entry on
daemon launch. An explicit `--max-old-space-size` in the child
`NODE_OPTIONS` wins: add no flag. The CLI applies this rule without changing
`NODE_OPTIONS`, re-executing the daemon, or affecting harness child heaps.
The macOS app launcher runs the same probe before each daemon start and
passes `nodeArgs` the same way (all-or-nothing on the exact flag form).
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
offline Ed25519 runtime-update key, separate from historical review keys and
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
enforces this wiring. Runtime-update signing remains separate from the archived
review-signature authority; archived review signatures cannot authorize current
publication. The same A-5 boundary covers the release application:
publish verifies and promotes the candidate DMG, ZIP, and SBOM byte-for-byte;
only the signed runtime manifests and final checksum set are
created by the publish run.

**Install flow.** One click (bottom-left chip → Install) runs
`RuntimeInstallCoordinator` (`apps/macos/ClaudexorApp`): verify monotonic →
download the closure from the release CDN asset URL → sha256-verify against the
signed manifest → FULL unpack to `versions/<version>/` → re-verify → strip
`com.apple.quarantine` (after hash verification) → probe-start the unpacked
daemon with the app-bundled Node via `claudexord --probe` (prints
`{version,buildSha}` and exits without binding a socket or opening the store) →
require that exact pair to equal the signed manifest → claim the shared app
lifecycle lease described under Layout below before the first async install
step → advisory idle probe (cheap early deferral) → read the exact serving
identity and require the signed version to be strictly newer than it under the
same monotonic rule (a cached offer can predate another app copy's replacement,
so a newer engine or another build of the same version is refused before any
stop) → daemon-atomic
runtime-replacement admission (`claudexord --stop`: synchronously prove no
queued/running run, active setup job, or unreconciled setup termination and fence
every ingress; busy/unknown
refuses without stopping; the request names the freshly observed serving
version/build SHA and writer-lease owner) → identity-proven termination
confirmation with no-successor proof (never a raw kill) → ATOMIC `current.json`
swap (write a temp file + a single rename, inside a `flock` over the whole
check-then-swap critical section) → relaunch → handshake-verify the new engine's
exact identity against the signed manifest and its normal product admission →
rollback to `last-known-good.json` when the relaunched engine has another
identity or never answers, while that reader remains compatible with the
retained state, accepting recovery only when its exact identity returns with
normal admission. Every startup answers `recovery_only` before admission opens,
so the bounded poll waits through it. If the exact new engine answered in
recovery mode and normal readiness was not confirmed by the deadline, it is not
rolled back, even if it stopped answering: it may already hold state the previous
reader cannot open. It stays selected with the historical recovery observation
and unconfirmed readiness reported. A previous engine answering only in recovery
mode after a rollback is a failed recovery, not a rollback. Handshake `ok` remains the
connectivity/protocol verdict: the app still waits in Connecting against a
recovery-only engine, and identity-bound stop and reconciliation still name it.
After a feature writes
new terminal facts or publishes the SQL store an older reader cannot understand,
recovery retains that state and uses a compatible newer runtime. A last-known-good
pointer cannot bypass the data root's semantic floor, as described in the daemon
lifecycle section.
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
  with the live handshake before hydrating daemon state. Exact version and SHA
  are coherent regardless of entry path. Automatic replacement requires a
  strictly newer stable x.y.z target; a newer serving version or unorderable
  versions keep the compatible daemon. Equal-version alternate builds require
  the one-shot Settings action described in DESIGN_SYSTEM. The action binds both
  displayed identities and expires if either changes; ordinary Reconnect and
  passive polls never request that switch. Replacement still requires the daemon
  to atomically prove idle and fence admission; busy or unknown activity keeps
  the compatible daemon alive and visibly defers reconciliation. A successful
  replacement retires the old client and re-reads
  discovery before hydrating;
  any failure after lifecycle work begins goes offline rather than reusing an
  ambiguous process. An installed selection's probe must also equal the pointer's
  exact `{version,engineSha}` authority; the signed bundled selection uses its
  stamped probe as authority. The three-second identity poll retries deferred
  work when the daemon becomes idle. Reconciliation and in-app installation
  claim the same exact lifecycle lease before target observation. Its nonblocking
  descriptor lock lives in the canonical discovery directory, independent of app
  or socket spelling, and serializes participating app copies across the full
  stop/start/proof transaction. On first launch the app creates a missing private
  service directory before scheduling daemon startup. An existing owned canonical
  directory is validated by uid, POSIX canonical path and pathname/descriptor inode identity, then
  repaired to private permissions through that descriptor, matching engine
  admission. Directory and lock opens do not follow leaf links; the app does not
  acquire the engine's writer slot. Admission separates contention from refusal.
  A lease held in this or another participating app, or one completed in this
  app after the caller's observation, is contention. Contention is no new
  observation: a passive poll keeps the notice and Settings offer published for
  the same serving identity, and an explicit Switch Engine Build checks and
  changes nothing, offers the same exact pair again with the reason and keeps
  polling its connection without reconnecting or retrying. Outage recovery keeps
  its start allowance and installation reports another lifecycle action. A
  completion in another app is invisible to that process-local check, so outage
  recovery re-reads discovery and handshakes once while it holds the lease,
  before it consumes the allowance; an engine that answers is adopted by the
  next ordinary probe instead of being started again. An unusable service
  directory or lock file
  (a link, foreign owner, non-private or multiply linked lock, or any other open
  or lock error) is a refusal naming that path, never another owner.
  Reconciliation keeps the compatible engine and shows the refusal as its notice;
  outage recovery stays Offline with that notice, reported again by each later
  outage, and re-checks after its ordinary pause without consuming the start;
  installation fails before any download or stop. The sidebar update chip shows
  the notice above any update offer or install outcome, and the Connecting and
  Offline placeholder shows it when the sidebar is not shown. The offer and
  notice belong to the connection that observed them: a lost handshake retires
  both, and a recovery-only answer retires the offer and its guidance. Superseded
  switch progress is retired without clearing a later notice or the terminal
  failure carried into reconnect. Discovery and serving
  identity are re-read under
  that lease, with another identity check before stop. Outage recovery shares
  the lease through handshake readiness or the bounded boot window. A queued
  outage launch must present its exact lease and unexpired deadline at the actual
  spawn boundary, under the owner lock. A retired connection's loop releases its
  lease when it next checks the generation, after its current pause or probe;
  that exact release invalidates a launch that has not spawned yet. Exact release
  explicitly unlocks
  before closing so inherited descriptor references cannot prolong that lease.
  Exact token and connection-generation guards prevent stale completion from
  clearing a successor's ownership or publishing its predecessor's identity.
  The app lock never replaces engine root/writer authority or the installer's
  pointer lock; older apps and external clients still rely on those engine
  controls. Node is ALWAYS the
  app-bundled binary; because the
  whole closure unpacks together, the Browser MCP resolves adjacent to the
  daemon inside the same version dir.
- **Check flow** (foreground / bottom-left chip / Check for Updates — no timer):
  GET the latest release manifest (`api.github.com`, ETag-cached) → verify the
  signature fail-closed → compare `version` to the running engine and gate on
  `minAppVersion` → surface "Update available → vX.Y.Z" with an Install action.
  The last install attempt's historical outcome stays visible above any later
  Install and "View release" offer, and a local engine notice sits above both,
  never instead of them; only an active install replaces it. A selected engine,
  including one observed
  only in recovery mode, retires its offer; a recovery-only install clears the
  stale serving identity so a re-check uses the selected runtime pointer until
  normal connection adopts an identity. A refused install whose offer is no longer
  newer than the observed serving version recomputes the cached decision against
  that version and clears its ETag, so a subsequent 304 cannot rearm the stale
  offer. That observation does not report an installation. There is no background
  update timer.
- **Build-sha stamping (QA-002).** `build-engine-resources.sh` stamps `CLAUDEXOR_BUILD_SHA`
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
  in the global SQL event ledger through `QuotaRegistry`; routing reads that
  cross-run authority rather than rediscovering pressure independently in each
  run. Codex uses its app-server. Claude subscription windows arrive from the
  `oauth/usage` endpoint as the PRIMARY source (since 2.1): the daemon's
  refresher reads each logged-in config dir's OAuth token transiently, retaining
  only the expiry timestamp and refresh-token presence beside the one-request
  access token (never the refresh token itself) —
  every claude `config_dir_login` row (subject = its profile id), plus the
  legacy default native dir (subject null) only while that store is
  UNMIGRATED. A refreshable token that is expired or within Claude Code's
  five-minute refresh window first wakes the vendor's documented, prompt-free
  `mcp serve` lifecycle in the exact profile environment. No MCP frame or model
  prompt is sent; Claude Code owns its refresh lock, token rotation, and store
  write while Claudexor observes expiry metadata only, then re-reads the access
  token for the bounded usage request. A still-valid token remains a fallback
  when the proactive wake fails; an expired token yields a typed
  `refresh_failed` absence. A refreshable token with unknown expiry is still
  probed, but a 401/403 cannot prove revocation and yields the same
  `refresh_failed` absence. Only a token proven fresh at rejection remains typed
  `auth_revoked`; a token without refresh capability retains that conservative
  real-response verdict. A proven rejection is remembered per presented token
  (its hash, in process memory — never persisted or logged): background cycles
  re-state the same typed absence without re-presenting that token — the
  vendor answers repeated 401s with a one-hour 429 that would black out every
  healthy sibling of the lane — until the token bytes change (any re-login), a
  daemon-side credential change clears the memory, an explicit foreground
  refresh re-asks, or six hours elapse — after which the memory re-verifies
  one remembered token per cycle, never all at once. Other endpoint failures yield NO
  snapshot and no auth verdict. The user-scoped status-line payload
  (installed explicitly by the Claude host-plugin lifecycle) remains a
  SECONDARY source for the legacy null subject only; its collector stores only
  allowlisted windows in the external v3 root and composes/restores any
  existing display command. Per-run budget observations remain run evidence,
  not quota authority.
- Quota operation diagnostics reuse the daemon log (`quota.observation`): source,
  profile, operation id, time, cause, known currentness and native binary/child
  facts are non-secret metadata. A physical Claude usage HTTP attempt, a skipped
  token, and a Codex native RPC are different observations; an RPC does not imply
  one HTTP request. Native refresh receipts describe observed expiry and child
  outcome, not an inferred writer or reconstructed historical credential loss.
  Retry-After and existing foreground/background polling rules are unchanged.
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
  in the command store and retained root metadata; envelopes created by CLI/MCP/ACP runs
  in roots the daemon never saw are reclaimed only by their own process. For a
  caller-owned `execution.workspaceRoot` recorded by a delegated command (global
  or project partition), it disposes only Claudexor's envelope scratch under that
  root's runtime namespace; it never deletes the caller's tree or its Git refs.
- Web use is optional under `auto`, `cached`, and `live`; no
  did-this-task-NEED-web resolver or mandatory evidence gate is inferred from
  those policies. `off` remains the only strict external-context policy.
- Read-only flows never materialize a Git boundary, capture a patch, or emit a
  patch WorkProduct. An isolated thread reuses its worktree only after a mutating
  turn has already materialized it; otherwise it reads the stable project.
  Git-backed write envelopes initialize per INV-075. Explicit directory Agent
  execution uses the [directory contract](#directory-execution); the legacy live
  Agent convergence path keeps its non-Git copied baseline.
  A root equal to the user home directory or a filesystem root — or one that
  cannot be classified — is refused with the typed `git_boundary_root_refused`
  error before any mutation instead of being initialized (INV-075 exception);
  ordinary non-git roots keep the announced auto-init only for Git-backed shapes.
  If the capture cannot observe a legacy in-place patch run's changes (no copied
  baseline, a failed `diff`), Claudexor records a capture refusal: a sanitized
  `manual_cleanup` receipt in phase `workspace`, with nothing rolled back; it
  never substitutes an empty diff and asks reviewers to trust the live tree.
  All `runCaptureRaw` callers share a combined stdout/stderr buffer policy of
  256 MiB (not an RSS bound): capture, delivery/revert Git and reviewer inventory
  reads refuse larger output. Oversized binary inspection withholds that payload
  from saved copies without discarding an already complete compressed patch;
  `pr` refuses it like a secret-like finding (one refusal names both causes),
  while local apply, branch and commit deliver its exact bytes. Overflow,
  spawn/I/O or scratch-cleanup failure becomes typed workspace evidence,
  including budget/stream, primary cause, cleanup and any available
  incomplete-drain facts. Thread apply refuses an incomplete capture with 409
  and these facts in problem `context.captureFailure`; its delivery journal
  replays that context. Completed answers are saved per attempt and observed
  spend survives both post-try and final-only refusal. The failed post-try
  capture is reused; a new native try resets it.
  Isolated sources survive disposal and startup sweeping in existing durable
  envelope custody, with auth stripped. Eligible daemon singletons retain their
  continuation pointer; other sources have distinct
  `attempts/<envelope-attempt>/retained-envelope.json` addresses and are for manual
  inspection, not automatic continuation or already-applied live results.
  File GC and command pruning keep these addresses, like the continuation
  pointer, until explicit discard. Only these destructive owners read strictly:
  an absent or stale address and released custody read as nothing held, while
  an unreadable or invalid pointer or custody record (not only an unreadable
  attempts directory) keeps its run and is reported (GC `errors[]`, daemon log);
  explicit discard reports that failure and releases nothing, never only the
  readable sources. Projections keep tolerating the same addresses.
  Capture receipts/actions name the execution root, also after the own remedy
  of a budget terminal, a leading Delegate failure (its record carries the typed
  capture facts as well) or a convergence cancellation; such terminals keep
  their cause and publish no exact patch (live effects keep their capture-refused
  record, in race cancellation too, so the public result never reads as
  `not_applied` while the tree already changed). A race cancellation writes no
  failure record: an isolated source it leaves in retained custody is named
  only by attempt evidence. A budget terminal the ledger
  settled on the same attempt (stream hard cap, exact overshoot, unverifiable
  cash) outranks that attempt's capture failure in race and convergence: the
  shared classifier names the budget cause and remedy first and the capture
  facts and inspection actions follow. A live race capture failure shares the
  isolated lane's no-working-candidate terminal, so a recorded budget denial or
  a unanimous typed refusal leads there too, as in convergence. A cancellation
  that wins late (during a
  Delegate parent's child drain, or a drain that fails after it) re-labels a
  prepared failure record that carries capture facts as the cancellation's own
  (category `cancelled`, its summary, no typed code) instead of removing it, so
  those facts and the inspection/manual-cleanup actions stay on the public
  failure surface; a record without capture facts is removed as before. A child
  drain that fails without a cancellation leads with its own typed failure and
  keeps such a record's capture facts, with its actions as follow-ups. An
  inspection-only source's root is in
  attempt evidence (`capture_refusal.sourceRoot`); its measured size is only in
  that envelope's `continuation-custody.json`, not the singleton
  `retainedEnvelope` UI.
  Durability requires this custody schema: an older engine can reject the new
  inspection field and reclaim its source on downgrade. Capture results do not
  promise preservation across that rollback; export kept work before it.
  Non-Git text is projected to 200,000 characters while draining, with binary
  inspection beyond that preview. A clipped preview carries explicit incomplete
  capture and cannot enter exact apply/revert/digest/synthesis; the live source
  remains available. Complete small previews retain their existing behavior.
  Explicit directory file-manifest capture is separate: its refusal carries no
  typed capture facts, so the late-cancel and drain rules above do not keep it.
  No truncated exact Git patch is delivered. Cursor NDJSON frames remain uncapped.
- Isolated-thread worktrees are pinned by persistent `claudexor/thread-*`
  branches. The stored SHA is a checked cache; successful apply advances the
  branch, and explicit trash/restore/purge owns its retention lifecycle.
- Explicit reviewer panels accept only proven routes: an unprofiled/default
  entry requires doctor-OK readiness, while a profiled entry requires its exact
  profile probe even when aggregate/default doctor is unavailable. A degraded
  raw default route (key present but unproven by isolated smoke) is refused even
  when the user names it — reviewer verdicts must ride proven routes, unlike
  candidates where explicit selection admits degraded.
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
- `claudexor profiles login cursor <id>` runs the vendor's own login in the
  operator's terminal through the daemon's existing `client_pty` setup job.
  The CLI reads the registered binding, creates its job and uses the sealed
  manifest, one-use attachment and built runner. Vendor state remains in the
  binding's scoped store; Claudexor neither reads nor copies credentials.
  Claude/AGY profile login keeps its direct vendor terminal path, including
  its known delayed-observation limitation (BACKLOG W-f). Non-Codex
  `profiles login --json` refuses before preparing or starting a login.
  Codex retains its durable device-code flow; GUI/non-interactive login uses
  the existing setup API.
- The setup event ledger owns the credential-mutation window from durable permit
  through terminal verification. A hash-bound runner result or a positively
  empty recorded process group establishes the command's end. Fresh profile
  verification runs while the window remains open; terminalization closes it.
  The existing monitor also settles a proven-empty group with no receipt as
  interrupted, after checking once more for a result published during that
  proof. A missing sidecar never releases a permitted job. An unattached
  reservation without permission remains replaceable. A bound pre-command
  failure is a launch failure; actual unknown termination retains custody.
  Physical executable bytes are checked before permission; an already
  permitted vendor's self-update does not invalidate its original sealed
  command and recorded process identity.
- Opening and closing each invalidate the process-wide caches, ledger marks
  and credential generations plus that harness's auth readiness. While its
  window is open, the Cursor status coordinator and Claude LKG neither reuse
  nor retain observations; fresh probes still answer and may admit work.
  Refusal marks and subscription-row unusable callbacks are generation-bound.
  The aggregate doctor/status projections are invalidated at the transitions;
  they can show an intermediate observation until close. Model-operation substitution callbacks and default/API-key unusable callbacks
  also use the dispatch-bound managed generation. Descendants outliving a valid runner
  receipt remain outside the command-completion proof. An unreadable bound
  setup store reads open; restart alone proves no closure. The hold is per harness,
  not a blanket admission ban. A genuinely unconfirmed group still needs the
  existing proof-based reconciliation.
- The Cursor CLI requests cancellation on Ctrl-C, SIGHUP and SIGTERM. A lost
  attachment without a runner receipt also requests cancellation; failed
  delivery is visible and custody stays with the daemon. An already-attached
  or fenced job names its id and the full CLI's `setup cancel <jobId>` and
  `setup reconcile <jobId>` commands, which call the existing API. Cancellation
  is asynchronous and reconcile requires positive termination evidence; these
  commands do not claim that request acceptance means a finished login.
  The packaged daemon's alternate `setup attach` role stays attach-only.
  A hard-killed client cannot cancel; a live vendor retains its job until its
  own result, explicit cancellation or the existing deadline. A permitted
  historical unconfirmed row without provable group evidence remains a
  disclosed recovery limitation. The interactive CLI exits zero only for a
  succeeded verified job, or 130 after its handled interruption.
