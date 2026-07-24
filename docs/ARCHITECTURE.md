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
- `plan` - read-only multi-harness planning; writes `final/plan.md`.
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
The harness decides when to spawn bounded, isolated sub-runs; the belt exposes
ONLY `claudexor_ask`, `claudexor_plan`, `claudexor_run` (isolated envelope
sub-run — forced envelope, forced no-thread), `claudexor_best_of`,
`claudexor_run_status`, `claudexor_run_result`. There is NO
apply/decision/thread/settings tool: the PARENT integrates results in its own
workspace. Policy is enforced SERVER-SIDE at the tool boundary (never trusting
the harness): nesting depth is 1 (the sub-runs a belt spawns carry no belt of
their own, so nesting cannot exceed 1 — the belt also refuses when observed at
depth>0), a max sub-run count per parent (default 8), and each sub-run draws a
paid budget bounded by the parent ledger's headroom snapshot (finite headroom,
or a typed refusal when exhausted — never a silent unlimited run). Only adapters
whose `capability_profile.mcp_injection` is true (claude, codex) can host the
belt; `--delegate` on any other harness is a typed preflight refusal naming the
harness. This replaces the former `orchestrate` mode (retired in v3); ordinary
`claudexor plan` covers the "suggest"-style use-case.

Old mode ids (`audit`, `orchestrate`, `best_of_n`, `max_attempts`,
`until_clean`, `explore`, `create`, `readonly_audit`, plus the older
`daily`/`until_convergence`/`readonly_swarm`) are NOT aliases: they hard-error
at every wire boundary.

## 3. Package Map

- `packages/schema`: Zod schemas, TypeScript types, generated JSON Schema,
  control DTOs, mode ids, config shapes, `RunTelemetry`.
- `packages/util`: shared helpers (ids, time, hashing, redaction, config dirs,
  safe file IO).
- `packages/core`: adapter interface, shared CLI run loop, process helpers,
  doctor runner, typed errors. Default write modes are orchestrator/envelope
  paths, not direct live-tree execution.
- `packages/orchestrator`: the canonical mode pipelines (ask, plan, agent) with
  strategy flags (race width, attempt caps, until-clean, deep-scan, create,
  delegate); owns run telemetry and policy gates (trust, risk, protected paths),
  typed transient retry policy, and no-progress outcomes.
- `packages/gateway`: harness discovery and capability/intent gating (route
  selection itself lives in the budget router and orchestrator routing).
- `packages/harness-codex|claude|cursor|opencode|raw-api|fake`: adapters that
  translate native CLI/API streams into typed `HarnessEvent`s. The `fake-*` kinds
  are deterministic offline test fixtures (incl. `fake-implement`, which writes a
  real worktree file); they are explicit-`--harness` only and never enter
  auto/reviewer pools.
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

The orchestrator is the ONE resolve owner. There is no user-settable "Active"
account — enabling/disabling a profile is the only routing control. The
per-harness EFFECTIVE account is resolved by an owner-locked ladder (INV-135
accounts authority): an explicit per-run/per-thread pin (`credentialProfileId`)
wins; else null — POOL AUTO, the native/CLI login default subject. Enabled
profiles route ONLY by explicit pin or as quota-rotation targets, never as a
silent auto-default. The resolved account becomes the typed `credential_profile`
on every `HarnessRunSpec` the run builds (and keys the lane's read-only home),
so the pin flows to the spec, preflight, continuity, and session recording. An
unknown/disabled/harness-mismatched explicit id is a typed refusal before spawn.
When the native/CLI login is EXCLUDED
(`harnesses.<id>.native_credentials_enabled: false`) and there is no pin, an
unpinned run has nothing routable: an explicit selection refuses naming the
setting, an auto pool drops it — nothing silently falls back INTO the disabled
login. An explicit profile is STRICT in the adapter —
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
id, clears any harness's `rotation_eligible` entry at the deleted id, marks matching harness/profile
native-session caches stale, and removes profile quota snapshots, so deletion
cannot leave a route that fails on the next turn or resurrect a session if the
id is recreated. Dependent journal
invalidation happens before registry removal; any unhealthy project partition
returns typed 409/recovery-required, leaving the profile retryable.

Selection precedence is turn > thread-sticky > native/CLI login: a turn's
explicit `credentialProfileId` (CLI `--profile`) beats the thread's durable
`credential_profile_id` (PATCH /v2/threads/:id), which — when null — resolves to
POOL AUTO (the native login default subject). Accounts are SYMMETRIC (D25): the
listing (`GET /v2/credential-profiles`, `claudexor profiles`) projects, per
harness, every credential profile with its `enabled` flag (the only routing
control), the native "CLI login" pseudo-row state (`native_credentials_enabled`
+ a detected native login), and the server-computed informational `next_up`
identity (profile | native | none-with-reason) — who an unpinned run would route
to next, computed by the routing owner — ONE projection so no surface re-derives
the symmetry. A profile's `enabled` toggle is `PATCH
/v2/credential-profiles/:harness/:id` (CLI `profiles enable|disable`); the
CLI-login toggle is a per-harness setting
(`harness.<id>.native_credentials_enabled`).
External thread create/PATCH calls with an explicit pool are rejected unless
the profile id exists for every pool lane. Run preflight probes the selected profile for every lane even when the
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

Every public CLI mode (`ask`, `plan`, `agent`) and the
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
in the user-level store `~/.claudexor/v3/runs/<run_id>/`. If routing or the harness
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

Envelope semantics are strict. Project runs execute under
`~/.claudexor/v3/projects/<project-sha256>/workspaces/<task>/<attempt>/tree`, and
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
- `GET /v2/agent-capabilities`
- `GET /v2/credential-profiles`
- `POST /v2/credential-profiles`
- `DELETE /v2/credential-profiles/:harness/:profileId`
- `PATCH /v2/credential-profiles/:harness/:profileId`
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
- `GET /v2/projects/:id/outputs`
- `GET /v2/projects/:id/outputs/<path>`
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
  turn (`ThreadTurn.enqueue_error`, projected as `enqueueError`) so every
  surface renders the refusal inline instead of an eternally-empty bubble. The
  readiness refusal is enforced at run-start (not by a bespoke early return in
  the control API), so it rides this exact mechanism and stays durable,
  idempotent, and replayable. `POST /v2/threads/:id/turns/:turnId/retry`
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
  artifact-only CLI reads; the apply gate reads journal authority;
  `accept_clean_patch` delivers; `rerun_with_feedback` enqueues a follow-up;
  `revert_run` uses an immutable external content-addressed anchor and restores
  only recorded postimage bytes that still match; overlapping later user edits
  are refused instead of overwritten. The anchor remains reachable independently
  of Git garbage collection.
- `GET /v2/runs/:id/produced` and `GET /v2/runs/:id/produced/<path>` serve the
  project's PRODUCED outputs — the repo `artifacts/` dir, the macOS workspace
  Artifacts-tab source — distinct from the run-internal `GET /v2/runs/:id/artifacts` tree.
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
  to a single `delivery_state.yaml` stat (all other artifacts are frozen once the
  run is terminal). The bare parameterless call stays valid — it now yields the
  newest 200 with a cursor to page the rest.
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

The open questions themselves ride the SAME projection: `ControlRunDetail`
carries `planQuestions` (the parsed `PlanQuestion[]`) beside `planReadiness`,
from one artifact read — so surfaces RENDER questions without re-parsing.
The interactive CLI (a TTY plan turn on a thread) offers to answer inline
(numbered pick for `single`, comma-separated for `multi`, free line for `text`,
blank to skip) and submits the composed answers as an ordinary follow-up plan
turn through `POST /v2/threads/:id/turns` — the same lane, no separate answer
channel; non-TTY/`--json` prints readiness + guidance only. The ACP surface
(chat-first, Zed) renders the question set as TURN TEXT (numbered, options
inline, marked which accept multiple picks or free text) and ends the turn
normally; the user's next prompt is an ordinary follow-up plan turn. ACP's
`session/requestPermission` bridge stays reserved for single-choice RUN-TIME
interactions (the SDK 1.2.x has no multi-select/free-text typed input, so the
end-of-turn question batch is rendered as text rather than a faked typed form).

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
runs N members as parallel planner attempts (each the SAME native-plan-mode
read-only spawn the solo loop drives, in its own lane on a thread turn), whose
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
disclosed in the log). Awaiting-user interactive login runners are the one
exemption: the shutdown drain does NOT signal them (a detached Terminal login
survives an ordinary daemon bounce and is reconciled on the next start;
explicit cancel is the only killer). A hung participant cannot immortalize the
daemon whichever trigger asked it to die. The daemon records its birth identity in
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
Codex (`codex -c cli_auth_credentials_store=file login --device-auth` in its
dedicated `CODEX_HOME`, the device-auth default; the request `loginFlow`
selects `browser_redirect` for the explicit localhost-callback opt-in), Claude
(`claude auth login`, the claude.ai subscription route with no version-varying
flag), and Cursor (`cursor-agent login`). The setup runner probes
`codex login --help` before spawning — `--device-auth` exists only on recent
codex, so an older CLI yields a typed `not_supported` outcome with the upgrade
or `--browser-redirect` remedy, never an opaque argv error, and the probe fails
open. The runner tees codex login output so the operator still sees the URL and
one-time code, and persists a bounded ANSI-stripped tail on the result so the
daemon can disclose the real failure cause (e.g. the ChatGPT "Allow device code
login" toggle being off) instead of a bare exit code. The daemon writes a
private runner manifest; Terminal
starts the bundled absolute Node + runner; the runner executes the absolute
vendor binary without a shell, inherits the TTY, scrubs provider credentials,
and atomically records PID/kernel-start/process-group and result sidecars. It
never receives or persists a vendor token or credential file. Apart from the bounded, ANSI-stripped, secret-redacted diagnostic tail a
FAILED codex login persists, vendor output is not copied into durable logs, and Terminal stays open on the result until the
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
unproven identity is never signalled or called cancelled. An ordinary daemon
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

A run blocked by `NEEDS_HUMAN` findings (reviewer escalation, protected-path
change, critical-risk diff) is a terminal `blocked` state whose findings surface
inline on the blocking turn and in the run-filtered workspace's Outcome facts (there is no
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
`TaskContract.constraints.protected_paths` holds config-owned **approval globs**
— path globs (e.g. `migrations/**`, `**/*.env`) whose changes escalate a run to
a human-approval gate before it can be applied — while
`TaskContract.constraints.auto_protected_paths` is derived from configured
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
2. **In-place thread turns** — a write turn executes directly in the thread's
   execution tree. Fences: a pre-turn snapshot is taken at turn start and a
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
5. **Automatic git init** — a NON-GIT project folder is initialized before any
   write candidate spawns (`git init`,
   deterministic baseline commit). Fence: the mutation is announced via a typed
   `project.git.initialized` run event — never silent.
6. **`revert_run`** — the server-owned in-place revert reads the immutable
   external patch anchor and reverses only bytes still equal to the recorded
   Claudexor postimage; a conflicting user edit is refused and left untouched.
7. **Thin `CLAUDE.md` bridge** — at the same write-mode run-prep stage as the
   automatic git init (INV-075), a project root that has `AGENTS.md` and no
   `CLAUDE.md` gets a thin `CLAUDE.md` whose body is the official Anthropic
   import form (`@AGENTS.md`) plus a Claudexor ownership marker, so a Claude Code
   route reads the same instruction file Codex/Cursor/OpenCode read natively
   (Codex additionally gets `CLAUDE.md` as a project-doc fallback via config, and
   a CLAUDE.md-only project needs no write at all). The bridge is written in TWO
   places, because an isolated envelope worktree materializes only the COMMITTED
   tree and so never sees an untracked project-root bridge: (a) the PROJECT root
   (the durable, in-place/thread-visible write, announced via a typed
   `project.claude_bridge.created` run event — never silent); and (b) each
   git-mode ENVELOPE worktree at workspace prep, so a Claude Code candidate racing
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
   doctrine as the `.claudexor` artifact-dir exclusion. Fences on both writes: the create is EXCLUSIVE (`O_CREAT|O_EXCL`)
   and NO-FOLLOW, so a hand-written `CLAUDE.md`, a symlink (even dangling), or a
   directory at that path is never overwritten or written through; it is
   idempotent, so a second or concurrent prep is a no-op; the project-root write
   is skipped for read-only modes and `--in-place` stateful targets exactly as
   the git boundary excludes them. A bridge failure never fails the run (it is a
   convenience, not a precondition).

Reviewer selection is schema-owned. The automatic selector uses provider-family
diversity plus optional per-family `reviewerModels` / `reviewerEfforts` hints.
For release and dogfood gates, the `reviewerPanel` field on
`ControlRunStartRequest` carries an
ordered list of explicit `{ harness, model?, effort? }` entries. The CLI spells
this panel as `--reviewers` with comma-separated `harness=model:effort` entries
(model and effort optional), e.g.
`--reviewers "claude=claude-opus-4-8:max,cursor=gemini-3.1-pro"`. That panel is
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
native route, and an undisclosed route remains cost-unverifiable. `finite(0)` admits
only proven-zero or subscription-entitlement work; a positive finite cap permits
at most one unknown-cost paid unit in flight. A later exact charge above the cap
is retained and ends `exhausted_overshoot`; permanently unknown cost ends
`cost_unverifiable` rather than fabricating `$0`. Parallel race waves reserve a
per-candidate estimate floor (`budget.estimate_usd_floor`, default $0.05) after
the first slot, so concurrent estimated work counts against headroom before
usage streams.

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
schema) INSTRUCTS the model to end with a fenced `{work_report, output}` JSON
block that the finalizer validates off the last fenced block. The three tiers
are one resolver (`resolveWorkReportEnvelope`) and one unwrap
(`unwrapWorkReportEnvelope`, keyed on the envelope `channel`). The unified
attempt finalizer un-nests the envelope beside `finalizeStructuredOutput` —
`answer.md` persists the OUTPUT, never the envelope — and validates the
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
mutation invalidates every result and starts a new freeze, and the signed
schemaVersion-4 attestation binds the candidate SHA/tree, gate receipt digest,
reviewer report digests + verdicts, and — for a packet-split wave — one full
triad+scope panel per named sub-wave plus the sealer-recomputed union-coverage
receipt mapping each sub-wave to its exact pack digest (INV-125). (Older
schemas are archival only: already-sealed attestations stay verifiable for
their own releases, never as new publish input.) The operational protocol — panel composition, wave discipline,
structural floors, and round bound — is defined ONCE in `docs/CHECKLISTS.md`
(Release review protocol); this map does not restate it. The old per-commit
staged-diff hook, bypass log, and installer are removed so they cannot compete
with or be mistaken for release authority. Product command `claudexor review
--diff <file>` remains a normal engine capability; it is not this repository's
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
final/telemetry.yaml
final/patch.diff?
final/work_product.yaml
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
composer, the thread workspace (`Changes | Artifacts | Evidence`), Settings, and
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
  spoof it). A successful browser navigation therefore satisfies a required-web
  gate (`web.verification: verified`) and records a typed
  `browser: {attempted, satisfied, failed, unused}` receipt; a failed browser
  call blocks required web with the real error rather than "web never attempted".
  An armed-but-unused browser (generic `web_search` satisfied instead) is
  disclosed as an unused-browser flag on that receipt — disclosure only, never a
  run failure.

### Engine runtime updater (M7, D22/D23)

The app updates its **engine runtime closure** in place without a new DMG. The
update unit is a `claudexor-runtime-<version>.tar.gz` — everything the DMG stages
into `Contents/Resources` EXCEPT Node (the bundled daemon, the setup-login
runner, the Browser MCP deployment, and the native process-identity helper).
Node stays app-owned, so a Node bump ships a new signed DMG. Each release also
publishes `runtime-manifest.json` (`{version, sha256, minAppVersion, signature:
null (reserved), notes}`) built straight from the signed app bundle by
`scripts/build-runtime-closure.mjs`, so the shipped closure is byte-identical to
the one the release gates smoke-tested. `release/runtime-min-app-version.json`
is the tracked `minAppVersion` floor (validated `<=` the release version by
`scripts/verify-version-parity.mjs`), the app-vs-engine skew guard.

**3.0 ships the update CHECK only** (owner-locked D1). The one-click
auto-INSTALL — download → sha256-verify → unpack → probe-start → stop the idle
daemon → atomic `current.json` swap → relaunch → handshake-verify → rollback — is
DEFERRED to 3.1: that path signals a running daemon process, so it ships whole
and reviewed in 3.1 rather than half-wired in 3.0. The release pipeline, the
manifest/closure assets, and the pointer READ below are all forward-compatible
with that installer.

- **Layout.** Runtimes live under `~/.claudexor/runtime/versions/<version>/`; the
  active one is named by `runtime/current.json` (version + path + sha256), and
  `runtime/last-known-good.json` is the 3.1 rollback target. `DaemonLauncher`
  resolves the daemon script through `current.json` when it points at a valid
  version dir, else the bundled `Contents/Resources` path (the 3.0 norm — nothing
  writes `current.json` until the 3.1 installer does). Node is ALWAYS the
  app-bundled binary; because the whole closure unpacks together, the Browser MCP
  resolves adjacent to the daemon inside the same version dir.
- **Check flow** (foreground / bottom-left chip / Check for Updates — no timer):
  GET the latest release manifest (`api.github.com`, ETag-cached) → compare
  `version` to the running engine and gate on `minAppVersion` → surface an
  informational "Update available → vX.Y.Z" chip that links to the GitHub release
  for a manual download. No download, unpack, or daemon signalling happens in 3.0;
  the auto-install flow lands in 3.1.
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
  envelopes (forced no-thread), depth is capped at 1, and each draws from the
  parent budget headroom.
- Planning rides the normal thread/turn path (the spec-interview state machine
  and its in-process grounding runs were retired in v3): a `plan` run surfaces
  typed open questions, answer turns refine it on the same persisted lane, and
  Implement freezes it as a content-hashed brief. There is no separate spec
  surface, spec-session store, or grounding-run job class.
- `--json` mode guarantees exactly one JSON object on stdout for run/ops
  verbs; interactive TTY question prompts (follow/agent Q&A) remain human-text
  affordances by design. Every FAILURE class — argument/usage validation,
  pre-daemon bootstrap (e.g. `EPERM` on `fchmod`), typed preflight/daemon
  problems, transport errors, and unexpected exceptions — is normalized by the
  ONE top-level projector (`packages/cli/src/cli-error.ts`) into a single
  failure envelope `{ok:false, exitCode, code?, message, retryable?,
  fieldErrors?, requiredActions?, details?, context?}` (with a legacy `error`
  alias of `message`), generated from the SAME typed problem as the human
  stderr line. A run-scoped failure (inspect/apply/decision) may add a
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
