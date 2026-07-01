# Claudexor Bible

This file is the compact constitution for Claudexor. It is public product and
engineering doctrine, not private operator notes. If implementation, docs, UI,
or review feedback conflicts with this file, resolve the conflict explicitly and
update this file only when the product principle itself changes.

## 1. Claudexor Is CLI-First

Claudexor is a local-first control plane over external AI coding harnesses. The
source of truth is the engine: `packages/schema`, CLI, daemon, control API,
orchestrator, run artifacts, and project/user config. macOS, MCP, ACP, plugins,
and future surfaces are views/controllers over that engine. They must not create
app-only business logic, fake delivery state, or private run semantics.

## 2. Harnesses Are Not Roles

Codex, Claude Code, Cursor, OpenCode, raw APIs, and future adapters are
harnesses. Roles are intents: `explain`, `plan`, `implement`, `repair`,
`review`, `verify`, `compare`, `synthesize`, `arbitrate`, and `audit`. A
harness can play an intent only when discovery + doctor + capability gating say
it can. Missing, unauthenticated, degraded, or intent-incompatible harnesses are
visible but not silently selectable.

## 3. Schema Is The Contract

Data shapes live in `packages/schema`. Change schemas first, regenerate JSON
Schema, then update TypeScript, Swift, docs, tests, and surfaces. Do not fork
contracts in UI code, CLI parsing, adapter output, or docs. Unknown modes,
unknown portfolios, invalid access profiles, malformed artifacts, stale reviews,
and unavailable harnesses fail loudly.

## 4. Modes Are Canonical And Breaking

The canonical modes are `ask`, `plan`, `audit`, `agent`, and `orchestrate`
(five intents-on-a-thread). Engine strategies are FLAGS on a mode, never modes
of their own: best-of-N (`--n`), capped repair (`--attempts`), repair-to-clean
(`--until-clean`), research swarm (`audit --swarm`), and create-from-scratch
(`agent --create`). In the v0.10 chat-first cockpit `Agent` is the default app
composer mode — the harness decides whether to answer or edit the live tree (like
Codex / Cursor / Claude Code); a no-project thread falls back to read-only `Ask`,
and `Ask` / `Plan` / `Audit` stay one click away in the intent menu. `Agent` is
also the default `claudexor run` route. `Orchestrate` is the brain — an
intent routed like reviewers, never a privileged harness. A thread is the
Claudexor-owned conversation (runs are its turns); the vendor CLI session is a
re-hostable cache that later turns resume natively. Old ids (including the
former strategy modes) are not compatibility aliases unless explicitly
reintroduced in schema and docs.

## 5. Evidence Beats Summaries

Every hard claim needs evidence: a file, diff, command, log line, event, doctor
report, run artifact, or source reference. Diffs come from git in the isolated
worktree or live in-place target, not from model edit narration. Reviews are not
trusted unless reviewer output is parseable, route proof is observed, reviewer
telemetry is persisted, and the reviewer read the candidate evidence files rather
than a giant prompt-only diff.

Tool success is evidence, not prose. A `tool_result.is_error === true` is a hard
warning that blocks a green verified claim unless later verified recovery exists,
but it does not discard a produced deliverable by itself. The engine separates
terminal state from tool hygiene: a completed answer/report/patch may succeed
with warnings, while failed web evidence, terminal harness errors, failed apply/
verify steps, or required gates still block. Web answers are web-backed only when
`WebSearch`/`WebFetch` or equivalent evidence was observed; a memory answer after
a failed web tool is partial/unverified.

Transient infrastructure failures are typed adapter evidence, not guessed from
model prose. Adapters may mark network/stream/timeout failures as transient; the
orchestrator may spend a bounded retry budget only for typed transient failures
with no produced deliverable. A repeated identical diff against a still-failing
required gate is reported honestly as `stuck_no_progress`, never success.

Interactive FLOW-CONTROL tools are not work tools. A declined or timed-out
`AskUserQuestion`/`ExitPlanMode` result is the documented end of an interaction
(recovery-by-same-tool is impossible by construction), so adapters translate it
into a benign timeline event — never a blocking tool error. An ANSWERED
interaction is delivered through the typed interaction contract
(`interaction.requested`/`answered`/`timeout` events) and the model's
continuation is ordinary evidence. Real work-tool errors remain visible warning
evidence and can block only when they invalidate the run's required contract.

No regex governance: risk, permissions, web-required detection, tool success,
winners, and tests-passed must be determined by typed contracts, settings,
events, gates, or reviewer evidence, not ad hoc string matching over model text.
Protected gate/test paths are contract evidence: when a deterministic gate is
configured, edits to the protected test/gate surface produce deterministic policy
findings before any model can claim the run is clean. Explicit test-authoring
work can approve the relevant protected globs through a typed run field (CLI:
`--allow-protected-path`); this narrows the gate/test-path policy only and never
bypasses built-in critical/security human gates.

## 6. Secrets Never Become Artifacts

Native harness auth is preferred only when doctor proves that route for the
active context; API keys are fallback secret refs stored in Keychain or a `0600`
store. Cursor keeps normal `auto` runs native-first and may prefer the
smoke-proven API-key route only for scoped/envelope `auto` runs, while still
honoring explicit `subscription`; that paid-route choice is typed-disclosed when
a native route also exists. Raw secrets must not appear in run params,
`jobs.json`, task contracts, events, summaries, patches, PR text, logs, or docs.
Scoped harness homes/config dirs stay outside the mutation worktree.

## 7. Project Context Is Explicit

Claudexor must distinguish the Claudexor product repo, the user-selected target
project, temporary workspaces, and harness native homes. The app must show which
project a run will use. `Ask` may answer general questions without a project,
using a non-sensitive synthetic cwd and storing artifacts in the user-level
Claudexor store. Project-aware modes require an
explicit project (chosen in the composer's ProjectChip) and must not silently
fall back to a process cwd.

Ordinary project runs (and Race candidates) execute in isolated envelopes under
`.claudexor/workspaces/.../tree`, with the harness cwd at the envelope worktree.
v0.10 chat thread WRITE turns instead run IN-PLACE in the thread's explicit
execution tree — the live project for an `in_place` thread, or the thread's
persistent worktree for an `isolated` thread — and the surface must disclose which
applies. Either way, absolute host paths such as `/tmp/...` are not project diffs
and do not prove project success. Project tmp requests default to project-local
`tmp/...` or run artifacts unless the user explicitly selects a verified
host-side-effect mode.

## 8. Spec-Driven Work Is First-Class

When a task is ambiguous, Claudexor should move toward a frozen SpecPack: plan,
ask clarifying questions, record user answers, freeze acceptance criteria and
non-goals, then run against that contract. The Spec Interview is plan/draft
owned, not a permanent top-level app identity.

## 9. macOS UX Must Be Native, Honest, And Familiar

v0.10 is CHAT-FIRST: ONE screen — a thread list, the conversation, and a
persistent composer. Users of Claude Code, Cursor, and Codex should feel at
home: you just type; the first message starts a thread; turns run in-place so
the next turn sees the work; a run's detail (diff/timeline/review) opens in the
trailing inspector, not a separate kitchen-sink of tabs. The composer is always
live — an empty chat is never a silent no-op. Every turn shows its HONEST
outcome: a plan says "no files changed" and offers to implement it; a patch
shows its diffstat; a race shows the adopted winner. Working progress
(reasoning + tool calls) streams into the turn as it happens.

The window is matte glass — the desktop shows faintly through it (behind-window
material; Reduce Transparency falls back to a solid backdrop). There is NO
always-animating backdrop and NO perpetual pulsing: idle means zero animation
(the v0.9 60fps mesh + repeating symbol effects were the real cause of the low
frame rate). Liquid Glass belongs to navigation/chrome/the composer; content
cards use one frosted material with a single soft shadow; code, diffs,
transcripts, and dense text keep solid high-contrast surfaces. Money is typed,
never a slider. Decorative UI that obscures state, glass-behind-code, and janky
transitions are bugs.

## 10. Settings Are Preferences, Not Brochures

macOS Settings owns app preferences and engine defaults exposed by the control
API: appearance, routing, primary harness, model hints, env inheritance, budget
caps, auth status, and secret refs. The Settings scene also hosts live Budget and
the Harness Doctor (tabs). Project selection is NOT a Settings preference — it
lives only in the chat composer's ProjectChip (MRU recents + Browse…). Review
verdicts and run diagnostics live ON the turn and in the run inspector — there is
no separate Review Queue screen in the v0.10 chat-first cockpit.

## 11. Delivery Is Server-Owned

Inspect/apply/check use control-api endpoints and run artifacts. The UI must not
invent local accept/rebut/apply state. Read-only modes do not expose patch apply
controls. Apply is allowed only for successful runs with a successful decision
record and a patch WorkProduct for the original verified repo root — with one
typed, server-owned exception: an operator decision (`POST /runs/:id/decision`,
`accept_risk`/`override_needs_human`) persists an auditable, patch-hash-bound
record that unblocks apply for a `blocked` run; a mutated patch invalidates the
override. The human decision is never client-faked state.

Terminal run state and output readiness are separate. A terminal daemon job can
be `succeeded`, `blocked`, `failed`, or `not_converged` while
`outputReadyState` is still `pending`, `finalizing`, `ready`, or `diagnostic`.
CLI and UI must show that distinction instead of treating terminal state as a
loaded answer artifact.

## 12. Keep The Codebase Small And Direct

Prefer simple, typed, local solutions over speculative abstractions. Keep
surfaces thin, adapters translational, and orchestration centralized. Add an
abstraction only when it removes real duplication or captures an established
boundary. Avoid overengineering, hidden state, silent fallback, and broad
refactors unrelated to the user-visible problem. Follow SSOT, DRY, and SOLID as
pragmatic engineering constraints: one owner per contract, no duplicated
business rules across surfaces, and no config path that lets a project self-grant
sensitive powers.

Dead code is deleted, not allowlisted: a schema field ships with a real
producer and consumer in the same change (staged-field rule), unused exports
fail CI (`pnpm knip`), and adapter stream parsing is pinned by recorded
fixtures with a conformance parity test. Docs claims about endpoints, mode
ids, and CLI flags are checked against the source by the docs-truth gate, and
release tags additionally pass an external triad + scope review gate
(`docs/CHECKLISTS.md` → Release).

## 13. Documentation Must Stay Current

Public docs have separate jobs and must not be mixed together:

- `README.md` is the product entrypoint and detailed quickstart.
- `CLAUDEXOR_BIBLE.md` is this compact constitution.
- `docs/ARCHITECTURE.md` is the current runtime, package, artifact, and control
  API map.
- `docs/INTEGRATIONS.md` describes current external integration surfaces and
  beta limitations.
- `docs/DESIGN_SYSTEM.md` is the macOS UI/UX contract.
- `docs/DEVELOPMENT.md` is for contributors changing Claudexor itself.
- `docs/CHECKLISTS.md` holds human gates for docs, schema, release, visual QA,
  and security.
- App READMEs cover app-specific build and packaging notes.

Update the relevant docs whenever behavior changes. Public docs must stay free
of raw planning packets, review transcripts, local operator notes, local paths,
secrets, and one-off release scratch unless the user explicitly asks to publish a
sanitized artifact.
