# Claudexor Whitepaper

Claudexor is a local-first control plane for AI coding harnesses. It does not
try to become another model UI or a SaaS broker. It coordinates native harnesses
such as Codex CLI, Claude Code, Cursor CLI, OpenCode, raw API adapters, and
future tools through one typed engine, then exposes that engine through CLI,
daemon/control API, MCP/ACP, and the macOS app.

The product principle is CLI-first transparency: the macOS app is a facade over
Control API state, not a separate source of semantics. If a user experience
needs better permissions, streaming, output readiness, budget truth, tool
diagnostics, setup status, or harness settings, the contract belongs first in
schema/orchestrator/control API/CLI and only then in UI.

## Chat/Session-First (v0.9)

The conversation is the primary object. A Thread is the Claudexor-owned
conversation; runs are its turns; the vendor CLI session is a re-hostable cache.
Read-only turns (ask/plan/audit/orchestrate) resume each routed harness's own
native session (codex `exec resume`, claude `--resume`) so "plan, then
continue" is one conversation. Write (agent) turns execute in fresh isolated
envelopes where a native session is not portable — the engine emits a typed
`session.rebound` disclosure and continuity rides on the thread prompt plus
repo state. Modes collapsed to five intents (`ask`, `plan`, `audit`, `agent`,
`orchestrate`); engine strategies (race width, attempt caps, repair-to-clean,
research swarm, create-from-scratch) are flags on a mode, never modes.

Auth is subscription-first and honest: native codex/claude sessions are seeded
into envelopes so a Max/Pro user with NO API key is fully routable; explicit
`subscription`/`api_key` preferences fall back with a typed
`route.fallback.auth_switched` disclosure, never silently. A blocked
NEEDS_HUMAN run is unblocked only through a typed, audited, patch-hash-bound
operator decision held by the server; the `orchestrate` brain is an intent
routed like reviewers that produces a typed tool-belt plan, not a privileged
harness.

## Harnesses Are Tools, Not Roles

A harness is an execution surface. A role is an intent: `explain`, `plan`,
`implement`, `repair`, `review`, `verify`, `compare`, `synthesize`, `arbitrate`,
`audit`, or `orchestrate`. Claudexor routes only when discovery, doctor, enabled
intents, capability profile, and access support all agree. Manifest auth source
availability is not readiness; isolated smoke and doctor checks decide whether a
harness is routable.

Adapters translate native I/O into normalized events. They do not pick winners,
manage budgets, decide policy, or claim success. Orchestration, evidence,
review, budget, and delivery remain in the control plane.

## Evidence Model

Claudexor treats evidence as stronger than summaries. Work product is proven by
git diff in an isolated envelope, declared run artifacts, deterministic gates,
reviewer artifacts, event logs, budget observations, and verified side effects.
Model prose is useful context but not proof.

Tool lifecycle is part of evidence. A `tool_result.is_error === true` is a hard
warning and blocks claimed success unless a later successful recovery is
observed. Claudexor preserves redacted tool error detail so Timeline,
Diagnostics, CLI inspect, and review gates can explain what failed.

No regex governance: risk, permissions, web-required detection, tool success,
winners, and tests-passed are not inferred from ad hoc string matching over final
answers. They come from typed contracts, settings, normalized events, gates,
artifacts, and reviewer evidence.

## Web And External Context

External web context is a typed policy: `off | auto | cached | live`. It is
separate from shell/network sandboxing.

- `off`: do not allow web tools where the adapter can enforce that.
- `auto`: allow web-capable tools where supported and let the harness decide
  whether the task needs them; if a web tool is attempted and fails, the run is
  not web-backed.
- `cached`: request cached web context where supported.
- `live`: request live web search where supported.

Web policy is a harness capability (`native | tools | uncontrolled | none` in
the manifest). `uncontrolled` marks harnesses that can reach the web but expose
no enforceable switch — they are excluded from both `off` (cannot be enforced)
and web-required runs (cannot produce evidence); `none` marks harnesses with no
web at all, which trivially satisfy `off`. A harness that cannot enforce the
requested policy is excluded from routing; explicitly selecting one fails
loudly instead of silently downgrading. Claude
Code exposes permissioned `WebSearch` and `WebFetch` tools and native
allow/deny controls such as `--allowedTools` and `--disallowedTools` — it has
no cached web index, so a `cached` request executes as `live` and that upgrade
is disclosed (`policy.web.upgraded` event, effective mode in telemetry). Codex
exposes web search modes separately from command network access. Claudexor
maps its typed policy onto those native mechanisms and records observed web
evidence in the engine-owned `final/telemetry.yaml`. A final answer is labeled
by the recorded evidence status (`none | attempted | satisfied | failed |
unverified`), with requested vs effective web mode shown when they differ.

When a read-only task attempts web and the tool fails, Claudexor tries another
eligible route if available and emits `route.fallback.*` events. If no fallback
satisfies the policy, the run becomes `blocked` with partial output marked
unverified.

Known gap (deferred to a future release): under `auto`, "the harness attempted
web" is treated as the intent signal. Claudexor does not yet run a separate
intent resolver that decides a task NEEDED web when the harness never tried;
a web-required outcome is only enforced for explicit `cached`/`live` policies.

## Workspace And Tmp Semantics

Project runs do not execute directly in the live project by default. They run in
isolated envelopes under `.claudexor/workspaces/.../tree`, and the harness `cwd`
is the envelope worktree. Diffs come from git in that worktree.

Absolute `/tmp/...` writes are host side effects, not project diffs. A project
prompt asking for a tmp file defaults to project-local `tmp/...` or a run
artifact. A true host `/tmp` write requires an explicit verified host-side-effect
mode before it can count as success.

Scoped harness homes/config directories stay outside the worktree so auth files,
plugin downloads, sqlite logs, and transcripts are not captured in patches.

Write-access modes need a git boundary for worktree isolation and honest
diffs. A project folder that is not a git repository is initialized
automatically instead of refused: `.claudexor/` is seeded into `.gitignore`
first, then `git init` plus a deterministic Claudexor-authored baseline commit
make diffs truthful from the very first run. The mutation is announced in the
run timeline (`project.git.initialized`) — never silent.

## Observability

Runs are append-only event streams plus artifacts. `events.jsonl` is canonical;
every event carries a monotonic per-run `seq` stamped at emit time. Live
clients follow a snapshot-then-subscribe contract: fetch the run detail (whose
`lastSeq` fences everything the snapshot already reflects), then subscribe to
the per-run SSE stream from that cursor (`Last-Event-ID`); reconnects resume
without gaps or duplicates instead of replaying or guessing. A global
live-only `/events` multiplex keeps run lists fresh; it is explicitly not
gap-free, so clients re-snapshot the list after a drop. Timeline and
Diagnostics expose tool calls, targets, permission policy, error summaries,
harness/attempt ids, fallback routes, first output, last event, budget
observations, and artifact paths.

Terminal state and output readiness are separate. A daemon job can be terminal
while the primary answer/report is still `finalizing`. `outputReadyState` is
`pending | finalizing | ready | diagnostic`, and clients must display it instead
of assuming terminal success means a loaded answer.

Interactive runs are part of the same event contract. When a harness raises a
flow-control question (e.g. Claude's `AskUserQuestion` over its bidirectional
control protocol), the run emits `interaction.requested`, surfaces the typed
question set as a pending interaction with a `waiting_on_user` state, and
resumes on a typed answer (`interaction.answered`) or a benign decline after a
configurable timeout (`interaction.timeout`). Answers ride the control plane
(API/CLI/app), never an inferred prose channel.

Routing claims are evidence, not configuration echoes: run telemetry records
the model the harness stream actually disclosed (`observed_model`), and UI
route-proof badges key off that observation, not the requested route.

Setup jobs are also observable: queued/running/waiting/succeeded/failed/
cancelled, command preview, risk flags, started time, first output, latest
output, terminal result, retry count, doctor result, and log path. Doctor and
key-verification phases run in-process inside the daemon (no shell-out to a
CLI that may not be on PATH), so a missing binary cannot masquerade as a
failed key.

## Budget And Settings

Budget truth is part of trust. Claudexor distinguishes exact native cost from
estimated token-derived cost and keeps unknown spend unknown. It does not render
missing data as `$0`.

Harness settings use a `Profiles + Advanced` model. Global config can carry
per-harness model, effort, max turns/rounds, budget, tool allow/deny lists,
fallback model, web policy, and native advanced options. Unsupported options
must render disabled with reasons in UI and remain visible in CLI/API state.

## macOS Design

The app is a native projection over the engine. Liquid Glass belongs on chrome:
sidebar, toolbar, sheets, and floating controls. Ordinary content cards float
on frosted system materials — material fill plus tint veil, a top-lit hairline,
and a scheme-aware shadow — in both themes (never `glassEffect` lensing over
content). Code, diffs, transcripts, tables, and any dense small text keep
solid, high-contrast surfaces, and Reduce Transparency falls back to solid
raised fills. Dark theme stays crisp graphite: clear strokes, strong text
contrast, restrained glow, and no muddy gray fill.

Outcome/report/plan surfaces render markdown with selectable text and solid code
blocks. Technical artifacts stay in Diagnostics. The UI must not transform
`context/task.yaml` or `events.jsonl` into a user plan.

## Review Discipline

Review gates must be evidence-backed. UI diffs require screenshot evidence.
Runtime/harness/auth/setup/observability/budget/orchestration changes require
schema-first updates, focused tests, regenerated JSON Schema, and public docs
alignment. Reviewer output that is empty, unauthenticated, parse-failed, or reads
the wrong tree is not a passed review.
