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
  `synthesize`, `audit`, `orchestrate` — the canonical `Intent` enum in
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

- **INV-030** The canonical modes are exactly `ask`, `plan`, `audit`,
  `agent`, `orchestrate` — five intents-on-a-thread. verify: `ModeKind` in
  schema; docs-truth mode-id check.
- **INV-031** Engine strategies are FLAGS on a mode, never modes of their
  own: best-of-N (`--n`), capped repair (`--attempts`), repair-to-clean
  (`--until-clean`), research swarm (`audit --swarm`), create-from-scratch
  (`agent --create`). verify: CLI help + docs-truth flag check.
- **INV-032** Old mode ids are not compatibility aliases; they hard-error at
  every wire boundary unless explicitly reintroduced in schema and docs.
  verify: canary `[INV-032:modes-canonical]`; CLI mode validation tests.
- **INV-033** `Agent` is the default composer/`claudexor agent` route on a
  project thread — in Agent the harness itself decides whether to answer or
  edit the tree (Codex/Cursor/Claude Code semantics); a no-project thread
  falls back to read-only `Ask`. `Orchestrate` is the orchestrator — an intent
  routed like reviewers, never a privileged harness. The retired verb
  spellings (`run`, `race`) hard-error with the new name (`agent`,
  `best-of`) — no compatibility aliases, same doctrine as retired mode ids.
  verify: orchestrator default-mode tests; UI intent menu review; canary
  `[INV-033:verbs-renamed]`.
- **INV-034** A thread is the Claudexor-owned conversation (runs are its
  turns); the vendor CLI session is a re-hostable cache that later turns
  resume natively. Thread, turn, and session mutations are fsync-before-ACK
  journal records; create and Exact Retry bind `Idempotency-Key` to the
  original request and never duplicate a turn. verify: thread journal restart
  and idempotency tests; session-resume orchestrator tests.
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
  conflated: the run tree under `.claudexor/runs/<id>/` is Claudexor's
  internal orchestration evidence, while the project's produced outputs (the
  repo `artifacts/` dir served via `/runs/:id/produced`) are user
  deliverables. Surfaces label which plane they show. verify: control-api
  produced/artifacts endpoint tests; UI Canvas review.

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
  never the operator's ordinary `~/.codex` or OS Keychain. verify: adapter auth
  isolation tests; setup capability receipts; routing paid-fallback tests.
- **INV-062** Raw secrets must not appear in run params, the command journal, task
  contracts, events, summaries, patches, PR text, logs, or docs. The PROMPT
  is included: a secret-like value inside the prompt text is hard-blocked at
  every ingress surface (CLI, POST /runs, thread turns, MCP, ACP, daemon
  enqueue) with a typed `inline_secret_rejected` error and remediation —
  prompts are durable artifacts and there is deliberately NO bypass flag.
  verify: secret-scan CI step; redaction tests; inline-secret rejection
  tests; canary `[INV-062:prompt-secret-block]`.
- **INV-063** Scoped harness homes/config dirs stay outside the mutation
  worktree so `git add -A` can never capture auth files, plugin downloads,
  sqlite logs, or transcripts into a patch. Where a containment exception
  exists (isolated-thread candidates keep scoped homes inside the thread
  worktree), an explicit ignore boundary provides the same guarantee and the
  mechanism is documented. verify: workspace env tests; T3 audit sweep.
- **INV-064** User attachments (images, files) are persisted only in a
  scoped store outside any worktree; attachment bytes never enter
  the command journal, task contracts, or `git add -A` scope. Direct non-thread
  `POST /v2/runs` accepts only absolute existing file paths; inline base64 is
  accepted only through thread/composer turns, where it is sunk to scoped
  files before a daemon job is queued. verify: attachment-resolver tests;
  control-api attachment DTO tests.
- **INV-065** An image-bearing run routes only to harnesses whose
  capability profile declares image input; a blind harness is refused
  pre-flight with an actionable reason — an attachment the model never saw
  must never look delivered. verify: vision-gate orchestrator tests.
- **INV-066** The agent-driven browser is a second live-egress channel and
  is treated like one: it is injected only when the run opted in, the
  harness declares `browser_tool`, web policy is not `off`, and the access
  profile allows it; the injection is disclosed, and navigation evidence
  lands in the run artifact tree. Harnesses without a wired injector
  honestly declare `browser_tool: false`. verify: browser-gate orchestrator
  tests; adapter manifest review.

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
  isolated envelopes under `.claudexor/workspaces/.../tree`, with the
  harness cwd at the envelope worktree. verify: workspace manager tests.
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
  initialized automatically (`.gitignore` seeded with `.claudexor/` first,
  then `git init` + a deterministic baseline commit), announced via a typed
  `project.git.initialized` event — never a refusal, never a silent
  mutation. verify: git-init workspace tests.

## 8. Spec-Driven Work Is First-Class

- **INV-080** When a task is ambiguous, Claudexor moves toward a frozen
  SpecPack: plan, ask clarifying questions, record user answers, freeze
  acceptance criteria and non-goals, then run against that contract. The
  Spec Interview is plan/draft owned, not a permanent top-level app
  identity. verify: interview engine tests; spec endpoints.
- **INV-081** A frozen SpecPack is a content-hashed contract: the engine
  verifies the hash when a run consumes a spec, and a tampered spec fails
  loudly instead of silently running against altered criteria. verify:
  spec tamper fence test.
- **INV-082** Frozen SpecPacks and repo config cannot carry protected-path
  approvals; operator approval is always supplied on the current run.
  verify: schema strictness test (SpecConstraints).

## 9. macOS UX Must Be Native, Honest, And Familiar

- **INV-090** The app is chat-first: ONE screen — thread list, conversation,
  persistent composer — with a run's detail in the trailing inspector, not a
  separate kitchen-sink of tabs. Users of Claude Code, Cursor, and Codex
  should feel at home: you just type; the first message starts a thread;
  turns run in-place so the next turn sees the work. verify: DESIGN_SYSTEM
  contract; visual QA checklist.
- **INV-091** The trailing region is a Workbench with two labeled planes:
  Run Detail (the run's tabs over internal run evidence) and Canvas (the
  project's produced outputs and a user-driven mini-browser on solid
  surfaces). This is the sanctioned extension of the one-screen doctrine —
  no third top-level screen. verify: DESIGN_SYSTEM; RootView review.
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
  delivery and orchestrate-apply go through the single `validateApplyGate`;
  race adoption applies only on a clean terminal; `revert_run` is
  divergence-fenced; thread apply requires the thread's HEAD run to be
  non-blocked/non-failed or covered by a typed operator decision. An
  unlisted mutation path is a release blocker. verify: mutation-path
  inventory in ARCHITECTURE; thread-apply head-run gate test (locked
  owner decision).
- **INV-114** A failed apply/adoption leaves the target tree restored, or —
  when restoration itself fails — reports the mutation honestly;
  `adopted:false`/`not_applied` must mean the tree is unchanged. verify:
  protected-apply conflict tests (byte-identical restore).
- **INV-115** Before an envelope-produced patch is applied or adopted —
  race winner or convergence result — it is re-verified in a fresh
  envelope (`git apply` to a clean base + configured deterministic gates
  there); the result is recorded in the decision, and a verifier
  infrastructure error blocks fail-closed exactly like a proven failure.
  A patch that cannot survive a clean base does not touch the live tree.
  In-place turns are exempt: their diff is produced against the LIVE tree,
  and a bare snapshot worktree (no gitignored deps) would false-block
  green work. Deterministic gates must be hermetic to the checkout for the
  verify re-run to be meaningful.
  verify: FinalVerifier tests + the final_verify apply-gate consumer tests
  (locked owner decision).
- **INV-116** Terminal run state and output readiness are separate
  (`succeeded|blocked|failed|not_converged` vs
  `pending|finalizing|ready|diagnostic`), and every announced run reaches a
  terminal event on every path — crash, cancel, pre-loop failure — so no
  observer waits forever. CLI and UI show the distinction. verify: canaries
  `[INV-116:output-ready-before-terminal]`, `[INV-116:cancel-fast]`,
  `[INV-116:stream-watchdog]`; the whole-strategy terminal net and
  interrupt-stamping tests.

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
- **INV-125** Release tags additionally pass the external triad + scope
  review gate on a pinned cross-vendor reviewer panel (at least three
  models from at least two vendors, pinned in local gate config);
  substituting or downgrading a pinned panel without an explicit
  acknowledged override is a hard error, and any override is recorded in
  the review summary. A whole-tree immune scan (docs-vs-code, dead
  surface, invariants-vs-tree) is a mandatory pre-release checklist step.
  verify: triad panel guard; CHECKLISTS Release section.

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
