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
  edited, or retired, and the marker is added only when the operator explicitly
  approved that change (CI enforces the marker; `scripts/concept-gate.mjs`).
- Change is not deletion. Wording may be clarified, but if removing the new
  wording leaves the original principle unrecognizable, that is a deletion in
  disguise — forbidden without an explicit operator-approved retirement. An
  invariant whose content moves elsewhere keeps its id as an absorbed pointer.
- Canary golden stories (`packages/canary`) pin a growing subset of these
  invariants as executable user stories tagged `[INV-NNN:…]`. When a canary
  fails, the product regressed: fix the product, never the story, unless the
  operator approved a `CONCEPT-CHANGE` for that invariant.
- Some invariants below encode locked operator decisions; their `verify:` notes
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
  (non-solid ledger) → `docs/BACKLOG.md` (deferred with operator decision) →
  `docs/AGENT_ONBOARDING.md` (agent orientation). A fact lives in exactly ONE
  of these; every other mention is a link. Mantras worth repeating live only
  here. Two prose docs describing the same behavior differently is a
  release-blocking docs bug, not a style issue.

## 0. Zen

Orientation for every contributor and reviewer. The numbered invariants are
the enforceable law; this list is the spirit they serve. When a proposed
change pulls against one of these lines, stop and find the governing
invariant or operator decision before proceeding.

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
  A raw model operation is a separate engine capability, not another agent or
  conversation mode: its caller owns the system prompt, history and tools.

## 2. Harnesses Are Not Roles

- **INV-010** Codex, Claude Code, Cursor, OpenCode, Antigravity CLI, raw APIs,
  and future adapters are harnesses. Roles are intents (`explain`, `plan`, `spec`,
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
- **INV-014** A model operation performs at most one provider generation.
  Adapters may prepare managed authorization and discover the exact account's
  model catalog beforehand, but never retry generation, switch the model,
  compact the conversation or execute tools. The existing command store,
  idempotency, cancellation and shutdown own its lifecycle; no second scheduler
  or attempt journal is introduced. The dispatch record is committed and flushed
  (`flushed()`) before the adapter may POST; an unavailable barrier leaves
  `not_started` with a typed problem and sends nothing. Status and result reads
  recover that same
  operation, and an unknown dispatch outcome is never a never-sent/free claim.
  Native continuation is retained exactly and bound to its actual account and
  model. Context metadata comes from that route, not CLI compaction policy;
  absent limits and costs remain unknown. verify: model-operations,
  model-routes and harness-codex model/responses tests.

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
  per parent (default 8), and one live daemon-owned paid-budget authority shared
  by the parent and every child. The flag grants permission; the parent may finish without creating
  a child. Only adapters declaring `capability_profile.mcp_injection` (claude,
  codex, cursor) can host the belt, and the engine projects belt readiness instead of a
  surface guessing it. A known failure BEFORE injection may continue as an
  ordinary Agent run only with durable requested/effective/used/reason/remediation
  facts and a visible warning. Once the belt descriptor was injected, an
  explicit startup failure is terminal on adapters with a startup receipt
  (claude, codex); cursor hosting is pre-spawn config injection with NO
  startup receipt yet — a pre-spawn injection failure refuses typed, while
  the live E2E and a mapped vendor startup-status surface are its recorded
  acceptance conditions in `docs/FEATURES.md`. An unrecovered non-ok result from an
  exact injected belt operation is also terminal for the Agent outcome: this is
  the required-capability exception to INV-043. An envelope deliverable stays
  available only as diagnostic evidence and cannot succeed or be auto-adopted.
  If an explicitly in-place lane already wrote the live tree, the failed turn
  instead records those unavoidable bytes as `adopted:true` plus
  `applied_review_blocked`, emits the WorkProduct event before the terminal, and
  preserves a revert anchor; it never misreports the tree as untouched.
  Secret-like output takes no exception here: the live bytes stay where the
  harness wrote them, the WorkProduct and its revert anchor are recorded as
  for any other turn, and INV-062 hides the matches only in persisted copies.
  The diff owner still inspects immutable binary preimages and postimages as
  well as text (non-Git binary stubs through a bounded no-follow descriptor),
  but only to decide what a saved copy must hide. A capture that could not
  observe the live changes at all remains a sanitized `adopted:true`/
  `applied_review_blocked` receipt with no patch and no anchor; nothing is
  rolled back and it never claims false revertability. A later
  success recovers only the same invocation: tool + kind
  + target must match, and matching non-null tool-use ids are additionally
  required when both sides carry them; the tuple remains the compatibility key
  when either id is absent. The Delegate receipt remains `used:true` because it
  records the path, not its success. Neither failure may silently degrade or be
  counted as a native vendor subagent.
  Every child is bound to the original normalized user-project root rather than
  the parent's execution envelope; raw tool arguments cannot redirect it.
  Claudexor children carry server-owned Delegate lineage; model prose never
  establishes provenance. verify: `ModeKind` in schema; docs-truth mode-id
  check; delegation capability/outcome/lineage + failed-start tests; canary
  `[INV-030:orchestrate-retired]`.
- **INV-031** Engine strategies are FLAGS on a mode, never modes of their
  own: best-of-N (`--n`), capped repair (`--attempts`), repair-to-clean
  (`--until-clean`), research sweep (`ask --deep-scan`), create-from-scratch
  (`agent --create`), delegation belt (`agent --delegate`), council planning
  (`plan --council`, with `--n` of at least two, bounded by the operator-configured Council capacity, legal only under council). verify: CLI
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
  resume natively. Read-only thread turns (ask/plan), and every in-place turn
  of a delegated thread, keep DURABLE per-lane native sessions — a lane is a
  (thread, harness, profile) triple with a persistent scoped home under the
  project runtime namespace — and never dispose them with the run; the next
  turn of the same lane resumes that session, and only thread purge,
  credential-profile deletion, or orphan retention removes a lane home. Thread,
  turn, and session mutations commit to the engine store before ACK and survive
  an engine process crash or kill. Power loss or a kernel panic may discard
  commits after the last completed flusher barrier (INV-143). Create and Exact Retry
  bind `Idempotency-Key` to the
  original request and never duplicate a turn. An already accepted command
  remains the replay authority after later turns; a historical runless turn
  with no accepted command is never admitted after it stops being the thread
  tail. Exact Retry is a fresh linked command with fresh preflight; Run Again is an editable draft with explicit
  differences. verify: SQL thread restart and idempotency tests; run retry
  and draft tests; session-resume orchestrator tests; delegated lane-home tests
  (`packages/orchestrator/src/delegatedHome.test.ts`).
- **INV-035** A v2 project has a stable daemon-owned id bound to one canonical
  local root. The v2 registry starts empty, never imports v1 state implicitly,
  and registration is request-idempotent; relink moves the same project id
  instead of creating a second authority. Registered project commands, threads,
  turns, and sessions live in that stable id's partition generation (`pid`) in
  the shared engine store. State, idempotency and cursors are generation-scoped;
  archive and quarantine retire generations without deleting their rows.
  No-project state remains global; physical database corruption requires
  whole-store recovery. Every public CLI mode and REPL turn enters
  through the managed daemon; daemon startup failure never creates a second
  in-process run/thread authority. verify: SQL project restart, partition
  routing/idempotency/recovery isolation, relink tests, `/v2/projects` API tests,
  and canary `[INV-035:cli-all-modes-daemon-owned]`.

## 5. Evidence Beats Summaries

- **INV-040** Every hard claim needs evidence: a file, diff, command, log
  line, event, doctor report, run artifact, or source reference. Model
  prose is context, not proof. verify: review protocol; reviewer evidence
  preflight in reviewEngine.
- **INV-041** Git diffs come from git in the isolated worktree or live in-place
  target, never from model edit narration. Directory work products record observed
  file bytes in a digest-bound manifest; a text diff is only a preview. Copied
  file results retain the selected baseline and complete output bytes for exact
  delivery, while direct effects disclose any unknown preimages. Captured diffs must round-trip:
  the exact patch object recorded as the work product must `git apply` cleanly to
  the base it was captured against (no silent corruption — CRLF, quoted
  paths, binary — between capture and delivery); persisted copies may be masked
  under INV-062 and are display-only. verify: workspace diff
  tests incl. the CRLF and binary round-trip cases (byte-faithful raw
  capture; `git diff --binary`).
- **INV-042** Reviews are trusted only when reviewer output is parseable,
  route proof is observed (stream- or transcript-observed model, never an
  argv echo), reviewer telemetry is persisted, and the reviewer read the
  candidate evidence files rather than a giant prompt-only diff. A reviewer
  workspace is an explicit candidate projection, never a recursive copy of
  the live checkout: Git-visible files plus exact diff-touched paths, subject to
  the shared sensitive-resource boundary, are the candidate plane; the
  sealed/redacted evidence packet is a separate explicit plane. Gitignored
  local state that is absent from the diff never crosses the reviewer boundary.
  For an explicit directory result, the complete selected file manifest supplies
  the candidate inventory instead of Git membership. Retained unchanged inputs
  and observed output bytes remain available, with baseline/output evidence in
  the explicit packet and the same sensitive-resource boundary. A selected file
  is not excluded merely because its directory name usually denotes generated
  output; unselected source siblings are never implicitly copied.
  verify: reviewEngine route-proof,
  candidate-inventory, and ignored-sibling tests; per-reviewer artifact
  checklist.
- **INV-043** Tool success is evidence, not prose. `tool_result.is_error ===
  true` is a hard warning that blocks a green verified claim unless later
  verified recovery exists, but it does not by itself discard a produced
  deliverable. Recovery must be attributable to the failed operation, not
  merely a later call of the same-named tool — the engine keys recovery by
  tool + kind + target and, when both records carry one, matching tool-use id;
  the tuple remains the compatibility fallback for legacy adapter evidence.
  verify: attemptTelemetry recovery-keying tests.
- **INV-044** The engine separates terminal state from tool hygiene: a
  completed answer/report/patch may succeed with warnings. Optional web that
  is unused, denied, unavailable, or errors remains evidence/warning telemetry
  and never decides terminal success; terminal harness errors, failed
  apply/verify steps, explicitly persisted required-web contracts, and required
  gates still block. verify: outcome-dimension telemetry tests.
- **INV-045** Web answers are web-backed only when `WebSearch`/`WebFetch` or
  equivalent evidence was observed; a memory answer after a failed web tool
  is partial/unverified. verify: web-evidence telemetry tests.
- **INV-046** Transient infrastructure failures are typed adapter evidence,
  never guessed from model prose. The orchestrator may spend a bounded retry
  budget only for typed transient failures with no produced deliverable: a
  RETRY replays the original prompt on a fresh session, so it is admitted
  only before any work. In Agent and Ask, after progress (an accepted answer,
  agent activity, a file change or a diff in ANY try of the attempt) the attempt
  never replays — it CONTINUES the same work through a disclosed carrier (the
  native session on the same or the next account, or a fresh session
  re-grounded by the evidence index), bounded per account by the same retry
  budget and across accounts by the pool; the terminal of unfinished work
  carries its continuation facts (`resumable`). The separate Plan pipeline
  keeps today's behavior and does not yet emit these in-run continuation facts.
  verify: transient-retry
  orchestrator tests;
  `packages/orchestrator/src/inrun-continuity.integration.test.ts`.
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
- **INV-061** Explicit `subscription` never falls back to an API key. `auto`
  is subscription-first for Codex, Claude, and Cursor: the enabled account
  rows' native sessions (the INV-135 pool) are preferred, and a paid route is
  eligible only under the typed paid-fallback policy. A registered pool that
  is exhausted (or wholly disabled) is NOT a silent paid-fallback trigger:
  the run terminalizes typed (`credential_pool_exhausted` + earliest reset,
  INV-135) and the paid route serves it only under the EXPLICIT `api_key`
  preference — taken explicitly and disclosed, never spawned back into an
  exhausted or excluded login, never silently under `auto` (the same
  principle as the kind-aware `limit_action: auto`, which resolves a metered
  subject to `fail`: `auto` never silently spends money).
  Requested/effective credential route and
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
  Raw model calls and Agent runs use the same managed profile. The official
  CLI owns authorization refresh and persistence; the model adapter reads only
  current transient access material from that profile. No ambient host login,
  copied auth store or independent refresh mechanism is introduced. Model
  account Auto keeps a suitable preferred profile then uses the existing pool;
  pin never rotates or falls back to an API credential.
- **INV-062** Raw secrets must not appear in run params, the command journal, task
  contracts, events, summaries, persisted patch copies, PR text, logs, or
  docs. The PROMPT
  is included: a secret-like value inside the prompt text is hard-blocked at
  every ingress surface (CLI, POST /runs, thread turns, MCP, ACP, daemon
  enqueue) with a typed `inline_secret_rejected` error and remediation —
  prompts are durable artifacts and there is deliberately NO bypass flag.
  Agent OUTPUT is a different axis: it is not rolled back, discarded or
  failed for containing secret-like text. The changed files keep the exact
  bytes; persisted and served copies hide the matches; the run discloses
  paths and counts, never values. A redacted copy is display-only — apply
  binds to the digest of the exact bytes and reads the private exact patch
  object or refuses typed (`patch_exact_bytes_unavailable`). `pr` delivery
  never publishes secret-like text. A capture that cannot observe the
  changes is the only capture-time refusal, under its own name.
  verify: secret-scan CI step; redaction tests; inline-secret rejection
  tests; canary `[INV-062:prompt-secret-block]`; keep-and-mask tests
  (`packages/orchestrator/src/persistedPatch.test.ts`,
  `packages/orchestrator/src/secretDiff.test.ts`, the orchestrator in-place,
  isolated, binary, raster and best-of runs, the delivery exact-digest and
  `pr` refusal tests, the Control API exact-object Apply and
  `patch_exact_bytes_unavailable` tests, the thread delivery tests).
  Model-purpose request/response resources are the narrow content boundary:
  caller-supplied conversation bytes pass without secret-like-text filtering,
  just as on a model API. They cannot be used as ordinary Agent attachments.
  This is not a general bypass flag. Engine OAuth and control credentials are
  never injected into that content, and the journal retains only compact
  identities, digests, state, usage and cost evidence, never the conversation.
- **INV-063** Scoped harness homes/config dirs stay outside every mutation
  worktree, in the external per-project runtime namespace, so `git add -A`
  can never capture auth files, plugin downloads, sqlite logs, or transcripts
  into a patch. verify: workspace env tests; T3 audit sweep.
- **INV-064** User attachments (images, files) are persisted only in a
  daemon-owned store outside any worktree; source paths/base64 are never runtime
  authority. Upload streams to a write-through temporary file. Finalize commits
  its pending binding (digest, key, request digest and result) before consuming
  that file, publishes digest-bound immutable bytes by hard link, and removes
  the part only after the flusher confirms publication. Run/turn requests accept
  only the returned resource IDs. verify: resource-store and control-api upload
  tests.
  Model resources use the same upload/blob owner with atomic, replayable
  finalization. Request bytes are released when the operation terminates;
  response bytes after explicit digest-bound acknowledgement, or 30 days from
  readiness if unacknowledged. The compact command receipt survives cleanup:
  repeat retrieval cannot turn into another generation. Existing maintenance
  reclaims crash residue; the caller retains conversation history.
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
  spawn with — host-environment readiness never stands in for it. Credential
  transport, identity scope, relocation, profile cardinality, and cleanup are
  effective host-platform facts, not properties inferred from a profile HOME.
  Where a
  vendor's primary credential store is outside a generic scoped HOME, the
  adapter may expose only a declared MINIMAL vendor-specific bridge (Claude
  on macOS: a disposable Claude-only child HOME whose sole host bridge is
  `Library/Keychains`; a Claudexor-owned `CLAUDE_CONFIG_DIR` selects the exact
  default or profile-specific Keychain item). Ordinary `~/.claude` is never
  read, written, or used for Claudexor native setup/runs. Other harnesses never
  receive that bridge, and all writable vendor state stays scoped. Codex remains portable through
  its file-only `CODEX_HOME` seed. Cursor accounts are portable through the
  vendor's own FILE credential store inside each row's Claudexor-owned HOME;
  the host OS-Keychain login is retired as a transport (INV-135) — it is
  never probed, bridged, or claimed as a route. Antigravity profile HOME is a
  relocatable credential store only where the vendor actually stores the
  credential there. On Darwin, Claudexor may create the empty profile-local
  `Library/Keychains/login.keychain-db` container before agy starts. The
  vendor writes and reads its own fixed item, the host Keychain is never
  bridged. An unsafe profile path refuses the child before SecurityAgent; an
  operational setup miss leaves the vendor's file fallback available. The
  empty DB is bootstrapped under a neutral filename before adoption as
  `login.keychain-db`, avoiding the user search-list side effect of a direct
  login-keychain create. On
  Windows its login credential is an OS-user-scoped
  vendor Keychain item: HOME still scopes mutable vendor state, but it does
  not create independent Google identities, so the effective policy permits
  only one enabled binding and deletion leaves the vendor credential unchanged
  with an explicit disposition. The doctor names the real cause and the
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
  harness cwd at the envelope worktree. Explicit directory execution uses either
  the selected live folder or an isolated copy of the caller-selected footprint,
  without initializing Git. Stable project identity and execution address remain
  separate facts. The repository's `.claudexor/`
  remains user-owned versioned config. verify: workspace manager tests.
- **INV-073** Chat thread WRITE turns run IN-PLACE in the thread's
  explicit execution tree — the live project for an `in_place` thread, the
  thread's persistent worktree for an `isolated` thread, or the caller-owned
  workspace a `delegated` thread binds once at creation — and the surface
  must disclose which applies. A read-only turn reuses an existing isolated
  worktree, but before the first write turn it reads the stable project
  directly and does not materialize Git state. Every turn and mode of a
  delegated thread reads and writes only its bound workspace: Claudexor never
  provisions, promotes, resets, applies, deletes, or falls back from it, and an
  unavailable workspace is a typed refusal. verify: thread schema defaults;
  in-place, lazy isolated-workspace, and delegated-workspace tests
  (`packages/cli/src/thread-delegated-workspace.test.ts`); canary
  `[INV-073:delegated-thread-two-rounds]`.
- **INV-074** Absolute host paths such as `/tmp/...` are not project diffs
  and do not prove project success. Project tmp requests default to
  project-local `tmp/...` or run artifacts unless the user explicitly
  selects a verified host-side-effect mode. verify: tmp-semantics telemetry
  tests.
- **INV-075** Git-backed mutating run shapes need a Git boundary. A non-git
  project folder is initialized automatically (`git init` + a deterministic
  baseline commit) when the first mutating isolated turn or another Git-backed
  write envelope needs it. Selecting an isolated workspace does not itself
  authorize mutation: read-only Ask, Plan, and Agent turns reuse an existing
  worktree or read the stable project without creating one. Initialization is
  announced via a typed
  `project.git.initialized` event — never silent. Exception: a root equal to
  the user home directory or a filesystem root — or one that cannot be
  classified (no safe home resolves, or the root itself does not physically
  resolve) — is refused with a typed error naming the remediation BEFORE any
  mutation, instead of being initialized; a home that is already a healthy
  repository is respected untouched.
  Explicit directory workspaces, live or copied, need no Git boundary and never
  initialize the original folder or change the requested run strategy. Supported
  in-place paths that do not cross a Git boundary remain available without
  initialization. Claudexor never creates or edits the project's
  `.gitignore`; repo `.claudexor/` is user-owned state and runtime stays
  external. verify: git-init, boundary-root refusal, lazy isolated-thread,
  run-applicability, and gitignore non-interference workspace tests.

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
  retried implement can never silently run without its plan, and a client
  can never mint the reference (POST /runs rejects planRef). verify:
  `[INV-081:plan-brief-materialized]`, `[INV-081:plan-hash-mismatch]`,
  `[INV-081:plan-missing]`, `[INV-081:planref-boundary]`; thread-turn
  plan_hash/409 tests.
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
  not a per-run inspector: three always-present tabs — Changes, Artifacts,
  Evidence — aggregated across the thread's runs on solid surfaces, plus a
  remote-only Terminal tab on remote threads. Selecting a chat
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
  routing tests. Locked operator decision.
- **INV-104** A model list is evidence of PRESENCE at one runtime identity,
  account and time. Whether an absence from it is evidence too is the
  HARNESS's own declaration (`model_inventory_absence`), honoured wherever its
  lists are read — the live inventory and the manifest known-good list alike,
  at settings-write, run preflight (typed failure WITH artifacts before any
  CLI spawns), doctor readiness and the explicit reviewer-resolution path,
  while `claudexor models` shows each list's source and hint marks and
  automatic reviewer selection keeps the zero-cost skip stated below.
  `authoritative` (the declaration a silent manifest gets) keeps the
  strict rule: a model outside the list is refused with the harness, the model
  and the truth source named, never forwarded to the vendor CLI to die as an
  opaque native error, and a harness with no list refuses every explicit model.
  `advisory` (claude: the picker is an alias menu of one binary version plus the
  account's bootstrap rows; codex: a `model/list` reply carries no provenance
  and the CLI serves a bundled default list when its remote fetch times out;
  cursor: `--list-models` is a fail-soft menu blind to routing variants;
  agy: the account menu can omit newer models) means
  presence still admits while absence decides nothing: on a model-id effort
  carrier (Cursor, Antigravity), an effort preference selects the listed level
  variant of the requested id's family from the running account's list (owner
  decision 2026-10-05 «2. B»); otherwise the EXPLICIT model is forwarded
  byte-identical. The vendor accepts or refuses it, and the consumer
  that admitted it says so once — the settings read-back carries `notes`, the
  readiness row carries the note in its detail, the per-spawn gate discloses a
  status event. Hint ids count as present. No list is ever substituted for
  another to admit a model; model truth is surfaced to UIs (`source: api |
  manifest`); known-model hints carry a `verifiedAgainst` freshness note
  checked by the model-hints-freshness gate; automatic reviewer selection still
  skips an unlisted family at zero cost. Raw model sources declare their own
  absence policy: Codex HTTP operations forward an explicit unlisted model
  after a valid account catalog read at a named client version. Missing metadata
  remains unknown; ordinary explicit effort is sent unchanged with unverified
  capability disclosure, while known wire limits, authentication and model-scoped
  quota still bind. A failed catalog read is never a successful empty catalog.
  Negotiated requested-model admission tells callers they may attempt the model,
  not that it was listed or generation-proven; wait/readiness readers use the same
  declaration. Raw-api and opencode stay authoritative by declaration, not by
  proof of completeness.
  Residuals, disclosed: the explicit reviewer panel forwards without the
  run-event disclosure (its spawn does not pass the per-spawn gate); on the CLI
  run path a vendor model refusal arrives as an untyped error carrying the
  vendor's text; a mistyped explicit model on an advisory harness costs one
  spawn, and bounded account failover may spend one start per account before a
  typed account-independent stop exists. verify: canaries
  `[INV-104:model-truth-refusal]`, `[INV-104:models-manifest-fallback]`,
  `[INV-104:settings-write-strict]`, `[INV-104:settings-write-advisory]`;
  settings-service tests; modelGovernance preflight tests;
  `packages/core/src/model.test.ts`; `packages/cli/src/model-truth.test.ts`;
  `packages/orchestrator/src/reviewerPanel.test.ts`;
  `packages/harness-codex/src/astra.test.ts`. Operator decisions 2026-09-21
  (strict wherever a truth source can prove absence) and 2026-09-24 (absence is
  the harness's declaration; claude, codex and cursor declare advisory), extended
  to account-scoped Antigravity discovery by owner decision 2026-10-04. Known
  model-family quota scopes still apply to newly named models; an unknown
  family stays disclosed as unknown and never borrows another family's limit.
- **INV-105** Per-harness knobs a manifest does not support are disclosed as
  `ignored_settings` on `harness.started` — never silently dropped. This
  covers max_turns, tool lists, and effort (an empty declared ladder), except
  that on a model-id effort carrier (Cursor, Antigravity) an effort preference
  selects the listed level variant of the requested id's family from the running
  account's list (owner decision 2026-10-05 «2. B»); otherwise the setting is
  recorded as before. An explicit MODEL reaches a route only where its truth
  source could not refuse it (INV-104), and then the run says so: the per-spawn
  gate discloses the
  unverified model, and the effort a model absent from the probed list resolves
  against the sibling ladders is sent verbatim, clamped-and-disclosed, or
  dropped-and-disclosed — never silently changed. verify: knob
  disclosure tests incl. the INV-105 effort-disclosure test;
  `packages/harness-codex/src/astra.test.ts` stale-list effort resolution.

## 11. Delivery Is Server-Owned

- **INV-110** Inspect/apply/check use control-api endpoints and run
  artifacts. The UI must not invent local accept/rebut/apply state.
  Read-only modes do not expose patch apply controls. Every product endpoint
  is under `/v2`; official clients negotiate `POST /v2/handshake` and send the
  negotiated major, while unversioned product aliases are refused. verify:
  control-api handshake/catalog tests; docs-truth catalog parity; UI review.
- **INV-111** Apply is allowed only for successful runs with a successful
  decision record and a digest-bound patch or copied-files WorkProduct for the original verified repo
  root — with one typed, server-owned exception: an operator decision
  (`POST /v2/runs/:id/decision`, `accept_risk`/`override_needs_human`)
  persists an auditable, patch-hash-bound record that unblocks apply for a
  `blocked` run; a mutated patch invalidates the override. The human
  decision is never client-faked state. Direct file effects are already in place
  and do not offer a second apply or an unproved full rollback. Explicit discard
  ends pending copy delivery without applying or reverting files; existing
  retention owns the retained result. Partial application preserves custody of
  unselected changes. verify: apply-gate tests; canary
  `[INV-112:apply-needs-verified-review]`.
- **INV-112** Ordinary Agent work defaults to no internal model review,
  independently of how its executor was selected. Explicit review controls
  request review; Best-of and until-clean retain it, while capped repair
  defaults to review unless explicitly disabled. The resolved intent is
  persisted separately from the observed result. Only a recorded opt-out
  permits successful unreviewed work to be applied normally, with honest
  `not_run` review facts and no extra risk-acceptance step for that absence.
  Required checks, independent policy findings, work-completion requirements,
  and fresh patch-integrity verification remain enforced. Historical records
  without the intent field retain the previous review-required meaning.
  Requested review must actually pass; it is never fabricated as approved.
  A clean cross-family verified review is sufficient verification even
  without a deterministic test gate. `DecisionRecord.verification_basis`
  records actual evidence, including deterministic checks or none for an
  unreviewed result; an opt-out is not verification evidence. verify:
  arbitration verification_basis tests; `packages/orchestrator/src/review-policy.test.ts`;
  `packages/canary/src/review-policy.story.ts`; historical replay and delivery tests.
- **INV-113** Every path that can mutate the live project tree is
  enumerated in ARCHITECTURE with its fence, and each has one: envelope
  delivery, manual apply, race adoption, and thread apply
  go through the delivery-owned fresh verifier immediately before mutation;
  copied directory files use the same delivery owner with per-file preimages and
  complete content artifacts, while direct directory execution records observed
  effects without pretending they await application;
  (the retired `orchestrate-apply` path is gone — delegation sub-runs carry
  no apply tool, so the parent integrates their results through the ordinary
  apply path, CONCEPT-CHANGE(INV-113));
  race adoption applies only on a verified clean terminal; `revert_run` is
  content/preimage-fenced; thread apply considers every run not yet recorded
  as delivered and is serialized against active turns; the thin `CLAUDE.md`
  bridge (an `AGENTS.md`-only project-root mutation independently fenced from
  Git admission, CONCEPT-CHANGE(INV-113)) is exclusive-create + no-follow
  so it never overwrites a hand-written file or writes through a symlink, and is
  written in TWO places — the durable project root (announced via a typed
  `project.claude_bridge.created` event; skipped for read-only modes AND
  `--in-place` targets) and each
  git-mode ENVELOPE worktree (an envelope materializes only the committed tree,
  so an untracked project-root bridge never reaches a candidate; the envelope
  write emits no event and is EXCLUDED from the candidate patch ONLY when
  Claudexor created the bridge THIS run AND its bytes still equal
  `CLAUDE_BRIDGE_CONTENT` exactly (A-3), so a candidate-authored `CLAUDE.md` — or
  any candidate EDIT of the bridge, even one that keeps the ownership marker —
  differs from those bytes and IS captured in `patch.diff`). An
  unlisted mutation path is a release blocker. verify: mutation-path
  inventory in ARCHITECTURE; delivered-prefix and active-turn thread-apply
  tests; claude-bridge exclusive-create/no-follow/race/idempotency tests +
  envelope-bridge patch-cleanliness test (locked operator decision).
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
  there) immediately before the target preimage check; a copied directory result
  instead verifies its manifest, full content hashes, and reproduction on the
  retained selected baseline through that same verifier owner. The result is recorded
  in the decision/receipt, and a missing, stale, or failed verifier
  infrastructure error blocks fail-closed exactly like a proven failure.
  A patch that cannot survive a clean base does not touch the live tree.
  In-place turns are exempt: their diff is produced against the LIVE tree,
  and a bare snapshot worktree (no gitignored deps) would false-block
  green work. Deterministic gates must be hermetic to the checkout for the
  verify re-run to be meaningful.
  verify: FinalVerifier tests + the final_verify apply-gate consumer tests
  (locked operator decision).
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
  review" (QA-036). A hard wall-clock deadline keeps lifecycle `cancelled`
  because the process was stopped, but its typed `wall_clock_exceeded` reason
  presents as "Time limit reached" and as an ACP refusal; an explicit Stop
  remains `user_cancelled` and presents as cancelled. Surfaces never collapse
  those two reasons or rewrite the lifecycle to express presentation. Every
  announced run reaches a terminal event on every path — crash, cancel,
  pre-loop failure — so no observer waits forever. CLI and UI show the axes
  through the one projection owner (labels, exit code, needs decision). verify:
  canaries `[INV-116:output-ready-before-terminal]`,
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
  problem. A new restriction bears the burden of proof: identify the
  demonstrated marginal danger and common path it affects, then prove the
  promised capability still works in a production-shaped positive E2E. A
  denial-only or policy-shape test cannot certify a restriction; capability
  loss blocks it. verify: review protocol scope checks; affected-path battery.
- **INV-121** Meta-solutions over patches: data-drive from declared
  capabilities, single producers with translational consumers, typed
  contracts over hardcoded enums-in-logic — so future
  values/harnesses/modes work without re-patching. Before closing any bug,
  ask the class question: "if this fix had existed earlier, could the same
  failure class have reached us through another surface?" If yes, fix the
  class. Generalize only from multiple reachable surfaces or a broken
  contract/SSOT boundary; a theoretical adjacent edge case is not evidence
  for a broader mechanism. verify: review protocol; reference example: the
  effort-ladder normalizer.
- **INV-122** SSOT/DRY/SOLID as pragmatic constraints: one owner per
  contract, no duplicated business rules across surfaces, no config path
  that lets a project self-grant sensitive powers. Existing trust, provenance,
  review, custody, rescue, and rollback controls count when judging marginal
  risk; do not duplicate them with a weaker second boundary. Prefer the broad
  capability plus explicit residual disclosure unless evidence shows those
  controls are insufficient. verify: review; trust gating tests; positive
  capability-preservation tests.
- **INV-142** Retained-command reads name an address or a bounded keyset page
  before public projection. Collection answers contain summary facts and a
  redacted prompt preview, never unrelated prompt bodies, instructions or full
  results. Full detail and Exact Retry remain addressed; transitive cancellation
  stays uncapped, and the synchronous durable enqueue owns successor admission.
  This bounds transport amplification, not resident journal history. verify:
  `[INV-142:addressed-reads]`;
  `packages/daemon/src/command-list-select.test.ts`;
  `packages/daemon/src/addressed-command-read.test.ts`.
- **INV-143** One SQLite engine store per data root owns command, conversation,
  resource metadata and event state.
  Normal row mutations commit synchronously under WAL `synchronous=NORMAL`;
  their request path uses write-through external files without Node storage-sync
  calls on the request thread. A separate flusher proves generation-numbered
  power-loss barriers for committed state and registered directory entries;
  `flushed()` waits for that proof. A checkpoint result alone is not a barrier,
  and synchronized backfill precedes WAL reuse. Maintenance has its own worker.
  State tables are projections; live scoped event streams contain only retained
  rows, so a superseded row need not be delivered. Receipt lifetime is separate
  from its stream copy. Collection reads omit bodies and command retention uses
  bounded indexed queries. Legacy journals and unreplayed upload-key files remain
  read-only migration evidence/authority and are not deleted by engine retirement.
  Integrity checking after admission does not promise to detect every index
  corruption before a read. verify: `packages/daemon/src/store/durability.test.ts`;
  `packages/daemon/src/store/main-thread-sync.test.ts`; flusher generation,
  retention query-plan, importer and recovery tests.
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
- **INV-125** Repository releases require a complete independent adversarial
  review of the exact candidate and a disposition of every finding. The
  responsible maintainer, including an explicitly authorized coding agent,
  reads the report, verifies accepted findings, and confirms release readiness.
  Any independent human or AI reviewer may provide the report; no model brand,
  family pair, concurrent execution interval, or signed review attestation is
  required. Review covers the complete candidate and accepted intent, not only
  isolated snippets. Corrections receive focused tests and delta review; another
  full wave needs a material architectural or authority change, and a third full
  wave needs an explicit owner checkpoint. Reviewer preference never overrides
  INV-139. The ordinary PR or CI evidence contains the report and disposition;
  private user dialogue stays in the private review packet. Publication binds
  the confirmed candidate to successful CI and promotes those exact artifact
  bytes. Platform checks belong in CI; local macOS and Cursor sessions are not
  contributor prerequisites. Historical signed reviews remain verifiable as
  archives, not current publication authority. Runtime-update signatures,
  archive identity/checksums, and Apple signing/notarization remain enforced.
  verify: `scripts/verify-release-input.mjs`; `scripts/release-workflow-check.mjs`;
  CHECKLISTS Release + Review Protocol sections.
- **INV-138** Derived surfaces are generated, never hand-maintained:
  operation catalogs, endpoint docs, capability/parity matrices,
  per-subject refresher lists, and similar projections are produced from a
  single declared source (route descriptors, adapter manifests, the profile
  registry). A hand-edited shadow of a generatable artifact is the same
  defect class as a staged field. verify: generated-catalog diff gates;
  review question "what declaration produces this list?".
- **INV-139** Review finds defects; it does not author concept. A blocking
  finding must cite a violated invariant or operator-approved criterion, carry
  reproducible evidence, and be reachable in the default configuration;
  reviewer `proposed_fix` text is advisory; consensus without evidence
  blocks nothing; later waves cannot open blockers on unchanged code
  without new evidence. Operator decisions and this Bible outrank reviewer
  preference — a finding that re-litigates a recorded operator decision is
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
- **INV-135** UNIFIED ACCOUNTS: every credential identity of a harness is a
  named registry row — a durable NON-SECRET entry {profile_id, harness_id,
  display_name, credential_kind, isolation_locator|secret_ref, enabled}.
  Secret material lives only in the row's Claudexor-owned store dir or the
  namespaced secret store; readiness lives only in the doctor's projection.
  There is NO separate "default" / "CLI login" account type: a DETECTED
  legacy default-store login (claude/codex) auto-registers at daemon start
  as an ordinary `<harness>-default` row (bytes never move; progress is a
  crash-recoverable per-harness phase file OUTSIDE config.yaml, and an
  incomplete migration refuses that harness's runs typed while others keep
  working), and `auth login <harness>` is bootstrap sugar into that row —
  the bootstrap row has no routing privilege. The vendor's ordinary host
  stores (~/.claude, ~/.codex, the host Cursor Keychain login) are never
  read, probed, or mutated; cursor accounts live only in isolated
  file-store rows (operator decision D-U3: host CLI logins disappeared).
  **CONCEPT-CHANGE(INV-067, INV-135):** registry rows remain the one account
  model, while their effective identity isolation and cleanup policy is
  platform-declared. A platform may cap enabled rows when the vendor exposes
  only one OS-user credential (Windows Antigravity: one); create and enable
  enforce that cap atomically. A pre-existing over-cap set stays loadable but
  is typed `credential_profile_ambiguous`: targeted routing, setup, quota, and
  `next_up` fail loudly without selecting, probing, disabling, or deleting a
  row until the operator disables extras.
  ONE resolve owner (the orchestrator) resolves the per-harness EFFECTIVE
  account by the operator-locked order: (1) an explicit per-run/per-thread pin
  is STRICT — unknown/disabled/harness-mismatched ids refuse typed, a fresh
  exhausted window refuses typed (`subscription_window_exhausted` + reset
  time), and a pin never silently rotates; (2) an unpinned THREAD turn stays
  on its durable bound account — derived from the thread's own lane
  evidence, never a second hand-maintained record — while that row is
  ready, and moves to a pool sibling ONLY with a disclosed lane switch;
  (3) otherwise the quota-aware POOL of enabled+ready subscription rows
  routes the run: fresh model-applicable headroom descending, unknown/stale
  quota after known-positive headroom but before exhausted (stale quota
  never authorizes routing — D3; an OBSERVED live block — a reactive
  vendor-limit cooldown or spent window, stale-but-live included — ranks a
  row exhausted with its release instant until superseded). A newer recognized
  authenticated primary observation can retire an older unclassified refusal
  for that subject and route, including an early purchased or vendor-granted
  reset; unknown usage is never zero. Independently scoped restrictions remain
  unless corresponding evidence replaces them. The same durable projection
  governs every consumer and survives restart. A row that recently answered this
  model's request with a different model (a live, self-expiring
  model-substitution observation), or whose session an unpinned run started
  on it recently ended before any progress for this same requested model (a
  live, self-expiring pre-progress refusal observation, scoped to that exact
  account and requested model and never recorded by a pin), ranks after
  every other selectable row, oldest observation first, and is never
  excluded by it; deterministic profile-id tie-break.
  **CONCEPT-CHANGE(INV-135), #363:** an unpinned choice is admitted on FRESH
  readiness, with one bounded exception for Cursor rows: when a row's
  `cursor-agent status` probe did not answer within its own budget, that row
  store's last POSITIVE status answer, if younger than five minutes, may admit
  the row to an UNPINNED choice (bound row, pool, rotation, `next_up`). The
  row stays disclosed as stale unknown — never a fresh pass, never an
  identity — and a spawn on it says so. A logged-out answer from that store
  or any Claudexor-handled credential mutation revokes it. No positive answer,
  an expired one, any other probe failure, and an explicit pin keep the
  strict behavior: a pin is never admitted on it, and every other stale
  observation still serves only an already selected route. Rationale: an
  unanswered probe is not vendor evidence of either state, whatever delayed
  it; the row's own recent positive answer with no observed logout since is
  the best evidence at hand, and refusing it let unanswered probes alone
  report "no ready account". The exception widens only unpinned
  availability, where a wrong guess meets the pool's ordinary failover,
  and leaves the pin contract
  unchanged. The per-harness `limit_action` stored default is the kind-aware
  `auto` — it RESOLVES at decision time to `rotate` for subscription
  (`local_session`) subjects and `fail` for metered API-key or unknown
  routes, while explicitly persisted `fail`/`ask`/`rotate` keep their exact
  meaning and stored files are never rewritten (only the interpretation of
  an ABSENT key changed) — so a pool row's typed vendor limit fails over to
  the next ready pool sibling out of the box, never across credential kinds
  and never for a pin. An empty or exhausted pool is a TYPED TERMINAL: the
  run refuses `credential_pool_exhausted` (category `harness_unavailable`)
  carrying the pool's EARLIEST known reset, before the transient machinery
  can burn same-profile retries on an already-refused subject — waiting for
  the window is the default. The policy-governed API-key fallback from
  INV-061 may serve the exhausted pool ONLY over that terminal verdict and
  ONLY under the EXPLICIT `api_key` preference — an explicit, disclosed
  ROUTE, never a credential row, never an account count, never silently
  under `auto`. Enabling/disabling a row
  (the toggle) is the only routing control; there is NO user-settable
  "Active" account. Accounts are SYMMETRIC: every row carries the same
  Enabled toggle and the same Delete (removal is provable — success means
  the row and all material Claudexor owns under the effective cleanup policy
  are gone; vendor-owned OS-user credentials may be deliberately left
  unchanged only when the typed receipt says so; a partial required cleanup is
  a typed retryable error, never a removed-with-warning receipt). ONE server
  projection — `accountPools` — owns the informational per-harness
  `next_up` verdict, computed by the same routing owner, so no surface
  re-derives it. A native session has ONE holder row at a time: resume is
  re-verified against the RESOLVED account at the engine boundary, and a
  session reaches another row only through a disclosed MOVE of its history
  file by the harness adapter (session files only, never credentials),
  recorded in the attempt's session capsule.
  Deletion retires the canonical id PLUS every migrated legacy alias (the
  null quota subject, default lane homes, durable pins, `rotation_eligible`
  entries) in one lifecycle operation, so an id cannot dangle or resurrect
  stale auth; the supported downgrade path is the engine's own migration
  rollback command, run BEFORE installing an older engine. verify: schema
  credential-profile.ts + accounts-migration.ts; orchestrator
  preflightProfile/account-pool tests; the accounts-unified-migration
  battery; threads binding/resume-isolation tests; profile-delete tests;
  `packages/harness-cursor/src/status-cache.test.ts` +
  `packages/orchestrator/src/rowAdmission.test.ts` (#363 stale admission).
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
  it natively and injects only the missed delta. A native session has one
  holder profile at a time (INV-135). In Agent and Ask, an in-run account hop
  MOVES the session file into the next profile's store and resumes it there —
  disclosed on the thread as a lane switch that resumed natively — rather than
  hydrating a packet; a session that cannot be moved continues as a fresh
  session re-grounded by the evidence index, disclosed as `packet`. Silent
  conversation loss on any switch is a release-blocking bug of the same
  class as data loss. verify: continuity canary
  `[INV-137:a-b-a-continuity]`; lane checkpoint + packet-builder tests
  (`packages/orchestrator/src/continuity.test.ts`,
  `packages/daemon/src/threads.test.ts`); in-run carrier contract
  (`packages/orchestrator/src/inrun-continuity.integration.test.ts`);
  disclosure UI/CLI review.
