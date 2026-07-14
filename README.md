# Claudexor

Claudexor is a local-first control plane for AI coding harnesses. It runs Codex
CLI, Claude Code, Cursor CLI, OpenCode, raw API adapters, and future harnesses
behind one typed interface.

The core rule is simple: a harness is not a role. Roles are intents such as
`explain`, `plan`, `spec`, `implement`, `create_from_scratch`, `repair`,
`review`, `verify`, `synthesize`, `audit`, and `orchestrate`. Any harness
that declares the capability can be assigned the intent.

Current status: **v1.0.1**. See "Stability at 1.0" below for what is a
stable contract and what remains experimental; retired verbs and mode ids
hard-error with the new spelling instead of silently aliasing.

## Prerequisites

- Node.js >= 20.19 (the daemon, CLI, and every surface run on Node)
- pnpm (via corepack: `corepack enable pnpm`)
- git (worktrees, envelopes, and delivery all use it)
- At least one logged-in vendor CLI — `codex`, `claude`, `cursor-agent`, or
  `opencode` — OR a provider API key (adapters accept `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, ... as fallbacks; the raw-API route needs only a key)
- macOS for the desktop app; the CLI/daemon also run on Linux

## Install

CLI + daemon from npm (installs the `claudexor` and `claudexord` bins):

```bash
npm install -g claudexor
claudexor doctor
```

You can also build from source — see Quickstart below.

The macOS app ships as a signed and notarized DMG on the
[Releases](https://github.com/razzant/claudexor/releases) page — download,
drag to Applications, open. The app is self-contained: it bundles its own
daemon runtime and starts it on launch; installing the CLI is only needed
for terminal use. (The v1.0.0 DMG was unsigned — if you kept it, either
upgrade or approve it via System Settings → Privacy & Security → Open
Anyway.)

## Quickstart

```bash
pnpm install --frozen-lockfile
pnpm build

# Run the CLI from the repo (or add an alias/PATH entry for it):
node packages/cli/dist/cli.js doctor
alias claudexor="node $(pwd)/packages/cli/dist/cli.js"

claudexor ask "2+2?"
claudexor ask "google the latest release notes" --web auto
claudexor explore "map this repo's auth and run storage"
claudexor agent "fix the failing auth refresh test" --harness codex
claudexor best-of "fix add() and keep the patch minimal" --harness codex,claude --n 2
claudexor inspect <run_id>
claudexor follow <run_id>     # live event tail of a daemon run; answers questions in the TTY
claudexor apply <run_id> --dry-run
claudexor doctor
claudexor secrets list
claudexor daemon start
```

`apply --dry-run` checks `final/patch.diff` with `git apply --check` and does
not mutate the repo. Unknown flags and invalid `--access`/`--web`/`--effort`
values fail loudly with exit code 2 — a typo never silently runs with defaults.
When deterministic gates protect existing test/package surfaces and the task is
explicitly test-authoring work, use `--allow-protected-path <glob[,glob...]>` to
record typed per-run approval for those protected gate/test path changes. This
does not bypass built-in critical/security human gates.

## Modes

Canonical mode ids (exactly five intents; engine strategies are
FLAGS, not modes):

- `ask` - read-only answer/explanation route. The macOS composer's no-project
  fallback intent (Agent is the default on a project thread).
- `plan` - read-only multi-harness planning and draft SpecPack grounding.
- `audit` - read-only audit/map report; `--swarm` runs the bounded research
  swarm (per-explorer findings, synthesis, omissions, follow-up questions).
- `agent` - default `claudexor agent` route. Strategy flags: `--n N` (best-of-N
  race with isolated candidates, review, synthesis, arbitration),
  `--attempts N` (repair loop with a hard cap), `--until-clean` (repair loop
  until gates/review converge, budget/quota exhausts, cancellation happens, or
  the run stalls), `--create` (create-from-scratch intent).
- `orchestrate` - the orchestrator: routed like reviewers, produces a typed
  orchestration plan over the six-tool vocabulary (start_run / race / status /
  answer_question / apply / review); the default tool belt is five —
  `answer_question` is deliberately not offered by default.
  `--autonomy suggest|auto_safe|auto_full`
  controls how much the executor runs: `suggest` (default) plans only;
  `auto_safe` runs the safe steps (isolated envelope sub-runs / pure reads) and
  blocks at the risky `apply` step for a human decision; `auto_full` also
  applies through the single shared delivery gate, so it can mutate the live
  project.

Unknown modes fail loudly. The old strategy mode ids (`best_of_n`,
`max_attempts`, `until_clean`, `explore`, `create`, `readonly_audit`) and the
older ids (`daily`, `until_convergence`, `readonly_swarm`) are NOT aliases.
Note the wire-mode vs CLI-verb distinction: `claudexor explore` and
`claudexor create` are CLI convenience VERBS that map onto `audit --swarm` and
`agent --create`, while the old WIRE mode ids above still hard-error at every
API/DTO boundary.

Chat is the normal loop: `claudexor` with no arguments opens a REPL over a
thread. Read-only turns (ask/plan/audit, and orchestrate with the default
`suggest` autonomy) RESUME the routed
harness's own native CLI session (codex `exec resume`, claude `--resume`) —
plan first, then keep asking, in ONE conversation. Write (agent) turns run
IN-PLACE: a single-candidate turn mutates the thread's live execution tree
directly (the project for an `in_place` thread, or the thread's persistent git
worktree for an `isolated` thread) and resumes the native vendor session, so
the next turn sees the work. A race (`--n N` > 1) runs its candidates in
isolated throwaway envelopes and AUTO-ADOPTS the winner's patch into the live
tree. `session.rebound` is the typed disclosure for turns that CANNOT resume
the native session in place — isolated-envelope candidates (race lanes
included) and re-hosting onto a different harness; plain in-place turns
resume natively with no rebound event.

Examples:

```bash
claudexor                       # REPL: a thread of turns (read-only turns resume natively)
claudexor ask "2+2?"
claudexor ask "google the latest release notes" --web auto
claudexor explore "map this repo's auth and run storage"   # = audit --swarm
claudexor agent "fix the failing auth refresh test" --harness codex
claudexor best-of "fix add() in src/math.js and keep the patch minimal" --harness codex,claude --n 2
claudexor agent "repair the parser test" --attempts 3
claudexor agent "fix the bug and keep repairing until clean" --until-clean
claudexor plan "design a config-to-gates implementation"
claudexor audit "map artifact writers and secret risk"
claudexor orchestrate "ship the v2 parser refactor across this repo"
```

## Web, Tool Evidence, And Output Readiness

External web context is a typed run policy, separate from shell/network
sandboxing. The CLI-first contract is:

```bash
claudexor ask "google this library's current release" --web auto
claudexor ask "use cached web context only" --web cached
claudexor ask "force live search where supported" --web live
claudexor ask "answer from local/project context only" --web off
```

The policy values are `off | auto | cached | live`. `auto` allows web-capable
harness tools where supported and records whether the harness actually attempted
`WebSearch`/`WebFetch`. A run that attempts a web tool and gets a tool error
cannot be plain green success unless a later successful web result proves
recovery. Read-only Ask/Audit can fall back to another eligible route and emits
`route.fallback.*` events.

Run terminal state is separate from output readiness. Control API, CLI, and app
expose `outputReadyState` (`pending | finalizing | ready | diagnostic`),
`webEvidence`, tool errors, non-blocking tool warnings, budget, and artifact paths. A
finished answer/report/patch can be usable with warnings; failed required web
evidence, terminal harness errors, failed apply/verify steps, and failed required
gates remain blockers. `claudexor inspect
<run_id>` is the CLI projection of the same run detail the macOS app renders.

## Routing, Auth, And Secrets

Routing is `Pool + Primary + Portfolio`:

- selected harnesses are the eligible pool;
- `--primary-harness <id>` biases single-route modes and the first candidate;
- `--portfolio <id>` records the routing/budget portfolio, default
  `subscription-first`.

Reviewer selection is also explicit when needed. `--reviewer-panel` accepts an
ordered list of harness entries and preserves repeated harness ids, so one pass
can request multiple Cursor models without provider-family dedupe:

```bash
claudexor agent "fix the parser" --reviewer-panel "claude=claude-opus-4-8:max,cursor=gemini-3.1-pro,cursor=gemini-3.5-flash,cursor=gpt-5.5-extra-high"
```

Each entry is `harness[:effort]` or `harness[=model[:effort]]`; a trailing
`:low|medium|high|xhigh|max` suffix is parsed as effort, while other colons
remain part of the model id when a model is present.
Exact panels may intentionally contain several entries from the same provider,
for example a Cursor-only diagnostics pass, but a clean verified review/apply
gate still requires at least two distinct observed provider families. A
same-provider-only panel can run and produce findings, but it remains ungated
until another provider family participates.
Legacy `--reviewer-model` and `--reviewer-effort` remain per-provider defaults
for the automatic reviewer selector; an explicit panel is used verbatim and
fails loudly if any requested harness is unknown, unavailable, disabled,
fake-only, lacks review intent, or rejects an explicit model id that its adapter
can enumerate. When an adapter has no enumerable model producer, the requested
model must at least match the harness manifest's known-good model hints;
otherwise the panel fails loudly instead of silently forwarding an unverifiable
model to the native CLI. Use `claudexor models --harness <id>` to inspect the
current model ids for adapters that expose inventory.

In the chat surface this is sticky per thread: a thread remembers which harness
answers in chat (its primary) and the eligible pool Best-of competes over. The macOS
app sets them via `POST /v2/threads` / `PATCH /v2/threads/:id` and may override per turn
— the engine still owns all routing; the surface only sends the choice.

Harness chips in the macOS app are not decorative toggles: unavailable,
unauthenticated, degraded, or intent-incompatible harnesses are shown with the
reason and are gated out of launch.

Claudexor mirrors native harness auth where that route is readiness-proven; API
keys are fallback secret refs and live in the OS Keychain where available,
otherwise a `0600` file. `auto` is native-first for Codex, Claude, and Cursor in
both host and scoped/envelope runs; it reaches an API-key fallback only when the
native route is not ready (and, for Claude, no verified setup-token source is
ready). A typed auth-route disclosure makes that paid-route switch visible. Run
params, the daemon command journal, artifacts, summaries, patches, and PR text store
only refs/metadata, not raw secret values.
Subscription/native routes scrub provider API-key, token, and endpoint-override
environment variables unless a distinct stored API-key or Claude setup-token
route is selected.
Doctor reports each produced auth source as two separate facts: credential
`availability` (`available | unavailable | unknown`) and live `verification`
(`passed | failed | not_run`). Explicit `subscription` never runs or accepts an
API-key smoke, explicit `api_key` is never rescued by a native session, and
`auto` remains native-first. A missing/logged-out source is
`unavailable + not_run`; an indeterminate probe is `unknown + not_run`; source
material that is present but wrong or unusable is `available + failed`.

Native login stays vendor-owned: Claudexor launches the official CLI with an
absolute executable and structured argv, inherits its TTY, and removes provider
key/token variables from the child environment. The native-login path never
receives an OAuth callback, copies a credential file, or receives/stores vendor
session tokens. Codex owns a Claudexor-dedicated `CODEX_HOME` and is forced to
file credential storage there, so login cannot replace the operator's ordinary
Codex CLI/app Keychain session. Claude owns its config plus the macOS login
Keychain, and Cursor owns its Keychain-backed native state. Claudexor's separate API-key and Claude
setup-token routes remain explicit local-secret-store flows.
A zero vendor exit is only provisional; Claudexor then performs a fresh,
source-targeted native probe and an isolated same-harness capability smoke. The
smoke must answer an unpredictable challenge over the normal adapter stream
from the exact `vendor_native` / `native_session` route, with no tools, external
context, workspace mutation, or provider-key fallback. A timeout or crash is
`interrupted_unknown`, never success and never auto-replayed. This proves the
selected credential transport can answer; it does not prove a subscription
tier, entitlement, quota, or zero incremental cost.
The command routes follow the official [Codex auth](https://developers.openai.com/codex/auth/),
[Claude authentication](https://code.claude.com/docs/en/authentication), and
[Cursor CLI authentication](https://docs.cursor.com/en/cli/reference/authentication)
documentation.

```bash
claudexor auth status
claudexor auth login codex    # codex login
claudexor auth login claude   # claude auth login --claudeai
claudexor auth login cursor   # cursor-agent login
claudexor secrets set openai --from-env OPENAI_API_KEY
claudexor secrets list
claudexor secrets list --backend file   # force the 0600 file store (also: CLAUDEXOR_SECRETS_BACKEND=file)
claudexor settings show
claudexor settings set default_portfolio subscription-first
```

Secrets default to the OS Keychain (or a `0600` file). `--backend file` /
`CLAUDEXOR_SECRETS_BACKEND=file` forces the file store so a sandboxed run or test
never touches the real login Keychain; an invalid value fails loudly.

`auth status` prints both typed readiness axes. Manifest auth sources say only
what could be used; doctor source verification decides whether a route is
actually ready.

## Daemon And Control API

The optional daemon owns durable local command queueing over a Unix socket. A
create is acknowledged only after its checksummed global-journal frame reaches
`fsync`; `Idempotency-Key` binds retries to the original request. After a crash,
an accepted nonterminal command becomes `interrupted_unknown` and is never
auto-replayed. The
loopback HTTP/SSE control API is a thin viewport over the daemon and run files.
The canonical endpoint inventory lives in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §7 and is generated from source;
this README does not duplicate it.

`GET /healthz` is the sole unversioned route. Every product call uses `/v2`:
official clients negotiate `POST /v2/handshake`, send
`X-Claudexor-Protocol-Major: 2`, and can inspect the implemented contract at
`GET /v2/operations`. Missing/incompatible negotiation returns a typed `426`;
there are no v1 aliases.

Harness setup is server-owned. `/v2/setup/jobs` (create / status / reconcile /
cancel / extend) is the only supported setup surface. Native login uses a
bundled observable runner: 10-second launch watchdog, 15-minute user deadline,
explicit unlimited `+15 min` extensions, identity-fenced TERM/KILL cancellation,
and fresh post-exit capability verification. Before the detached runner may
spawn, the daemon journals and fsyncs the exact executable/argv digests and a
one-use permit; the runner's hash-bound result is journaled before verification.
Cancel is asynchronous and becomes terminal only after termination is proven.
Duplicate create returns the same active action, while a different active
mutating action refuses instead of being laundered into success.
A `termination_unconfirmed` fence clears only through the reconcile endpoint
after a fresh server-side probe proves the recorded process group empty.

The daemon's checksummed global journal is the only setup lifecycle authority.
Per-job `0700` directories contain operational runner handshake files only;
there is no `job.json`, `events.jsonl`, metadata snapshot, or imported v1
authority. Full job snapshots stream over SSE with opaque request-relative
cursor predecessors. Clients GET-resnapshot on every reconnect; malformed,
duplicate, regressive, dropped, or prematurely ended streams are visible
protocol errors. A capability smoke that was running at daemon restart becomes
`interrupted_unknown` and is not replayed. Vendor output stays in Terminal,
which remains open on the result until Return. Doctor verification runs
in-process inside the daemon (no shell PATH dependency). UI surfaces must not
invent setup commands or accept inline secrets.

Run events carry a monotonic per-run `seq`; `GET /v2/runs/:id` returns the
snapshot plus `lastSeq`, so clients subscribe to `GET /v2/runs/:id/events` with
`Last-Event-ID` for gap-free live state (snapshot-then-subscribe). Run detail
responses include `primaryOutput`, `timeline`, `budget`, `pendingInteractions`,
and `summary.route` projections. Web/tool evidence is projected from the
engine-owned `final/telemetry.yaml`. Clients should use those fields first
instead of guessing artifact paths or displaying fake zero spend/quota values.
`POST /v2/runs/:id/control` supports cancel for active daemon jobs.
Interactive harnesses (Claude Code) can ask typed questions mid-run: the run
parks as waiting_on_user, the macOS app or `claudexor follow` answers via the
interactions endpoint, and unanswered questions decline benignly after the
configurable timeout.

Runtime resilience is evidence-driven: adapters can emit typed transient
network/stream/timeout signals, the orchestrator retries them only within the
bounded user-global `runtime.transient_retry` policy, and reviewer panels use the
configurable `runtime.reviewer_timeout_ms` (default 10 minutes). Convergence that
keeps producing the same diff while a required gate still fails stops as
`stuck_no_progress` instead of burning attempts indefinitely.

Start it:

```bash
claudexor daemon start
claudexor daemon status --json
claudexor daemon logs
claudexor daemon stop
```

## Artifact Layout

Every project run creates files under `.claudexor/runs/<run_id>/`. App-launched
Ask without a project uses an empty synthetic cwd at
`~/.cache/claudexor/no-project` and writes artifacts to the user-level store
`~/.claudexor/runs/<run_id>/`:

```text
events.jsonl
context/task.yaml
context/context_pack.yaml?
attempts/a01/attempt.yaml
attempts/a01/patch.diff
reviews/a01.yaml
arbitration/decision.yaml
final/telemetry.yaml
final/patch.diff
final/work_product.yaml
final/summary.md
final/failure.yaml?
final/answer.md?
final/explore.md?
final/explore-findings.yaml?
final/omissions.md?
final/report.md?
final/plan.md?
final/orchestration.md?            # human-readable orchestration summary (orchestrate)
final/orchestration.yaml?          # the typed orchestration plan (orchestrate)
final/orchestration_progress.yaml? # per-step executor progress (auto_safe/auto_full)
context/context_error.md?
```

Files are the source of truth. Terminal output and UI rows are projections. The
macOS run detail screen surfaces `Outcome`, `Timeline`, and `Diagnostics`
directly from these artifacts/events, so successful answers and failed runs are
inspectable instead of disappearing into logs.

Project runs execute in isolated envelopes under
`.claudexor/workspaces/.../tree`; harness `cwd` is that envelope worktree.
Proven work product means a git diff in the envelope, a declared run artifact,
or an explicitly verified host side-effect. Absolute `/tmp/...` writes are host
side effects and do not count as project success. A project prompt asking for a
tmp file should resolve to project-local `tmp/...` or a run artifact unless a
future verified host-side-effect mode is explicitly selected.

## Integrations

Claudexor can be driven by other tools through CLI JSON on supported commands, the
local daemon/control API, MCP, and ACP. These surfaces are capability-gated;
integrations should not assume every subcommand has JSON output or every
harness supports live steering (see "Stability at 1.0").

The CLI accepts the same attachment contract as the control API for run modes:
use repeatable/comma-separated `--attach <path>` for files or `--image <path>` for
images. Vision routing remains capability-gated; a blind harness is rejected with
an actionable pre-flight reason instead of silently dropping the attachment.
Direct non-thread `POST /v2/runs` requests accept only non-empty absolute existing
file paths for attachments; inline base64 upload bytes are accepted through
thread/composer turns so they are sunk to scoped files before a daemon job is
queued.

Host integrations are managed by `claudexor plugin
install|status|doctor|repair|uninstall <cursor|claude|codex|opencode|all>`.
They install user-global host-native artifacts plus MCP wiring while keeping
Claudexor as the orchestration owner. Codex is registered in the personal plugin
marketplace and still requires enablement from Codex Plugins. MCP tools are
one-shot final-output calls, not live Claudexor thread parity.

You can ask an agent host with shell access to install the integration for
itself. Paste something like this into Cursor, Claude Code, Codex, or OpenCode:

```text
Install Claudexor's host integration for this app. First find the local
Claudexor CLI: prefer an existing `claudexor` command; otherwise, if this repo
is checked out at <REPO_ROOT> (the directory containing this README), use
`node <REPO_ROOT>/packages/cli/dist/cli.js`.

Run the matching command for this host:
- Claude Code: `claudexor plugin install claude`
- Codex: `claudexor plugin install codex`
- Cursor: `claudexor plugin install cursor`
- OpenCode: `claudexor plugin install opencode`

Then run `claudexor plugin status <host>` and
`claudexor plugin doctor <host>`. Do not overwrite unowned files. If the
installer reports a conflict, show me the exact message and stop.

After install: Claude Code/OpenCode may need a new session; Cursor may need a
reload or manual local-plugin enablement; Codex is only registered in the
personal marketplace, so tell me to open Codex Plugins and enable Claudexor
manually.
```

Once enabled, ask the host to use Claudexor for work where orchestration,
review, or evidence is useful. Examples:

```text
Use Claudexor to make a read-only plan for this refactor, then show me the
plan and the open questions before changing files.
```

```text
Use Claudexor best-of with 3 candidates for this bug fix, compare the attempts,
and apply only the winning patch if the review is clean.
```

```text
Use Claudexor doctor/status to check which harnesses are actually ready before
choosing a route. Do not assume a provider is usable just because a token exists.
```

```text
Use Claudexor audit on this repository and return the final report with concrete
file references. Keep it read-only.
```

See [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) for the current integration
matrix and limitations.

## Architecture

Important boundaries:

- `packages/schema` owns contracts and generated JSON Schema.
- `packages/harness-*` adapters translate native tool I/O into typed events.
- `packages/workspace` owns worktree envelopes and scoped harness homes.
- `packages/orchestrator` owns the five canonical mode pipelines (ask, plan,
  audit, agent, orchestrate) and their strategy flags (race width, attempt
  caps, until-clean, swarm, create).
- `packages/review`, `arbitration`, `synthesis`, and `budget` own selection and
  validation logic.
- CLI, daemon, control API, MCP, ACP, plugins, and macOS are thin surfaces.

Read next:

- [`CLAUDEXOR_BIBLE.md`](CLAUDEXOR_BIBLE.md) - product and engineering principles.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) - current runtime and package
  map.
- [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) - external integration
  surfaces.
- [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) - macOS UI/UX contract.
- [`docs/WHITEPAPER.md`](docs/WHITEPAPER.md) - public rationale and conceptual
  model.
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) - contributor workflow for
  changing Claudexor itself.
- [`docs/CHECKLISTS.md`](docs/CHECKLISTS.md) - human gates for docs, schema,
  release, visual QA, and security.
- [`apps/macos/README.md`](apps/macos/README.md) - macOS app notes.

## Development

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm schema:gen
git diff --exit-code packages/schema/generated
pnpm docs:check   # docs-truth gate: endpoints, mode ids, CLI flags vs source
pnpm knip         # dead exports/files gate
```

`pnpm release:verify` runs Node/schema checks, Swift tests/build, and local
app ZIP/DMG packaging for smoke. Final GitHub Release assets are built by
the `Release` GitHub Actions workflow from the pushed `v*` tag; do not upload
stale local `apps/macos/dist` artifacts.

There is no root `pnpm lint` script.

macOS:

```bash
cd apps/macos/ClaudexorKit && swift test
cd ../ClaudexorApp && swift build
```

## Stability at 1.0

What 1.0 means here, per surface:

- **Stable contracts** (semver-guarded from now on): the CLI verb/flag
  surface as declared by `claudexor help --json`; the CLI `--json` output
  keys on run paths (add-only); the control API endpoints and DTOs in
  `docs/reference/endpoints.json` + `packages/schema/generated/`
  (loopback + bearer token, add-only fields); the MCP tool set with their
  input/output schemas; run artifact layout under `.claudexor/runs/`
  (`final/`, `arbitration/`, `events.jsonl`).
- **Experimental** (may change in minors, disclosed in the CHANGELOG):
  the ACP surface, the `release check-name` verb, host-plugin file layout
  (regenerate with `claudexor plugin repair all`), the REPL slash-command
  set, and the macOS app's UI arrangement.
- **Never contracts**: engine internals (packages other than
  `@claudexor/cli` / `@claudexor/schema` are published for toolchain
  transparency, follow the lockstep version, and carry no separate semver
  promise), review prompts, and reviewer panel defaults.

## For External Agents

Claudexor is built to be DRIVEN by other agents. Machine-readable entry
points, in the order an agent should discover them:

1. `claudexor help --json` — the command catalog (verbs, flags, mutability,
   stability, recovery verbs).
2. `claudexor capabilities --json` — the live AgentCapabilityCatalog:
   doctor-backed harness status, model truth, the mutability matrix,
   run-control keys, and the run-apply-state vocabulary. Also served at
   `GET /v2/agent-capabilities` and by the MCP `claudexor_capabilities` tool.
3. `docs/reference/endpoints.json` — the control-API endpoint map with
   request/response schema names; field semantics live in the generated
   JSON Schemas under `packages/schema/generated/`.
4. `docs/AGENT_ONBOARDING.md` — the five-minute orientation: read-only vs
   mutating routes, the post-run decision tree (inspect / apply / decision),
   recovery tools, and when to hand a decision to the human.

Prompts are durable artifacts: a secret-like value inside a prompt is
hard-blocked with a typed error on every surface — store credentials with
`claudexor secrets set` and reference them instead.

## Privacy

Claudexor collects **no telemetry**: no analytics, no crash reporting, no
auto-update pings. The only outbound network traffic is what you configure —
the vendor harness CLIs and model APIs your runs use (plus the user-invoked
`claudexor release check-name`, which queries public package registries when
YOU run it). The `telemetry/` names you may see under `~/.claudexor/` and in
run artifacts are **local files only** (per-harness cost/latency averages and
per-run evidence); nothing is transmitted.

## Uninstall / where your data lives

Claudexor owns these locations:

- `~/.claudexor/` — global config (`config.yaml`), per-repo trust grants
  (`trust/`), the file-backend secret store (`secrets.json`, when the OS
  keychain is unavailable), daemon state (`daemon/`: token, socket, log, job
  and thread registries), local harness metrics (`telemetry/`), host-plugin
  ownership state (`plugins/`), and user-level runs for no-project asks.
- macOS Keychain items under the service name `claudexor` (secret values
  stored via `claudexor secrets set`) — delete them in Keychain Access if you
  remove the file tree.
- `~/Library/LaunchAgents/com.claudexor.claudexord.plist` — only if you opted
  into the launchd autostart.
- Per-project `.claudexor/` — run artifacts (`runs/`), and for isolated
  threads `workspaces/` **may hold unapplied work** (persistent worktrees).
  Apply or export anything you care about before deleting it.
- Host-plugin artifacts in vendor config trees — remove them with
  `claudexor plugin uninstall all` (ownership-aware; it only deletes
  Claudexor-owned files).

Uninstalling is: `claudexor plugin uninstall all`, `claudexor daemon stop`,
then delete the paths above (and npm/global install or the app bundle).

## Upgrading from 0.x

The config loader migrates forward automatically: retired keys are stripped
with a disclosure at load, unknown keys fail loudly, and old wire mode ids
hard-error with the canonical replacement named. After upgrading, run
`claudexor plugin repair all` so generated host-plugin files match the new
version, and restart the daemon (`claudexor daemon stop` — the next command
starts the new build).

## Version History

The current version is **v1.0.1** (the root `package.json` is the version
SSOT). The full release history lives in [`CHANGELOG.md`](CHANGELOG.md).

## License

[MIT](LICENSE) (c) 2026 joi-lab — inbound contributions are accepted under
the same license.
