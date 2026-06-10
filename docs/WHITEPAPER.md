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

## Harnesses Are Tools, Not Roles

A harness is an execution surface. A role is an intent: `explain`, `plan`,
`implement`, `repair`, `review`, `verify`, `compare`, `synthesize`, `arbitrate`,
or `audit`. Claudexor routes only when discovery, doctor, enabled intents,
capability profile, and access support all agree. Manifest auth source
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

Web policy is a harness capability (`native | tools | none` in the manifest).
A harness that cannot enforce the requested policy is excluded from routing;
explicitly selecting one fails loudly instead of silently downgrading. Claude
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

## Observability

Runs are append-only event streams plus artifacts. `events.jsonl` is canonical;
SSE streams hydrate/reconnect from it. Timeline and Diagnostics expose tool
calls, targets, permission policy, error summaries, harness/attempt ids,
fallback routes, first output, last event, budget observations, and artifact
paths.

Terminal state and output readiness are separate. A daemon job can be terminal
while the primary answer/report is still `finalizing`. `outputReadyState` is
`pending | finalizing | ready | diagnostic`, and clients must display it instead
of assuming terminal success means a loaded answer.

Setup jobs are also observable: queued/running/waiting/succeeded/failed/
cancelled, command preview, risk flags, started time, first output, latest
output, terminal result, retry count, doctor result, and log path.

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
sidebar, toolbar, sheets, and floating controls. Dense output, reports, code,
diffs, transcripts, tables, and diagnostics use solid surfaces. Dark theme uses
crisp graphite: lifted cards, clear strokes, strong text contrast, restrained
glow, and no muddy gray fill.

Outcome/report/plan surfaces render markdown with selectable text and solid code
blocks. Technical artifacts stay in Diagnostics. The UI must not transform
`context/task.yaml` or `events.jsonl` into a user plan.

## Review Discipline

Review gates must be evidence-backed. UI diffs require screenshot evidence.
Runtime/harness/auth/setup/observability/budget/orchestration changes require
schema-first updates, focused tests, regenerated JSON Schema, and public docs
alignment. Reviewer output that is empty, unauthenticated, parse-failed, or reads
the wrong tree is not a passed review.
