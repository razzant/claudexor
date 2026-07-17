# Claudexor

Claudexor is a local-first control plane for the AI coding agents you already
pay for. It runs Codex CLI, Claude Code, Cursor CLI, OpenCode, and raw API
adapters behind one typed interface: a chat of turns where read-only questions
resume the vendor's own native session, write turns land as inspectable
patches, races pit harnesses against each other with cross-family review, and
every claim — cost, quota, web evidence, auth route — is a typed fact you can
audit, never a vibe.

Compared to driving a bare Codex or Claude Code session, Claudexor adds the
layer the vendors do not ship: best-of-N races with independent reviewers and
arbitration; honest budget/quota accounting (unknown cost is never `$0`);
deterministic gates and protected paths; and — since 2.1 — **credential
profiles**: several Claude/Codex subscriptions registered side by side, each
with its own isolated login and live subscription-quota tracking, with an
opt-in policy that rotates a spent account out of the way on typed vendor
limits only. Everything runs on your machine, files are the source of truth,
and there is no telemetry.

Current status: **v2.1**. See "Stability at 2.0" below for what is a stable
contract and what remains experimental; retired verbs and mode ids hard-error
with the new spelling instead of silently aliasing.

- [Prerequisites](#prerequisites)
- [Install](#install)
- [Quickstart](#quickstart)
- [Modes](#modes)
- [Credential Profiles And Quota](#credential-profiles-and-quota)
- [Web, Budgets, And Gates](#web-budgets-and-gates)
- [Routing, Auth, And Secrets](#routing-auth-and-secrets)
- [Daemon And Control API](#daemon-and-control-api)
- [Artifact Layout](#artifact-layout)
- [Integrations](#integrations)
- [Architecture](#architecture)
- [Development](#development)
- [Stability at 2.0](#stability-at-20)
- [For External Agents](#for-external-agents)
- [Privacy](#privacy)
- [Uninstall / where your data lives](#uninstall--where-your-data-lives)

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

## Credential Profiles And Quota

A credential profile is an ADDITIVE identity for one harness beyond its
default login: register several Claude or Codex subscriptions side by side,
each in its own isolated vendor config dir (the default `~/.claude` / native
codex home is never touched), or as namespaced secret-store keys
(`anthropic:work`, `openai:acc2`). Profiles are durable non-secret entries in
the global config's `credential_profiles`; secret material stays in the vendor
dir or the secret store.

```bash
claudexor profiles                         # registry + per-profile doctor readiness
claudexor profiles add claude work         # register a config-dir login profile
claudexor profiles login claude work       # the vendor's own login, scoped to the profile dir
claudexor secrets set claude_oauth:work --from-env TOKEN_VAR
claudexor agent "fix the parser" --profile work   # explicit per-run selection
```

In the macOS app the composer's "⋯" options panel has an **Account** picker
(the sticky per-thread profile) and a **Manage accounts…** sheet that lists
every registered account with its readiness and walks you through adding a new
subscription (register, then the interactive vendor login in Terminal — vendor
OAuth needs your own browser). Selection is turn > thread-sticky > engine
default, and an explicit profile is STRICT — exactly its transport or a typed
refusal, never a silent fallback.
Vendor-session resume never crosses profiles. Subscription quota is tracked
per profile from the vendor's own `oauth/usage` endpoint (proactive
five-hour/seven-day/per-model percentages in the app's quota footer, one chip
per profile), and each harness may declare a typed `profile_policy`
(`limit_action: fail|ask|rotate`): rotation is opt-in and fires ONLY on typed
vendor-limit signals or a proactive headroom breach — never on ordinary
network errors — with full provenance on the run record. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §5 for the complete contract.

## Web, Budgets, And Gates

External web context is a typed run policy (`--web off|auto|cached|live`),
separate from shell/network sandboxing; a run that attempted a web tool and
failed cannot be plain green success without a proven recovery. Run terminal
state is separate from output readiness (`outputReadyState`), so a finished
answer with warnings stays usable while failed required evidence blocks.
Paid budgets are explicit (`--max-usd N`; zero is a real zero-cash cap) and
unknown cost is never reported as `$0` — a finite run can end
`cost_unverifiable` or `exhausted_overshoot`. Deterministic gates use exact
argv (`--test '["pnpm","test"]'`), and externally-granted test commands are
invalidated when the config, argv, executable, script bytes, project, or
access profile changes. The full semantics live in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Routing, Auth, And Secrets

Routing is `Pool + Primary + Routing Goal`: selected harnesses are the
eligible pool, `--primary-harness <id>` biases single-route modes, and
`--routing-goal auto|quality|economy` picks the pacing. In chat this is sticky
per thread — the thread remembers its primary, pool, and (since 2.1) its
credential profile; the engine owns routing, surfaces only send the choice.
Reviewer panels are explicit when needed (`--reviewer-panel
"claude=claude-opus-4-8:max,cursor=gemini-3.5-flash"`); a clean verified
review/apply gate requires at least two distinct observed provider families.

Native harness auth is preferred where readiness-proven; API keys are fallback
secret refs in the v2-owned `0600` file store. `auto` is native-first, an
explicit route never falls back, and every effective route is a typed
disclosure — doctor reports credential `availability` and live `verification`
as separate facts, and a zero vendor exit is only provisional until a fresh
targeted probe plus an isolated capability smoke prove the exact selected
transport. Native login stays vendor-owned (official CLI, structured argv,
scrubbed env; Claudexor never sees or copies vendor tokens). The deep
semantics live in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §5.

```bash
claudexor auth status
claudexor auth login codex    # codex login
claudexor auth login claude   # claude auth login --claudeai
claudexor auth login cursor   # cursor-agent login
claudexor secrets set openai --from-env OPENAI_API_KEY
claudexor secrets list
claudexor settings show
claudexor settings set routing_goal auto
claudexor settings set paid_fallback when_unavailable
claudexor quota --refresh --json
```

## Daemon And Control API

The managed daemon is the mandatory runtime authority and normally auto-starts
when a product command needs it: durable fsync-acknowledged command queueing
over a Unix socket, idempotency-key retry binding, and a loopback HTTP/SSE
control API as a thin viewport (`/v2` only; `POST /v2/handshake` negotiation;
snapshot-then-subscribe run events). Harness setup/login is server-owned
through observable setup jobs with typed phases, deadlines, and post-exit
capability verification. The canonical endpoint inventory lives in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §7 and is generated from
source; this README does not duplicate it.

```bash
claudexor daemon start
claudexor daemon status --json
claudexor daemon logs
claudexor daemon stop
```

## Artifact Layout

Every project run creates files under the external per-project namespace
`~/.claudexor/v2/projects/<project-sha256>/runs/<run_id>/`; the repository's
`.claudexor/` directory remains user-owned versioned config. App-launched Ask
without a project uses an empty synthetic cwd at
`~/.cache/claudexor/no-project` and writes artifacts to
`~/.claudexor/v2/runs/<run_id>/`:

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
final/orchestration_delivery_receipt_N.yaml? # immutable mutating-step receipt
context/context_error.md?
```

Files are the source of truth. Terminal output and UI rows are projections. The
macOS run detail screen surfaces `Outcome`, `Timeline`, and `Diagnostics`
directly from these artifacts/events, so successful answers and failed runs are
inspectable instead of disappearing into logs.

Project runs execute in isolated envelopes under the same external project
namespace at `~/.claudexor/v2/projects/<project-sha256>/workspaces/.../tree`;
harness `cwd` is that envelope worktree.
Proven work product means a git diff in the envelope, a declared run artifact,
or an explicitly verified host side-effect. Absolute `/tmp/...` writes are host
side effects and do not count as project success. A project prompt asking for a
tmp file should resolve to project-local `tmp/...` or a run artifact unless a
future verified host-side-effect mode is explicitly selected.

## Integrations

Claudexor can be driven by other tools through CLI JSON on supported commands, the
local daemon/control API, MCP, and ACP. These surfaces are capability-gated;
integrations should not assume every subcommand has JSON output or every
harness supports live steering (see "Stability at 2.0").

The CLI accepts repeatable/comma-separated `--attach <path>` or `--image <path>`
and immediately streams each regular, non-symlink file through `/v2/uploads`.
Finalize returns an immutable resource ID; run and turn requests accept only those
IDs, never local paths or base64. Every selected harness must declare a finite
MIME, byte/count limit, and native transport for every mandatory attachment or
preflight refuses the whole pool. Adapters verify the finalized digest immediately
before building the vendor payload.

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

The explicit Claude install also enables the official subscription-quota
status-line source. If `~/.claude/settings.json` already has a `statusLine`
command, Claudexor composes with it and restores it on uninstall; later user
drift is refused rather than overwritten. Only the documented five-hour and
seven-day usage/reset fields are retained in Claudexor's v2 data root.

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
app ZIP/DMG packaging for smoke. Final GitHub Release assets are built by the
`Release` GitHub Actions workflow in `candidate` mode for an exact full SHA,
then in `publish` mode for the reviewed annotated tag. Do not upload stale
local `apps/macos/dist` artifacts.

There is no root `pnpm lint` script.

macOS:

```bash
cd apps/macos/ClaudexorKit && swift test
cd ../ClaudexorApp && swift build
```

## Stability at 2.0

What stability means in the clean v2 contract, per surface:

- **Stable contracts** (semver-guarded from now on): the CLI verb/flag
  surface as declared by `claudexor help --json`; the CLI `--json` output
  keys on run paths (add-only); the control API endpoints and DTOs in
  `docs/reference/endpoints.json` + `packages/schema/generated/`
  (loopback + bearer token, add-only fields); the MCP tool set with their
  input/output schemas; external run artifact layout under
  `~/.claudexor/v2/projects/<project-sha256>/runs/`
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
YOU run it). The `telemetry/` names you may see under `~/.claudexor/v2/` and in
run artifacts are **local files only** (per-harness cost/latency averages and
per-run evidence); nothing is transmitted.

## Uninstall / where your data lives

Claudexor owns these locations:

- `~/.claudexor/v2/` — v2 global config (`config.yaml`), per-repo trust grants
  (`trust/`), the file-only secret store (`secrets.json`), daemon global journal
  and process state (`daemon/`: token, socket, log), local harness metrics (`telemetry/`), host-plugin
  ownership state (`plugins/`), and user-level runs for no-project asks.
- Existing v1 files directly under `~/.claudexor/` are legacy user bytes. v2
  neither imports nor mutates them.
- `~/Library/LaunchAgents/com.claudexor.claudexord.plist` — only if you opted
  into the launchd autostart.
- `~/.claudexor/v2/projects/<project-sha256>/` — daemon-owned project journals,
  run artifacts, and isolated-thread worktrees. Isolated worktrees may hold
  unapplied work; apply or export it before removing this external namespace.
- A repository's `.claudexor/` directory is user-owned versioned configuration.
  Claudexor does not create, rewrite, or remove it during uninstall.
- Host-plugin artifacts in vendor config trees — remove them with
  `claudexor plugin uninstall all` (ownership-aware; it only deletes
  Claudexor-owned files).

Uninstalling is: `claudexor plugin uninstall all`, `claudexor daemon stop`,
then remove the daemon-owned paths above (and npm/global install or the app
bundle). Do not delete a repository's `.claudexor/` directory as part of the
product uninstall.

## Upgrading from 0.x

Version 2 is a clean breaking reset: it does not import or mutate v1 project,
trust, secret, run, or thread state. Retired config keys and old wire mode ids
hard-error instead of being migrated or aliased. Keep any v1 state you may
need separately. After upgrading, run
`claudexor plugin repair all` so generated host-plugin files match the new
version, and restart the daemon (`claudexor daemon stop` — the next command
starts the new build).

## Version History

The root `package.json` is the version SSOT. The full release history lives in
[`CHANGELOG.md`](CHANGELOG.md).

## License

[MIT](LICENSE) (c) 2026 joi-lab — inbound contributions are accepted under
the same license.
