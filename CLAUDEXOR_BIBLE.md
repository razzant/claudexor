# Claudexor Bible

This file is the constitution of Claudexor: the numbered, individually
verifiable invariants the product is built against. It is public product and
engineering doctrine, not private operator notes. If implementation, docs, UI,
or review feedback conflicts with an invariant, resolve the conflict
explicitly — fix the code, or change the invariant through the constitutional
process below. Never paper over the conflict.

## How this document works

- Every invariant has a stable id (`INV-NNN`). Ids are never renumbered and
  never reused: a retired invariant keeps its id with a `RETIRED` marker and a
  pointer to what superseded it. External references (tests, gates, reviews,
  commit messages) rely on this stability.
- Each invariant carries a `verify:` hint — the test, gate, artifact, or
  review question that proves it holds. An invariant nobody can check is a
  wish, not an invariant.
- Changing this file is constitutional: the commit message MUST carry a
  `CONCEPT-CHANGE(INV-NNN[, INV-MMM…])` marker naming every invariant added,
  edited, or retired, and the marker is added only when the owner explicitly
  approved that change (CI enforces the marker; `scripts/concept-gate.mjs`).
- Change is not deletion. Wording may be clarified, but if removing the new
  wording leaves the original principle unrecognizable, that is a deletion in
  disguise — forbidden without an explicit owner-approved retirement. An
  invariant whose content moves elsewhere keeps its id as an absorbed pointer.
- Canary golden stories (`packages/canary`) pin a growing subset of these
  invariants as executable user stories tagged `[INV-NNN:…]`. When a canary
  fails, the product regressed: fix the product, never the story, unless the
  owner approved a `CONCEPT-CHANGE` for that invariant.
- Some invariants below encode locked owner decisions; their `verify:` notes
  name the enforcement. They are constitution first, implementation second —
  code converges to them, never the reverse.
- Documentation is a hierarchy with one home per fact: this Bible
  (constitution — wins conflicts, or is amended via `CONCEPT-CHANGE`) →
  `docs/WHITEPAPER.md` (concept + rationale; zero operational claims) →
  `docs/ARCHITECTURE.md` (map of what is implemented now) →
  `docs/DESIGN_SYSTEM.md` (macOS UI contract) → `docs/CHECKLISTS.md`
  (process gates; the sole home of the release protocol) →
  `docs/DEVELOPMENT.md` (contributor commands; links instead of restating) →
  `docs/INTEGRATIONS.md` (external surfaces) → `docs/FEATURES.md`
  (non-solid ledger) → `docs/BACKLOG.md` (deferred with owner decision) →
  `docs/AGENT_ONBOARDING.md` (agent orientation). A fact lives in exactly ONE
  of these; every other mention is a link. Mantras worth repeating live only
  here. Two prose docs describing the same behavior differently is a
  release-blocking docs bug, not a style issue.

## 0. Zen

Orientation for every contributor and reviewer. The numbered invariants are
the enforceable law; this list is the spirit they serve. When a proposed
change pulls against one of these lines, stop and find the governing
invariant or owner decision before proceeding.

1. Simple beats complex; compact beats exhaustive. (INV-120)
2. Explicit beats implicit; self-explanatory beats clever.
3. Honest states: no silent fallback; unknown ≠ zero; absence ≠ empty; every
   async surface can show loading, loaded, empty, and failed.
   (INV-044, INV-093, INV-116)
4. One owner per fact; derived, not hand-maintained. (INV-122, INV-138)
5. Meta over patch when the class is proven (≥2 surfaces, or a broken
   SSOT/security boundary); otherwise the minimal local fix. Both directions
   are violations. (INV-121)
6. A positive promise exists only with an executable check or an explicit
   FEATURES row. (INV-022, INV-131)
7. Reviewers find defects; they do not author concept. (INV-139)
8. Routing is not strategy: who executes vs how many participate. (INV-140)
9. Product copy is English-only; user, model, and vendor content is never
   rewritten. (INV-141)
10. CLI-first; every other surface is a thin, honest view. (INV-001, INV-002)

## 1. Claudexor Is CLI-First

- **INV-001** Claudexor is a local-first control plane over external AI
  coding harnesses. The engine is the source of truth: `packages/schema`,
  CLI, daemon, control API, orchestrator, run artifacts, and project/user
  config. verify: docs/ARCHITECTURE.md package map matches the tree;
  review question on any new surface.
- **INV-002** macOS, MCP, ACP, host plugins, and future surfaces are thin
  views/controllers over the engine. They must not create app-only business
  logic, fake delivery state, or private run semantics. verify: review
  question "does this surface invent state the server does not own?";
  grep for engine imports in surface packages.
- **INV-003** Claudexor is a coding harness control plane, not a digital
  entity: it has no personality, memory identity, or autonomous runtime
  doctrine of its own. It is developed BY external agents, and its immune
  system (gates, canaries, reviews) is designed to constrain those external
  agents' sessions, not a self. verify: review question on any
  agency-flavored feature proposal.

## 2. Harnesses Are Not Roles

- **INV-010** Codex, Claude Code, Cursor, OpenCode, raw APIs, and future
  adapters are harnesses. Roles are intents (`explain`, `plan`, `spec`,
  `implement`, `create_from_scratch`, `repair`, `review`, `verify`,
  `synthesize`, `audit` — the canonical `Intent` enum in
  `packages/schema`). No harness is privileged and no semantic role is
  hardcoded to a harness id. verify: grep for harness-id conditionals in
  orchestration logic; review question.
- **INV-011** A harness can play an intent only when discovery + doctor +
  capability gating say it can. Manifest auth fields describe source
  availability only — readiness comes from doctor status, enabled intents,
  and smoke/conformance checks. verify: gateway gating tests; doctor-vs-
  routing review question.
- **INV-012** Missing, unauthenticated, degraded, or intent-incompatible
  harnesses are visible with reasons but never silently selectable; explicit
  selection of an unavailable harness fails loudly. verify: orchestrator
  routing tests; canary (unavailable-harness story, planned).
- **INV-013** Adapters are translational and orchestration is centralized:
  `harness-*` packages only translate native CLI/API streams into typed
  events and I/O. They never orchestrate, select winners, manage budgets,
  or decide review policy — those live in the engine/orchestrator. verify:
  review question; grep for orchestration/review imports in `harness-*`
  packages.
- **INV-140** Routing and strategy are orthogonal axes and never share a
  control: routing picks WHO executes a unit of work (harness + credential
  profile + model — manually or policy/quota-driven); strategy picks HOW MANY
  units run and how their results combine (single, best-of, council,
  deep-scan, delegation). No control that selects an account may narrow the
  harness pool; no strategy knob may pin an account. verify: composer and
  accounts UI review; schema separation of routing vs strategy fields.

## 3. Schema Is The Contract

- **INV-020** Data shapes live in `packages/schema`. Change schemas first,
  regenerate JSON Schema, then update TypeScript, Swift, docs, tests, and
  surfaces. Contracts are not forked in UI code, CLI parsing, adapter
  output, or docs. verify: schema:gen diff gate; docs-truth; review.
- **INV-021** Unknown modes, unknown portfolios, invalid access profiles,
  malformed artifacts, stale reviews, and unavailable harnesses fail loudly
  at every wire boundary. verify: canary `[INV-032:modes-canonical]` and
  `[INV-021:fail-loud-flags]`; control-api DTO tests.
- **INV-022** A schema field ships only WITH a real producer AND a real
  consumer in the same change (staged-field rule); otherwise it is deleted —
  never left as a dead or fake knob. Comments are not consumers. verify:
  `pnpm staged:check` (v2) in CI; knip.
- **INV-023** Config knobs, UI toggles, and DTO fields that do nothing are
  bugs of the same class as staged fields: a control the user can set must
  change behavior or not exist. verify: audit sweeps; review question
  "what behavior does this knob change, and where is its consumer?".

## 4. Modes Are Canonical And Breaking

- **INV-030** The canonical modes are exactly `ask`, `plan`, `agent` — three
  conversation intents. There is NO `orchestrate` mode: it was deleted once its
  delegation replacement landed (`agent --delegate`, D32) and the retired verb
  hard-errors naming the replacement. Delegation is a STRATEGY FLAG (see
  INV-031), not a mode: `--delegate` injects a scoped Claudexor MCP belt (the
  generalized `HarnessRunSpec.extra_mcp_servers` seam, adapter-translated) into
  the harness sandbox so the harness spawns bounded, isolated sub-runs
  (ask/plan/run/best-of + status/result — NO apply/decision/thread/settings);
  server-side policy at the tool boundary caps nesting depth at 1, sub-run count
  per parent (default 8), and the paid-budget draw from the parent ledger
  headroom. Only adapters declaring `capability_profile.mcp_injection` (claude,
  codex) can host the belt; `--delegate` elsewhere is a typed preflight refusal.
  verify: `ModeKind` in schema; docs-truth mode-id check; canary
  `[INV-030:orchestrate-retired]`.
- **INV-031** Engine strategies are FLAGS on a mode, never modes of their
  own: best-of-N (`--n`), capped repair (`--attempts`), repair-to-clean
  (`--until-clean`), research sweep (`ask --deep-scan`), create-from-scratch
  (`agent --create`), delegation belt (`agent --delegate`), council planning
  (`plan --council`, with `--n 2..4` legal only under council). verify: CLI
  help + docs-truth flag check.
- **INV-032** Old mode ids are not compatibility aliases; they hard-error at
  every wire boundary unless explicitly reintroduced in schema and docs.
  verify: canary `[INV-032:modes-canonical]`; CLI mode validation tests.
- **INV-033** `Agent` is the default composer/`claudexor agent` route on a
  project thread — in Agent the harness itself decides whether to answer or
  edit the tree (Codex/Cursor/Claude Code semantics); a no-project thread
  falls back to read-only `Ask`. The retired verb spellings (`run`, `race`,
  `audit`, `map`, `explore`) hard-error with the new spelling (`agent`,
  `best-of`, `ask --deep-scan`) — no compatibility aliases, same doctrine as
  retired mode ids.
  verify: orchestrator default-mode tests; UI intent menu review; canary
  `[INV-033:verbs-renamed]`.
- **INV-034** A thread is the Claudexor-owned conversation (runs are its
  turns); the vendor CLI session is a re-hostable cache that later turns
  resume natively. Read-only thread turns (ask/plan) keep DURABLE per-lane
  native sessions — a lane is a (thread, harness, profile) triple with a
  persistent scoped home under the project runtime namespace — and never
  dispose them with the run; the next turn of the same lane resumes that
  session, and only thread purge, credential-profile deletion, or orphan
  retention removes a lane home. Thread, turn, and session mutations are fsync-before-ACK
  journal records; create and Exact Retry bind `Idempotency-Key` to the
  original request and never duplicate a turn. Exact Retry is a fresh linked
  command with fresh preflight; Run Again is an editable draft with explicit
  differences. verify: thread journal restart and idempotency tests; run retry
  and draft tests; session-resume orchestrator tests.
- **INV-035** A v2 project has a stable daemon-owned id bound to one canonical
  local root. The v2 registry starts empty, never imports v1 state implicitly,
  and registration is request-idempotent; relink moves the same project id
  instead of creating a second authority. Registered project commands, threads,
  turns, and sessions live in that stable id's isolated journal partition;
  no-project state remains global. Every public CLI mode and REPL turn enters
  through the managed daemon; daemon startup failure never creates a second
  in-process run/thread authority. verify: ProjectStore restart, partition
  routing/idempotency/recovery isolation, relink tests, `/v2/projects` API tests,
  and canary `[INV-035:cli-all-modes-daemon-owned]`.

## 5. Evidence Beats Summaries

- **INV-040** Every hard claim needs evidence: a file, diff, command, log
  line, event, doctor report, run artifact, or source reference. Model
  prose is context, not proof. verify: review protocol; reviewer evidence
  preflight in reviewEngine.
- **INV-041** Diffs come from git in the isolated worktree or live in-place
  target, never from model edit narration. Captured diffs must round-trip:
  what the engine records as the work product must `git apply` cleanly to
  the base it was captured against (no silent corruption — CRLF, quoted
  paths, binary — between capture and delivery). verify: workspace diff
  tests incl. the CRLF and binary round-trip cases (byte-faithful raw
  capture; `git diff --binary`).
- **INV-042** Reviews are trusted only when reviewer output is parseable,
  route proof is observed (stream- or transcript-observed model, never an
  argv echo), reviewer telemetry is persisted, and the reviewer read the
  candidate evidence files rather than a giant prompt-only diff. verify:
  reviewEngine route-proof tests; per-reviewer artifact checklist.
- **INV-043** Tool success is evidence, not prose. `tool_result.is_error ===
  true` is a hard warning that blocks a green verified claim unless later
  verified recovery exists, but it does not by itself discard a produced
  deliverable. Recovery must be attributable to the failed operation, not
  merely a later call of the same-named tool — the engine keys recovery by
  tool AND target. verify: attemptTelemetry recovery-keying tests.
- **INV-044** The engine separates terminal state from tool hygiene: a
  completed answer/report/patch may succeed with warnings, while failed web
  evidence, terminal harness errors, failed apply/verify steps, or required
  gates still block. verify: outcome-dimension telemetry tests.
- **INV-045** Web answers are web-backed only when `WebSearch`/`WebFetch` or
  equivalent evidence was observed; a memory answer after a failed web tool
  is partial/unverified. verify: web-evidence telemetry tests.
- **INV-046** Transient infrastructure failures are typed adapter evidence,
  never guessed from model prose. The orchestrator may spend a bounded retry
  budget only for typed transient failures with no produced deliverable.
  verify: transient-retry orchestrator tests.
- **INV-047** A repeated identical diff against a still-failing required
  gate is reported honestly as `stuck_no_progress`, never success. verify:
  until-clean stuck test.
- **INV-048** Interactive FLOW-CONTROL tools are not work tools: a declined
  or timed-out `AskUserQuestion`/`ExitPlanMode` is a benign timeline event,
  never a blocking tool error; an ANSWERED interaction flows through the
  typed interaction contract. Real work-tool errors remain visible warning
  evidence. verify: claude interactive tests; interaction-timeout tests.
- **INV-049** No regex governance: risk, permissions, web-required
  detection, tool success, winners, and tests-passed are determined by typed
  contracts, settings, events, gates, or reviewer evidence — never ad hoc
  string matching over model text. verify: review question + grep on
  governance paths.
- **INV-050** Protected gate/test paths are contract evidence: when a
  deterministic gate is configured, edits to the protected test/gate surface
  produce deterministic policy findings before any model can claim the run
  is clean. Explicit test-authoring work can approve the relevant protected
  globs through a typed run field (`--allow-protected-path`), which narrows
  only the gate/test-path policy and never bypasses built-in
  critical/security human gates. Path parsing for these gates must handle
  every path git can emit (quoted, non-ASCII) — the shared quote-aware
  diff parser is the one owner. verify: policy tests; core diff parser
  tests.
- **INV-051** Run artifacts live in two honest planes that are never
  conflated: the run tree under the external per-project runtime namespace
  (`~/.claudexor/v3/projects/<project-sha256>/runs/<id>/`) is Claudexor's
  internal orchestration evidence, while the project's produced outputs (the
  repo `artifacts/` dir served via `/runs/:id/produced`) are user
  deliverables. Surfaces label which plane they show. verify: control-api
  produced/artifacts endpoint tests; thread-workspace Artifacts review.

## 6. Secrets Never Become Artifacts

- **INV-060** Native harness auth is ready only after the exact source-targeted
  doctor probe and, for setup success, an isolated same-harness capability smoke
  over the normal adapter stream. Process exit, another provider, an API key,
  tools, external context, or workspace mutation cannot satisfy the proof. The
  receipt proves credential transport, not plan tier, entitlement, quota, or
  zero cost. verify: auth-capability verifier; setup restart/route/challenge
  tests; doctor route checks.
- **INV-061** Explicit `subscription` never falls back to an API key. `auto` is
  native-first for Codex, Claude, and Cursor; a paid route is eligible only under
  the typed paid-fallback policy. Requested/effective credential route and
  source plus the selection reason are preserved as evidence. Codex subscription
  auth uses a Claudexor-owned `CODEX_HOME` with file-only credential storage,
  never the operator's ordinary `~/.codex` or OS Keychain. Native/subscription is
  also the PRESENTED default on every surface: onboarding, the Harness Doctor,
  the composer's route disclosure, routing defaults, and docs lead with and prefer
  the native route, and API keys appear as an explicitly-labeled fallback — never
  the default path a user lands on (most users authenticate by subscription, not
  by key). This surface ordering does not fork routing: the typed paid-fallback
  under `auto` above stays the single routing rule, so a native-unavailable `auto`
  run may still use a verified API route. verify: adapter auth
  isolation tests; setup capability receipts; routing paid-fallback tests;
  onboarding native-first + composer route-disclosure review question.
- **INV-062** Raw secrets must not appear in run params, the command journal, task
  contracts, events, summaries, patches, PR text, logs, or docs. The PROMPT
  is included: a secret-like value inside the prompt text is hard-blocked at
  every ingress surface (CLI, POST /runs, thread turns, MCP, ACP, daemon
  enqueue) with a typed `inline_secret_rejected` error and remediation —
  prompts are durable artifacts and there is deliberately NO bypass flag.
  verify: secret-scan CI step; redaction tests; inline-secret rejection
  tests; canary `[INV-062:prompt-secret-block]`.
- **INV-063** Scoped harness homes/config dirs stay outside every mutation
  worktree, in the external per-project runtime namespace, so `git add -A`
  can never capture auth files, plugin downloads, sqlite logs, or transcripts
  into a patch. verify: workspace env tests; T3 audit sweep.
- **INV-064** User attachments (images, files) are persisted only in a
  daemon-owned store outside any worktree; source paths/base64 are never runtime
  authority. Upload streams to a temporary file, finalize fsyncs and atomically
  publishes digest-bound immutable bytes, and run/turn requests accept only the
  returned resource IDs. verify: resource-store and control-api upload tests.
- **INV-065** Every selected lane must declare finite MIME, byte/count and
  transport support for every mandatory attachment. Mixed pools fail before
  enqueue when any selected lane cannot receive the same bytes; adapters verify
  the finalized digest before the vendor payload. verify: attachment routing,
  adapter payload and digest-mismatch tests.
- **INV-066** The agent-driven browser is a second live-egress channel and
  is treated like one: it is injected only when the run opted in, the
  harness declares `browser_tool`, web policy is not `off`, and the access
  profile allows it. Preflight records requested/effective truth per selected
  lane: incapable mixed-pool lanes still run with `effective: false` and a typed
  reason, while a pool with no effective browser lane is refused before any
  harness starts. The injection is disclosed, and navigation evidence
  lands in the run artifact tree. The Browser MCP is an exact lockfile-pinned
  local runtime, ships with the app, never downloads through `npx`, and runs
  without provider credentials. Harnesses without a wired injector honestly
  declare `browser_tool: false`. verify: browser-gate adapter tests; packaged
  offline help smoke; mixed/zero-capable preflight tests; adapter manifest review.

- **INV-067** Credential transports are ENV-PORTABLE or honestly refused:
  every claimed auth route must actually authenticate in the exact scoped
  environment (cwd + env, including a scoped/throwaway HOME) its run will
  spawn with — host-environment readiness never stands in for it. Where a
  vendor's primary credential store is outside a generic scoped HOME, the
  adapter may expose only a declared MINIMAL vendor-specific bridge (Claude
  on macOS: a disposable Claude-only child HOME whose sole host bridge is
  `Library/Keychains`; a Claudexor-owned `CLAUDE_CONFIG_DIR` selects the exact
  default or profile-specific Keychain item). Ordinary `~/.claude` is never
  read, written, or used for Claudexor native setup/runs. Other harnesses never
  receive that bridge, and all writable vendor state stays scoped. Codex remains portable through
  its file-only `CODEX_HOME` seed. The doctor names the real cause and the
  Claudexor-owned in-app Native setup remedy (never a bare vendor login command
  that targets the ordinary store, never a bare "not authenticated"), and reviews of auth/
  readiness changes check every lane class — read-only scoped HOME, isolated
  envelopes, in-place — not just the host env. Reading, copying, exporting,
  snapshot-swapping, or persisting vendor credentials ("keychain surgery")
  stays forbidden; a filesystem bridge lets the vendor access its own
  OS-protected item, never Claudexor. verify: routeContext same-env probe
  tests; Claude-only native-home bridge tests + generic-home no-bridge test;
  W3.3 route-admission tests; CHECKLISTS review row.

  NOTE (external session-invalidation risk, INV-067 corollary): a browser-based
  OAuth login completed in a browser already signed into the same vendor can
  revoke that vendor's sibling sessions server-side within seconds — the
  2026-07-21 incident was an in-browser OpenAI account switch that 401'd the
  ChatGPT desktop app. The OpenAI backend also invalidates sessions with no
  local trigger. This is vendor backend behavior, outside Claudexor's control.
  Claudexor's only levers are its device-auth default for codex login, the
  isolation instruction (complete the link in a private window / a profile
  signed into no other vendor account), and honest disclosure of the risk. The
  product must NEVER claim to prevent it — mitigation and disclosure only.

## 7. Project Context Is Explicit

- **INV-070** Claudexor distinguishes the Claudexor product repo, the
  user-selected target project, temporary workspaces, and harness native
  homes. The app shows which project a run will use. verify: ProjectChip UI
  review; RunScope validation tests.
- **INV-071** `Ask` may answer general questions without a project, using a
  non-sensitive synthetic cwd and storing artifacts in the user-level
  Claudexor store. Project-aware modes require an explicit project and
  never silently fall back to a process cwd in the app; the CLI's contract
  is that the invoking directory IS the project scope. verify: canary
  `[INV-071:project-context-explicit]`; app no-project tests.
- **INV-072** Ordinary project runs (and Best-of candidates) execute in
  isolated envelopes under the external per-project runtime namespace
  (`~/.claudexor/v3/projects/<project-sha256>/workspaces/.../tree`), with the
  harness cwd at the envelope worktree. The repository's `.claudexor/`
  remains user-owned versioned config. verify: workspace manager tests.
- **INV-073** Chat thread WRITE turns run IN-PLACE in the thread's
  explicit execution tree — the live project for an `in_place` thread, or
  the thread's persistent worktree for an `isolated` thread — and the
  surface must disclose which applies. verify: thread schema defaults;
  in-place orchestrator tests.
- **INV-074** Absolute host paths such as `/tmp/...` are not project diffs
  and do not prove project success. Project tmp requests default to
  project-local `tmp/...` or run artifacts unless the user explicitly
  selects a verified host-side-effect mode. verify: tmp-semantics telemetry
  tests.
- **INV-075** Write modes need a git boundary. A non-git project folder is
  initialized automatically (`git init` + a deterministic baseline commit),
  announced via a typed `project.git.initialized` event — never a refusal,
  never a silent mutation. Claudexor never creates or edits the project's
  `.gitignore`; repo `.claudexor/` is user-owned state and runtime stays
  external. verify: git-init and gitignore non-interference workspace tests.

## 8. Plan-Driven Work Is First-Class

- **INV-080** When a task is ambiguous, Claudexor moves toward a READY plan:
  the plan lifecycle surfaces typed open questions, answers are ordinary
  turns in the same conversation, and readiness is derived by ONE
  server-side owner — surfaces consume the projection, never re-parse plan
  text. The interview is plan-owned, not a separate top-level identity.
  verify: plan question parser tests; planReadiness projection tests;
  CHECKLISTS plan-loop QA row.
- **INV-081** An implemented plan is a content-hashed contract: Implement
  FREEZES the plan (sha256 recorded on the turn), delivery to the executor
  is a server-owned file reference materialized outside every worktree, the
  engine verifies the hash before any harness spawns, and a tampered or
  unreadable plan fails loudly. Retry replays the reference verbatim — a
  retried implement can never silently run without its plan. verify:
  withPlanBrief hash tests; thread-turn plan_hash/409 tests.
- **INV-082** Plans and repo config cannot carry protected-path approvals;
  operator approval is always supplied on the current run. verify:
  run-level approval schema strictness.

## 9. macOS UX Must Be Native, Honest, And Familiar

- **INV-090** The app is chat-first: ONE screen — thread list, conversation,
  persistent composer — with the current thread's workspace in the trailing
  region, not a separate kitchen-sink of tabs. Users of Claude Code, Cursor,
  and Codex should feel at home: you just type; the first message starts a
  thread; turns run in-place so the next turn sees the work. verify:
  DESIGN_SYSTEM contract; visual QA checklist.
- **INV-091** The trailing region is the CURRENT THREAD's workspace (D42),
  not a per-run inspector: three tabs — Changes, Artifacts, Evidence —
  aggregated across the thread's runs on solid surfaces. Selecting a chat
  receipt FILTERS the workspace to that run (its Outcome facts on top); run
  detail is demoted to this filtered view, never the panel's identity.
  Produced outputs (including any project preview) fold into Artifacts —
  there is no competing Canvas plane and no two-plane Workbench. Live run
  progress is a PERSISTENT inline receipt in the conversation (auto-expanded
  while active, then the collapsed log), never a disappearing pane. This is
  the sanctioned extension of the one-screen doctrine — no third top-level
  screen. verify: DESIGN_SYSTEM workspace contract; RootView /
  ThreadWorkspacePanel review.
- **INV-092** The composer is always live — an empty chat is never a silent
  no-op. While a turn runs, Send swaps to a server-owned Stop. verify:
  composer state tests (ComposerTurnState).
- **INV-093** Every turn shows its HONEST outcome: a plan says "no files
  changed" and offers to implement; a patch shows its diffstat; a race shows
  the adopted winner; a terminal failure with no output renders an inline
  failure card with the engine's reason. A turn whose run was refused BEFORE
  it started (trust gate, preflight) persists the refusal on the turn
  (`ThreadTurn.enqueue_error`) and renders it inline with a retry remedy —
  never an eternally-empty bubble whose reason lived only in one HTTP
  response. Working progress (reasoning + tool calls) streams into the turn
  as it happens. verify: canary `[INV-093:plan-honest-no-op]`; ThreadStore
  setTurnEnqueueError tests; turn-card UI review.
- **INV-094** The window is matte glass (behind-window material; Reduce
  Transparency falls back to solid). There is NO always-animating backdrop
  and NO perpetual pulsing: idle means zero animation. Liquid Glass belongs
  to navigation/chrome/the composer; content cards use one frosted material
  with a single soft shadow; code, diffs, transcripts, and dense text keep
  solid high-contrast surfaces. verify: DESIGN_SYSTEM tokens; visual QA.
- **INV-095** Money is typed, never a slider. Decorative UI that obscures
  state, glass-behind-code, and janky transitions are bugs. Both light and
  dark must be WCAG-legible; hover help is required on compact/non-obvious
  controls. verify: visual QA checklist.

## 10. Settings Are Preferences, Not Brochures

- **INV-100** macOS Settings owns app preferences and engine defaults
  exposed by the control API: appearance, routing, primary harness,
  harness-scoped model defaults, env inheritance, budget caps, auth status,
  and secret refs. Settings also hosts live Budget and the Harness Doctor
  (tabs). verify: settings DTO tests; Settings UI review.
- **INV-101** Project selection is NOT a Settings preference — it lives only
  in the chat composer's ProjectChip (MRU recents + Browse…). verify: grep
  for project pickers outside the composer; UI review.
- **INV-102** Review verdicts and run diagnostics live ON the turn and in
  the run inspector; there is no separate Review Queue screen. verify:
  docs-truth deleted-screen guard.
- **INV-103** Model choice is harness-scoped end-to-end: the engine keeps a
  per-harness model map (per-harness defaults + per-turn map recorded on the
  TaskContract as `routing_models`); no global cross-harness model value
  exists, and a scalar model convenience input expands only to the resolved
  primary — never to the pool (ambiguous scalars are rejected). verify:
  schema (no `routing.default_model`); canaries
  `[INV-103:scalar-model-primary-only]` and `[INV-103:no-global-model]`;
  routing tests. Locked owner decision.
- **INV-104** A model outside the harness's model truth source (live
  inventory or manifest known-good list) is refused at settings-write, run
  preflight (typed failure WITH artifacts before any CLI spawns), and both
  reviewer-resolution paths — never forwarded to the vendor CLI to die as an
  opaque native error. Refusals name the harness, the model, and the truth
  source; model truth is surfaced to UIs (`source: api | manifest`), and
  known-model hints carry a `verifiedAgainst` freshness note checked by the
  model-hints-freshness gate. verify: canaries
  `[INV-104:model-truth-refusal]`, `[INV-104:models-manifest-fallback]`,
  `[INV-104:settings-write-strict]`; settings-service tests;
  modelGovernance preflight tests. Locked owner decision: strict
  everywhere.
- **INV-105** Per-harness knobs a manifest does not support are disclosed as
  `ignored_settings` on `harness.started` — never silently dropped. This
  covers max_turns, tool lists, and effort (an empty declared ladder); an
  explicit MODEL never reaches an unsupporting route at all — the strict
  truth-source preflight refuses it first (INV-104). verify: knob
  disclosure tests incl. the INV-105 effort-disclosure test.

## 11. Delivery Is Server-Owned

- **INV-110** Inspect/apply/check use control-api endpoints and run
  artifacts. The UI must not invent local accept/rebut/apply state.
  Read-only modes do not expose patch apply controls. Every product endpoint
  is under `/v2`; official clients negotiate `POST /v2/handshake` and send the
  negotiated major, while unversioned product aliases are refused. verify:
  control-api handshake/catalog tests; docs-truth catalog parity; UI review.
- **INV-111** Apply is allowed only for successful runs with a successful
  decision record and a patch WorkProduct for the original verified repo
  root — with one typed, server-owned exception: an operator decision
  (`POST /v2/runs/:id/decision`, `accept_risk`/`override_needs_human`)
  persists an auditable, patch-hash-bound record that unblocks apply for a
  `blocked` run; a mutated patch invalidates the override. The human
  decision is never client-faked state. verify: apply-gate tests; canary
  `[INV-112:apply-needs-verified-review]`.
- **INV-112** A clean CROSS-FAMILY VERIFIED review is sufficient
  verification even without a deterministic test gate;
  `DecisionRecord.verification_basis` discloses what backed an applyable
  outcome, so a no-test run adopted on review evidence never reads as
  "tests passed". Gates alone do not make a patch applyable. verify:
  arbitration verification_basis tests.
- **INV-113** Every path that can mutate the live project tree is
  enumerated in ARCHITECTURE with its fence, and each has one: envelope
  delivery, manual apply, race adoption, and thread apply
  go through the delivery-owned fresh verifier immediately before mutation;
  (the retired `orchestrate-apply` path is gone — delegation sub-runs carry
  no apply tool, so the parent integrates their results through the ordinary
  apply path, CONCEPT-CHANGE(INV-113));
  race adoption applies only on a verified clean terminal; `revert_run` is
  content/preimage-fenced; thread apply considers every run not yet recorded
  as delivered and is serialized against active turns. An
  unlisted mutation path is a release blocker. verify: mutation-path
  inventory in ARCHITECTURE; delivered-prefix and active-turn thread-apply
  tests (locked owner decision).
- **INV-114** Apply/adoption captures and rechecks the exact target preimage
  immediately around the mutation; stale or conflicting targets are refused
  without destructive rollback. `adopted:false`/`not_applied` means the tree
  is unchanged. Revert changes only the Claudexor-recorded postimage and
  refuses overlap with later user edits. verify: protected-apply conflict and
  concurrent-edit tests (byte-identical index/worktree preservation).
- **INV-115** Before an envelope-produced patch is applied or adopted —
  manual apply, race winner, thread delivery, or convergence result — it is
  re-verified by the delivery owner in a fresh
  envelope (`git apply` to a clean base + configured deterministic gates
  there) immediately before the target preimage check; the result is recorded
  in the decision/receipt, and a missing, stale, or failed verifier
  infrastructure error blocks fail-closed exactly like a proven failure.
  A patch that cannot survive a clean base does not touch the live tree.
  In-place turns are exempt: their diff is produced against the LIVE tree,
  and a bare snapshot worktree (no gitignored deps) would false-block
  green work. Deterministic gates must be hermetic to the checkout for the
  verify re-run to be meaningful.
  verify: FinalVerifier tests + the final_verify apply-gate consumer tests
  (locked owner decision).
- **INV-116** CONCEPT-CHANGE(INV-116): the run's TERMINAL truth is the D8
  independent axes — a lifecycle (`succeeded|failed|cancelled|interrupted`)
  that says how far the PROCESS got, plus the orthogonal outcome FACTS
  (`checks`, `review`, `noChanges`, `reason`) that say what the work amounted
  to — and this is separate from output readiness
  (`pending|finalizing|ready|diagnostic`). A needs-decision terminal (review
  blocked or checks failed) is a SUCCEEDED lifecycle awaiting a human, not a
  distinct state. A further orthogonal axis is the D-16 `work_state` — the
  model-attested WorkReport outcome (completed / needs_input / incomplete /
  unverified) — which can VETO applyability and the clean exit without flipping
  the lifecycle: a needs_input/incomplete run stays a succeeded lifecycle but is
  non-applyable, labels "Needs input"/"Incomplete", and exits non-zero through
  the outcome-aware exit projection beside `processExitCode`. A blocked
  read-only run that delivered nothing is a failure, never a succeeded "needs
  review" (QA-036). Every announced run reaches a terminal event on every path —
  crash, cancel, pre-loop failure — so no observer waits forever. CLI and UI
  show the axes through the one projection owner (labels, exit code, needs
  decision). verify: canaries `[INV-116:output-ready-before-terminal]`,
  `[INV-116:cancel-fast]`, `[INV-116:stream-watchdog]`,
  `[INV-116:blockers-visible]`, `[INV-116:work-complete]`,
  `[INV-116:work-state-veto]`, `[INV-116:work-report-contract]`,
  `[INV-116:context-interrupted]`, `[INV-116:continuation]`; the
  whole-strategy terminal net and interrupt-stamping tests.

## 12. Keep The Codebase Small And Direct

- **INV-120** Prefer simple, typed, local solutions over speculative
  abstractions. Add an abstraction only when it removes real duplication or
  captures an established boundary. Avoid overengineering, hidden state,
  silent fallback, and broad refactors unrelated to the user-visible
  problem. verify: review protocol scope checks.
- **INV-121** Meta-solutions over patches: data-drive from declared
  capabilities, single producers with translational consumers, typed
  contracts over hardcoded enums-in-logic — so future
  values/harnesses/modes work without re-patching. Before closing any bug,
  ask the class question: "if this fix had existed earlier, could the same
  failure class have reached us through another surface?" If yes, fix the
  class. verify: review protocol; reference example: the effort-ladder
  normalizer.
- **INV-122** SSOT/DRY/SOLID as pragmatic constraints: one owner per
  contract, no duplicated business rules across surfaces, no config path
  that lets a project self-grant sensitive powers. verify: review; trust
  gating tests.
- **INV-123** Dead code is deleted, not allowlisted (justified, dated
  baseline entries tied to a locked decision are the only exception). Docs
  claims about endpoints, mode ids, and CLI flags are checked against
  source by the docs-truth gate; adapter stream parsing is pinned by
  recorded fixtures with conformance parity tests. verify: knip;
  staged:check; docs-truth; fixture parity tests.
- **INV-124** Readability only degrades by explicit decision: the
  complexity ratchet fails CI when a tracked file grows past its committed
  baseline, and the baseline moves only down (or by a reviewed, justified
  hand edit). Known failure class this guards: god-files absorbing every
  fix because appending is cheapest. verify:
  `scripts/complexity-ratchet.mjs` in CI.
- **INV-125** Release tags additionally pass the owner-review gate: ONE
  parallel review wave on the frozen candidate SHA — independent
  full-context critic subagents plus the exact model-diverse triad
  (`openai/gpt-5.6-sol`, `anthropic/claude-fable-5`,
  `google/gemini-3.5-flash`) and a scope reviewer
  (`anthropic/claude-fable-5`) — all reading one sealed packet; ONE
  adjudication under INV-139; ONE batched fix commit; ONE confirmation wave
  on the delta. A blocking verdict cannot be sealed. Rounds beyond the
  confirmation wave require an explicit owner decision. The signed
  owner-review attestation binds the candidate SHA/tree, the full-gate
  receipt digest, and — CONCEPT-CHANGE(INV-125) — the EXACT triad+scope
  panel: each of the three triad slots and the scope slot is bound by its
  model identity and its report digest + verdict (a >=2 structural floor no
  longer suffices; off-panel reports can ride along as extra critics but
  never satisfy coverage). Substituting or skipping the panel without an
  explicit owner override is a hard error; an override is a distinct recorded
  fact, never a reviewer PASS. The retired schemaVersion-2 (six-slot)
  attestation is REJECTED as publish input; already-sealed older-schema
  attestations stay verifiable only for their own archived releases. A
  whole-tree immune scan (docs-vs-code, dead surface,
  invariants-vs-tree) is a mandatory pre-release checklist step.
  verify: `scripts/seal-owner-review-attestation.mjs` (panel + round
  constraints); `verify-release-input.mjs`; CHECKLISTS Release + Review
  Protocol sections.
- **INV-138** Derived surfaces are generated, never hand-maintained:
  operation catalogs, endpoint docs, capability/parity matrices,
  per-subject refresher lists, and similar projections are produced from a
  single declared source (route descriptors, adapter manifests, the profile
  registry). A hand-edited shadow of a generatable artifact is the same
  defect class as a staged field. verify: generated-catalog diff gates;
  review question "what declaration produces this list?".
- **INV-139** Review finds defects; it does not author concept. A blocking
  finding must cite a violated invariant or owner-accepted criterion, carry
  reproducible evidence, and be reachable in the default configuration;
  reviewer `proposed_fix` text is advisory; consensus without evidence
  blocks nothing; later waves cannot open blockers on unchanged code
  without new evidence. Owner decisions and this Bible outrank reviewer
  preference — a finding that re-litigates a recorded owner decision is
  adjudicated out-of-scope and ledgered, never silently fixed. verify:
  review packet template (BLOCKER_FILTER, DECLINED_FINDINGS); adjudication
  ledger; CHECKLISTS Review Protocol.

## 13. Documentation Must Stay Current

- **INV-130** Public docs have separate jobs and are not mixed: `README.md`
  (entrypoint/quickstart), this Bible (constitution),
  `docs/ARCHITECTURE.md` (runtime/package/artifact/control-api map),
  `docs/INTEGRATIONS.md` (integration surfaces + stability tiers/disclosed limitations),
  `docs/DESIGN_SYSTEM.md` (macOS UI/UX contract — the single SSOT for app
  behavior and visuals), `docs/WHITEPAPER.md` (public rationale),
  `docs/DEVELOPMENT.md` (contributor workflow), `docs/CHECKLISTS.md` (human
  gates), `docs/FEATURES.md` (status ledger of non-solid features),
  `docs/AGENT_ONBOARDING.md` (external-agent orientation over the
  machine-readable surfaces),
  `CONTRIBUTING.md` (the agent session contract), app READMEs (build
  notes). verify: docs-truth; doc-taxonomy review question.
- **INV-131** Update the relevant docs in the same change that alters
  behavior; a feature listed in `docs/FEATURES.md` has its row updated or
  deleted in the same commit that changes it. verify: CONTRIBUTING
  self-check; review.
- **INV-132** Public docs stay free of raw planning packets, review
  transcripts, local operator notes, local paths, secrets, and one-off
  release scratch. verify: docs-hygiene checklist; secret scan.
- **INV-133** Docs describe current behavior in era-neutral language;
  version anchors (`v0.N`) belong to changelogs and explicit history
  sections, not to descriptions of the present. verify: docs-truth v2
  version-anchor lint.
- **INV-134** UI presentation discipline: every displayed fact has ONE
  presentational owner (one mapper — two surfaces showing the same fact
  compose the same producer, never fork vocabularies); a disabled control
  visibly explains why it is disabled; a new chip/badge/pill enters the UI
  only through an explicit DESIGN_SYSTEM section; layouts use fixed
  grids/anchors — an element's position and size never drift with the
  length of its text. verify: DESIGN_SYSTEM §1.1; review.
- **INV-135** Credential profiles: a profile is a durable NON-SECRET registry
  entry {profile_id, harness_id, display_name, credential_kind,
  isolation_locator|secret_ref, enabled} — secret material lives only in the
  vendor-owned dir or the namespaced secret store, readiness only in the
  doctor's projection. Profiles are ADDITIVE identities: the default vendor
  stores (~/.claude, the native codex home) are never a profile target and are
  never mutated by profile operations. There is NO user-settable "Active"
  account: enabling/disabling a profile (the toggle) is the only routing
  control. ONE resolve owner (the orchestrator) resolves the per-harness
  EFFECTIVE account by an owner-locked ladder: an explicit per-run/per-thread
  profile pin wins; else POOL AUTO — the native/CLI login default subject.
  Enabled profiles route ONLY by explicit pin or as quota-rotation targets,
  never as a silent auto-default. Unknown, disabled, or harness-mismatched
  explicit ids refuse — an explicit profile never silently becomes the default
  credential ladder — and an adapter given an unsupported transport refuses
  typed. When the native/CLI login is excluded (`native_credentials_enabled:
  false`) and no pin exists, an unpinned run has nothing routable: it refuses
  (explicit) or drops (auto) and never silently falls back INTO the disabled
  login. Accounts are SYMMETRIC: every account is a row with an Enabled toggle
  (the only routing control), the native login is a "CLI login" row with the
  same toggle semantics minus Delete, and ONE server projection owns the
  informational `next_up` identity — who an unpinned run would route to next,
  computed by the routing owner from enabled profiles + native readiness +
  quota — so no surface re-derives it. Native-session resume never crosses
  profiles. Selecting a named profile makes its harness/pool coherent and every
  selected lane probes the profile before spawn; deletion clears durable pins
  (any harness's `rotation_eligible` entry), matching native-session caches, and
  quota subjects so an id cannot dangle or resurrect stale auth. verify: schema
  credential-profile.ts; orchestrator credential-profiles.ts; adapter profile
  tests; threads resume-isolation test.
- **INV-136** High-volume UI evidence is PROGRESSIVE, BOUNDED, and honest:
  per-run milestone bursts are exactly one in-flight request plus at most one
  trailing refresh (events during the trailing load cannot chain more GETs);
  thread/run hydration loads typed summaries + artifact metadata, never raw
  event/rollout/log bodies or tab-only patch bytes; chat renders a disclosed
  bounded tail rather than every retained transcript row/character; long
  interviews use a lazy bounded scroller with fixed actions. Complete
  untruncated evidence remains reachable in the run artifact plane, and every
  omitted count/path is disclosed. No monospaced multi-megabyte `Text`, eager
  raw-artifact fetch, N+1 detail hydration, or unbounded card may enter a
  release. verify: DESIGN_SYSTEM §3.2; detail single-flight + diagnostics/
  patch no-fetch tests; >4 MiB/transient Diff failures disclose path + Retry
  rather than spin; transcript row/text-bound tests; Spec interview visual QA.
- **INV-141** Claudexor-owned presentation (UI strings, CLI output, docs,
  generated notices, dates and numbers) is English-only, independent of the
  host locale. User, model, and vendor content is never rewritten or
  translated. verify: product-copy locale scan (planned gate); runtime
  `ru_RU` spot check in visual QA.

## 14. Continuity Is The Product

- **INV-137** A Thread is ONE conversation regardless of which harness or
  account executes its turns. A lane is (thread, harness, profile). The same
  lane resumes its native vendor session — read-only modes included: their
  sessions persist per lane and are never disposable. Switching lanes
  hydrates the new lane with a bounded continuation packet (recent turns
  verbatim, a summarized older prefix, accepted decisions, the active plan
  reference, a workspace anchor), and the turn DISCLOSES the hydration
  visibly in both UI and CLI. Returning to a previously used lane resumes
  it natively and injects only the missed delta. Native sessions never
  cross profiles (INV-135). Silent conversation loss on any switch is a
  release-blocking bug of the same class as data loss. verify: continuity
  canary `[INV-137:a-b-a-continuity]`; lane checkpoint + packet-builder tests
  (`packages/orchestrator/src/continuity.test.ts`,
  `packages/daemon/src/threads.test.ts`); disclosure UI/CLI review.
