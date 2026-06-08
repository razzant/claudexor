# Claudex Bible

This file is the compact constitution for Claudex. It is public product and
engineering doctrine, not private operator notes. If implementation, docs, UI,
or review feedback conflicts with this file, resolve the conflict explicitly and
update this file only when the product principle itself changes.

## 1. Claudex Is CLI-First

Claudex is a local-first control plane over external AI coding harnesses. The
source of truth is the engine: `packages/schema`, CLI, daemon, control API,
orchestrator, run artifacts, and project/user config. macOS, MCP, ACP, plugins,
and future surfaces are views/controllers over that engine. They must not create
app-only business logic, fake delivery state, or private run semantics.

## 2. Harnesses Are Not Roles

Codex, Claude Code, Cursor, OpenCode, raw APIs, and future adapters are
harnesses. Roles are intents: `explain`, `plan`, `implement`, `repair`,
`review`, `verify`, `compare`, `synthesize`, `arbitrate`, `audit`, and
`benchmark`. A harness can play an intent only when discovery + doctor +
capability gating say it can. Missing, unauthenticated, degraded, or
intent-incompatible harnesses are visible but not silently selectable.

## 3. Schema Is The Contract

Data shapes live in `packages/schema`. Change schemas first, regenerate JSON
Schema, then update TypeScript, Swift, docs, tests, and surfaces. Do not fork
contracts in UI code, CLI parsing, adapter output, or docs. Unknown modes,
unknown portfolios, invalid access profiles, malformed artifacts, stale reviews,
and unavailable harnesses fail loudly.

## 4. Modes Are Canonical And Breaking

The canonical modes are `ask`, `explore`, `agent`, `best_of_n`, `max_attempts`,
`until_clean`, `plan`, `create`, `readonly_audit`, and `benchmark`. `Ask` is the
default app composer mode and is read-only. `Explore` is a bounded read-only
research swarm that writes synthesis, per-explorer findings, omissions, and
follow-up questions. `Agent` is the default `claudex run` route. Old ids are not
compatibility aliases unless explicitly reintroduced in schema and docs.

## 5. Evidence Beats Summaries

Every hard claim needs evidence: a file, diff, command, log line, event, doctor
report, run artifact, or source reference. Diffs come from git in the isolated
worktree or live in-place target, not from model edit narration. Reviews are not
trusted unless reviewer output is parseable and route proof is observed.

## 6. Secrets Never Become Artifacts

Native harness auth is preferred. API keys are fallback secret refs stored in
Keychain or a `0600` store. Raw secrets must not appear in run params,
`jobs.json`, task contracts, events, summaries, patches, PR text, logs, or docs.
Scoped harness homes/config dirs stay outside the mutation worktree.

## 7. Project Context Is Explicit

Claudex must distinguish the Claudex product repo, the user-selected target
project, temporary workspaces, and harness native homes. The app must show which
project a run will use. `Ask` may answer general questions without a project,
using a non-sensitive synthetic cwd and storing artifacts in the user-level
Claudex store. Project-aware modes require an
explicit Current Project and must not silently fall back to a process cwd.

## 8. Spec-Driven Work Is First-Class

When a task is ambiguous, Claudex should move toward a frozen SpecPack: plan,
ask clarifying questions, record user answers, freeze acceptance criteria and
non-goals, then run against that contract. The Spec Interview is plan/draft
owned, not a permanent top-level app identity.

## 9. macOS UX Must Be Native, Honest, And Familiar

Users of Codex App, Claude Code, Cursor, and OpenCode should understand the app
quickly: composer-first, visible modes, harness chips, live activity, task
detail, diagnostics, review queue, and settings. Liquid Glass belongs to
navigation/chrome/floating composer; dense content uses solid surfaces. Glow and
motion are welcome, but black/white cutout artifacts, janky transitions,
glass-behind-code, and decorative UI that obscures state are bugs.

## 10. Settings Are Preferences, Not Brochures

macOS Settings owns app preferences and engine defaults exposed by the control
API: current project, appearance, routing, primary harness, model hints, env
inheritance, budget caps, auth status, and secret refs. Operations screens own
live Budget, Harness Doctor, Benchmarks, Review Queue, and run diagnostics.

## 11. Delivery Is Server-Owned

Inspect/apply/check use control-api endpoints and run artifacts. The UI must not
invent local accept/rebut/apply state. Read-only modes do not expose patch apply
controls. Apply is allowed only for successful runs with a successful decision
record and a patch WorkProduct for the original verified repo root.

## 12. Keep The Codebase Small And Direct

Prefer simple, typed, local solutions over speculative abstractions. Keep
surfaces thin, adapters translational, and orchestration centralized. Add an
abstraction only when it removes real duplication or captures an established
boundary. Avoid overengineering, hidden state, silent fallback, and broad
refactors unrelated to the user-visible problem. Follow SSOT, DRY, and SOLID as
pragmatic engineering constraints: one owner per contract, no duplicated
business rules across surfaces, and no config path that lets a project self-grant
sensitive powers.

## 13. Documentation Must Stay Current

Public docs have separate jobs and must not be mixed together:

- `README.md` is the product entrypoint and detailed quickstart.
- `CLAUDEX_BIBLE.md` is this compact constitution.
- `docs/ARCHITECTURE.md` is the current runtime, package, artifact, and control
  API map.
- `docs/INTEGRATIONS.md` describes current external integration surfaces and
  beta limitations.
- `docs/DESIGN_SYSTEM.md` is the macOS UI/UX contract.
- `docs/DEVELOPMENT.md` is for contributors changing Claudex itself.
- `docs/CHECKLISTS.md` holds human gates for docs, schema, release, visual QA,
  and security.
- App READMEs cover app-specific build and packaging notes.

Update the relevant docs whenever behavior changes. Public docs must stay free
of raw planning packets, review transcripts, local operator notes, local paths,
secrets, and one-off release scratch unless the user explicitly asks to publish a
sanitized artifact.
