# claudexor

## 3.8.1

### Patch Changes

- Updated dependencies [ce6dba1]
- Updated dependencies [2794ec7]
  - @claudexor/cli@3.8.1

## 3.8.0

### Patch Changes

- Updated dependencies [6054b7d]
  - @claudexor/cli@3.8.0

## 3.7.0

### Patch Changes

- Updated dependencies
  - @claudexor/cli@3.7.0

## 3.6.0

### Patch Changes

- Updated dependencies [895967f]
  - @claudexor/cli@3.6.0

## 3.5.0

### Patch Changes

- Updated dependencies [2316ef8]
  - @claudexor/cli@3.5.0

## 3.4.2

### Patch Changes

- e92ec81: Fix the crash that killed every mutating delegated cursor run on macOS: cursor-agent
  keeps its chat store in SQLite under the scoped HOME, SQLite canonicalizes the database
  path on open (`realpath(3)` lstat/readlinks every intermediate path component), and the
  Seatbelt profile's runtime-root read deny covered the components between the runtime
  root and the allowed scoped home — SQLITE_CANTOPEN, `RetriableError: [internal] unable
to open database file`, within seconds. This is the same class the CODEX_HOME fix
  closed for the native state root, so the metadata traversal carve-out now covers the
  union of EVERY own root's denied ancestors (scoped home, worktree, native state root):
  literal, metadata-only (`file-read-metadata`), placed after the deny it punches
  through. File data under the runtime root, sibling projects, and directory listings
  (readdir is a data read) stay denied, and the boundary probe semantics are unchanged;
  two-sided sandbox-exec tests — including a cursor-shaped SQLite open+WAL write and its
  pre-fix reproduction with the carve-out stripped — and a second real-harness battery
  phase-13 case (delegated mutating cursor under the boundary, capability-checked against
  the real repo mutation and its green test gate) pin both directions.
  - @claudexor/cli@3.4.2

## 3.4.1

### Patch Changes

- Windows native-login groundwork with honest process contracts (PR #189, with Renat/dead9111): cross-platform absolute-path schema (regex pattern survives schema generation, Swift mirror included), opt-in win32 kernel-birth-time process identity (PowerShell GetProcessTimes reader, login lane only), identity-gated `taskkill /T /F` termination with a disclosed leader-death emptiness proof, executable-image-only (`.exe`/`.com`) Windows harness binary resolution with a shim advisory, Windows environment-key forwarding matched case-insensitively, the journal partition walker separator fix (Windows daemon no longer demands recovery on second start), and a required windows-latest CI lane.
  - @claudexor/cli@3.4.1

## 3.4.0

### Minor Changes

- 530e8e3: Protect shared data roots with a persistent root-authority barrier (writer epoch + proven serving-version floor) and start the daemon in two stages: transport comes up recovery-only with product routes typed-refused, destructive recovery runs only after the read-only journal verdict and floor advance, and the handshake reports servingMode so the macOS app keeps Connecting instead of adopting a recovering daemon. Pre-fix runtimes can no longer seize a fixed root or reap live runs before journal readiness.

### Patch Changes

- 3798dd1: The daemon no longer crashes when a disconnected follower is written to.
- e0b2bbb: Treat web as optional for every non-off policy, keep Cursor web-off refusals explicit, and enable native Cursor web approvals for managed read-only runs without disabling its sandbox.
- f53a085: Recover automatically from Linux zombie daemon writer leases while keeping live or uncertain owners fail-closed and fencing concurrent stale takeovers by lease generation.
  - @claudexor/cli@3.4.0

## 3.3.16

### Patch Changes

- 7ccbdb3: App packaging now removes the pre-3.3.13 assembled bundle after successful compilation. Garbage-collection reporting recognizes the real default `v2` archive while keeping `v1` and all generation-named children under explicit roots unrecognized and advisory. The Cursor adapter now accepts the current prompt-echo and token-usage stream without inventing a dollar cost.
- ff2147a: Preserve the built-in OpenRouter instance's finite non-negative `usage.cost`,
  including zero, as an exact USD account charge receipt while keeping generic
  raw-api cost unknown. Treat explicit terminal provider-error completions as
  failures with safe typed error, usage, and completion evidence, never as
  deliverable messages or patches; ordinary stop and length completions remain
  successful.
  - @claudexor/cli@3.3.16

## 3.3.15

### Patch Changes

- 873ae20: Fix the crash that killed every mutating delegated codex run on macOS: codex
  canonicalizes its CODEX_HOME at startup (`realpath(3)` lstat/readlinks every
  intermediate path component), and the Seatbelt profile's runtime-root read deny
  covered the components between the runtime root and the allowed native state
  root — EPERM, `failed to canonicalize CODEX_HOME`, `route.transient.exhausted:
process_crash` within seconds. The profile now carries a literal, metadata-only
  (`file-read-metadata`) allowance for exactly that ancestor chain, placed after
  the deny it punches through. File data under the runtime root and directory
  listings (readdir is a data read) stay denied, and the boundary probe semantics
  are unchanged; two-sided sandbox-exec tests and a real-harness battery phase
  (13: delegated mutating codex under the boundary) pin both directions.
  - @claudexor/cli@3.3.15

## 3.3.14

### Patch Changes

- 318b774: Make Accounts usable at scale: keep the header fixed above a bounded scroller,
  show Cursor email identities, separate cached account hydration from explicit
  provider refresh, retain last-known quota with honest stale/error state, and
  render server-owned model-scoped availability without promoting a scoped limit
  to account-wide exhaustion. Stabilize daemon quota demand and pacing, recover
  large compacted journals without unbounded argument spreads, pin inline-secret
  ingress coverage, and confine browser artifacts to marker-owned run subtrees.
  Fence in-flight provider results across account deletion and login changes,
  and recover the exact in-place artifact owner after a crash so startup cleanup
  removes only that run's child while preserving shared-root siblings.
  - @claudexor/cli@3.3.14

## 3.3.13

### Patch Changes

- 29c871a: The `claudexor gc` receipt now discloses non-engine top-level entries in the Claudexor data root (advisory only — the full sorted list, never deleted; opt-in via the `data_root_report` request flag, which the CLI sends only to a lockstep same-version daemon, so the field is absent under any version skew, when the scan fails, or when the daemon predates it), and the packaged macOS app bundle plus the dmg-stage move under `apps/macos/dist/bundle.noindex/` so Spotlight never indexes dev-built bundles as launchable apps — DMG/ZIP artifacts and checksums stay in `apps/macos/dist/`.
  - @claudexor/cli@3.3.13

## 3.3.12

### Patch Changes

- 3609aab: An eight-issue fix batch. The run loop attaches the bounded, redacted `stderr_tail` to the terminal completed payload on every exit path — zero exit and abort included (#120). Artifact listings and the review-findings projection tolerate vanish races as partial point-in-time snapshots, never a 500, and `.git` entries are never enumerated in listings (#128). The harness inactivity watchdog default rises from 20 to 60 minutes for configs without an explicit value; an existing persisted `1200000` is never migrated — adopt the new value by editing `runtime.harness_inactivity_timeout_ms` in `~/.claudexor/v3/config.yaml` or setting `CLAUDEXOR_HARNESS_INACTIVITY_TIMEOUT_MS` (#129). A daemon that refuses the control-protocol handshake surfaces the typed `incompatible_protocol_major` problem with the `claudexor daemon stop` remedy on the terminal and in the machine envelope; read-only lookups no longer report a live incompatible daemon as "not running"; `claudexor follow` reports typed daemon problems through the canonical failure envelope; a corrupt `control-api.json` pointer is loud with its path; and observed same-major skew rides every typed daemon failure as `context.engineSkew` (#93). Write-mode Git auto-initialization refuses the user home directory, filesystem roots, and unclassifiable roots with the typed `git_boundary_root_refused` error before any mutation, each refusal carrying its own cause-specific required actions; a healthy home repository is respected untouched (#130). Route classification consumes the frozen admission route first and the resolved per-harness auth preference after it, making the documented config-level `auth_preference: api_key` workaround reliable (#121, part 1). macOS: storing an OpenRouter key works end-to-end, the Store-key control for every key family visibly disables with a cause-specific hover, and the post-store state honestly reports degraded — key present but route unproven — with a Retry check footer (#132). The agent convergence-preflight remediation names real configuration: "Configure reviewers from a second provider family and check `claudexor doctor` for reviewer readiness" (#133, part c).
  - @claudexor/cli@3.3.12

## 3.3.0

### Minor Changes

- Preconditions for an external orchestrator driving Claudexor runs. `RunScope.ephemeral` declares a one-shot project root: it anchors a single run, never enters the durable project registry, and its commands and run events live in the global no-project partition, so a host that hands Claudexor a disposable worktree per subagent stops filling the registry with entries that are dead on arrival. `RunExecution.delegated` marks a run driven by a machine orchestrator rather than an operator at a surface, and confines every attempt to a scoped harness HOME even under `isolation: "live"` — refusing rather than degrading when that home is absent, and recording the applied isolation on the attempt so the caller verifies confinement instead of trusting it. Credential-profile readiness now discloses `verification_source`, separating "this profile's material is present locally" from "the vendor answered a request made with this profile's credential", and a vendor 401/403 on a subject's own token becomes the typed quota absence `auth_revoked` instead of an undiagnosed refresh failure. A spent subscription window is refused typed end to end: `subscription_window_exhausted` with a structural `RunFailure.resetsAt`, carried out of a candidate attempt's catch and onto the run terminal only when every candidate died of the same refusal. `worktreePrune` no longer deregisters worktrees Claudexor does not own.

### Patch Changes

- @claudexor/cli@3.3.0

## 3.2.1

### Patch Changes

- c54b36e: Repair the macOS plan and routing flows: preserve model, effort, and auth choices for card-started turns; disclose the Agent write scope before plan implementation; accept prose plan answers; show incomplete-question state; persist submitted-answer receipts; make answer text selectable; expose copyable full run ids and inspect commands; and run the app test target in CI.
  - @claudexor/cli@3.2.1

## 3.2.0

### Minor Changes

- d6f4cd5: Add portable Agent Skill and GitHub Copilot plugin artifacts, official MCP Registry distribution metadata, experimental ACP Terminal Auth for Codex, and repository-configured protected path gates.
- faee66a: Add the canonical immutable RunFacts terminal receipt (GH #29): one invariant-validated object built from canonical artifacts, embedded in the terminal journal event, persisted as final/run_facts.yaml, and served verbatim by the control API, terminal CLI JSON/NDJSON, and inspect through one shared validation owner. Present-but-invalid receipts and corrupted canonical artifacts fail loudly on every surface; zero-gate delivery refusals stay blocked and non-eligible; the reviewer NEEDS_HUMAN gate is winner-only and fail-closed; zero-byte deliverables are never present.
- 5a5907d: Add remote SSH execution: a thread can bind to a concrete `~/.ssh/config` host, where the app installs a signed remote runtime (Ed25519 manifest binding four platform archives with pinned Node digests, atomic activate/rollback, no sudo) and drives the complete engine through a loopback SSH forward. Authentication stays with the system `/usr/bin/ssh`; interactive auth runs in an ephemeral PTY and nothing is persisted. Remote browsing lists only visible home-contained directories, remote image links serve magic-byte-validated raster images scoped to a registered project, and both endpoints are served only by the remote runtime (a local daemon leaves them unwired and answers 501). The release pipeline builds, attests, and publishes the remote-runtime archives, manifest, and SBOM as first-class release assets.

### Patch Changes

- @claudexor/cli@3.2.0

## 3.1.2

### Patch Changes

- Restore Delegate in packaged installs through the exact daemon self-entry; enforce required MCP startup, bounded shared parent/child budget and cancellation authority, typed lineage and degradation receipts, and durable CLI/macOS projections across reload and reconnect.
- Updated dependencies
  - @claudexor/cli@3.1.2

## 3.1.1

### Patch Changes

- Maintenance: CI publishes the required `build-test` check context from the
  matrix job, the fast-uri floor is pinned at 3.1.4 (GHSA-v2hh-gcrm-f6hx), major
  dependency bumps stay out of the dependabot groups, and routine dependency and
  GitHub Actions updates landed (knip 6.29.0, prettier 3.9.6, turbo 2.10.6,
  @agentclientprotocol/sdk 1.3.0, attest/pages/artifact actions).
- Updated dependencies
  - @claudexor/cli@3.1.1

## 3.1.0

### Patch Changes

- 3b01d90: Treat one explicitly selected harness as the effective primary when no
  `--primary-harness` is supplied, so configured routing defaults cannot override
  an explicit singleton pool.
- 8df552b: Record truthful planner deliverable outcomes, report the actual council member
  count, and preserve independent check and review facts when a terminal decision
  is blocked.
- 756b40d: Lead npm search metadata and the package README with quota-aware rotation across multiple Claude Code and Codex subscriptions, multi-harness workflows, and the product landing page.
- Updated dependencies [c3b7ece]
  - @claudexor/cli@3.1.0

## 3.0.3

### Patch Changes

- Incident-hardening patch: typed config_invalid errors, retired-key completeness (+gate), root-scoped config sweep with backups, plugin artifact skew hard-refusal with root provenance, logins survive daemon restarts, codex device-auth default login, quota logged-out precheck with absence backoff, no real ~/.codex transcript fallback, macOS settings-400/onboarding-scroll fixes, build-app.sh libnode guard, and the agent Install And Login guide.
  - @claudexor/cli@3.0.3

## 3.0.0

### Major Changes

- v3.0.0 — the chat-first control plane, rebuilt on honest server truth.

  Modes collapse to ask | plan | agent (orchestrate dies; delegation is
  `agent --delegate` with a scoped six-tool MCP belt). Plan absorbs Spec:
  native vendor plan modes, typed open questions, answer turns,
  freeze-on-implement, and the Council strategy. Continuity is the
  flagship: durable per-lane native sessions, lane checkpoints, bounded
  continuation packets with cached LLM summaries, and visible typed
  disclosure. Status is independent axes (lifecycle / checks / review /
  noChanges / reason) with a server-owned outcome banner that model prose
  can never outrank. Accounts are fully symmetric (an Enabled toggle plus a
  computed next-up account; a thread pins the account it first ran on;
  native CLI login is just a row). Fresh v3 data root; protocol major 3;
  runtime-closure updater + zero-telemetry install counter; the immune
  system (staged-field v3, INV→verify link gate, concept gate, reviewer
  liveness, findings ledger) guards all of it.

### Patch Changes

- @claudexor/cli@3.0.0

## 2.1.3

### Patch Changes

- Unify multi-account management, add safe profile deletion, harden native auth,
  bound high-volume macOS run rendering, preserve produced screenshots, and fix
  multi-harness cost, synthesis, review, and candidate evidence semantics.
  - @claudexor/cli@2.1.3

## 2.1.2

### Patch Changes

- Release-infra: publish retries survive non-reproducible builds and npm's
  attestation-endpoint lag. The already-published skip path now anchors on
  npm's signed SLSA provenance (same repo/workflow/tag/candidate commit,
  subject digest of the published bytes) instead of impossible local
  byte-identity; the provenance fetch polls 404s within the same bounded
  10-minute window as the version listing. The partially-published 2.1.1
  set is orphaned the same way 2.1.0 was; nothing user-visible shipped as
  either.
  - @claudexor/cli@2.1.2

## 2.1.1

### Patch Changes

- Release-infra postmortem of the burned v2.1.0 publish: npm's post-publish
  indexing lagged past the script's 10-second verification window, so each
  publish run failed after landing one package and three internal packages
  reached the registry at 2.1.0 from the now-retracted tag (a version npm
  forbids ever re-publishing). The publisher now waits up to 10 minutes for
  npm to expose each package, the one CI-flaky app test polls with a bounded
  deadline instead of a fixed sleep, and CONTRIBUTING's review-authority
  paragraph is aligned with the owner-review protocol (Bible INV-125). Also
  in this release line: account deletion end-to-end
  (`DELETE /v2/credential-profiles/:harness/:id`, `claudexor profiles remove`,
  delete on account rows) and the ONE shared accounts surface reused by the
  bottom-left popover and the Settings Harness Doctor's Manage sheet.
  - @claudexor/cli@2.1.1

## 2.1.0

### Minor Changes

- Claudexor 2.1.0: credential profiles (INV-135). Multiple subscriptions per
  harness with isolated vendor config dirs and namespaced secret slots; strict
  per-turn / thread-sticky selection with profile-isolated native-session
  resume; per-profile doctor probes and proactive per-profile subscription
  quota from the vendor oauth/usage endpoint; one typed profile policy per
  harness with provenance-recorded rotation on typed vendor-limit evidence
  only. Includes the unpublished 2.0.1 honest-engine and 2.0.2 simple-UI
  passes.

### Patch Changes

- 0fc050b: Credential profiles (INV-135): durable non-secret `credential_profiles`
  registry in the global config; the orchestrator resolves an explicit per-run
  profile id ONCE and stamps the typed profile on every HarnessRunSpec; adapters
  consume exactly the profile's transport (claude config-dir login / non-bare
  token / key; codex scoped CODEX_HOME / scoped auth.json; cursor, opencode,
  raw-api secret-ref keys) or refuse typed — never a fallback to default
  credentials. Namespaced secret slots (`claude_oauth:<profile>`), per-profile
  doctor probes (`GET /credential-profiles`, `claudexor profiles`), interactive
  `claudexor profiles login`, profile-stamped route evidence, and
  profile-isolated native-session resume.
  - @claudexor/cli@2.1.0

## 2.0.2

### Patch Changes

- 5f2dddf: F4 "Simple UI": the chat card, transcript, inspector, and Doctor stop being
  clever and start being simple, self-explanatory, and honest.

  - The turn card is a messenger: user bubble, ONE status line (identity +
    quiet state word with retry folded in on the left; time + cash-$ and the
    explicit ⧉ inspector affordance on the right), ONE labeled Activity strip
    («Thinking 40s · 9 tools · 3 files», card click toggles it), the answer
    bubble, quiet outcome rows, and a fixed action footer. The permanent
    status pill is dissolved — attention states raise a single loud chip only
    when they exist.
  - The chat transcript is a flat log: one line per tool, a failed tool
    carries its error line, runs of >3 same-name OK tools collapse into one
    group row, thinking is a single timer line, zero inline chevrons — raw
    output lives in the inspector.
  - Money is an engine fact: the budget ledger discloses cumulative CASH at
    every settle (subscription work settles to $0), the app renders it
    verbatim through one formatter — the "≈$" route-guessing essay is gone.
  - Run Detail's header is a primary row of material facts with everything
    else behind Details, composed from one facts owner (RunFacts) — the same
    apply-state vocabulary as the chat's outcome line, by construction.
  - The inspector opens only on explicit action (⧉/toolbar) and a manual
    close stays closed — no auto-reveal machinery.
  - Harness readiness is ONE card across Settings, Onboarding, and the
    AuthSheet, rendering daemon-normalized typed check rows (no string
    parsing anywhere), with per-surface actions as slots and "Copy raw" for
    evidence. The AuthSheet drives from state: one primary CTA by cause, one
    merged job status line, "Extend login wait (15 min)" only during a live
    login.
  - The presentation discipline is now Bible law (INV-134): one
    presentational owner per fact, disabled controls explain why, new
    chips/badges only through DESIGN_SYSTEM, fixed grids that never drift
    with text length.
  - @claudexor/cli@2.0.2

## 2.0.1

### Patch Changes

- cbf0540: CLI live printer: the codex answer prints once, not twice (F2.5 sol #4
  follow-up).

  Codex narrates its answer mid-run and then repeats the same text as its
  typed final message; `claudexor ask`/`agent`/`follow` printed both. The
  live formatter now dedups on the typed `final` flag per lane — a final
  whose rendered line is already on screen is suppressed, while a final
  carrying new text (claude/cursor results, which never repeat narration)
  still prints. The dedup keys on the rendered 160-char line (what the
  terminal actually shows), state is bounded per lane and survives SSE
  reconnects, and `--json`/NDJSON machine surfaces stay verbatim.

  Reviewed by gpt-5.6-sol (initial pass: 1 major + 2 minor, all fixed;
  confirmation pass on the fixes: 1 minor, fixed).

- 319a1a9: Phase 1 (2.0.1) — deletions + embedder engine contracts with CLI consumers.

  Removes demo mode entirely and models all five access profiles honestly (W1/W3);
  accepts hard-linked vendor binaries in native login via a single
  `inspectExecutable` (W2); makes native/OAuth-first the disclosed doctrine on
  every surface (INV-061, W4). Adds a per-run embedder contract carried end to
  end: system-level `instructions` on every task-producing lane (W5), a
  `maxSeconds` wall-clock deadline (W6), `denyPaths` no-touch globs enforced by
  the post-diff policy gate (W7), a mandatory `outputSchema` validated once by the
  engine into `final/output.json` with a typed conformance receipt (W8), token
  `usage` totals (W9), an auth route receipt (W10), route-aware model governance
  with a typed model-mismatch (W11), a server-side `routableIntents` availability
  projection (W_readiness), and headless CLI parity — stdin/file prompts,
  `--thread`/`--resume`, `--max-turns`, and `--json-stream` NDJSON (W13). Every
  new run control has a CLI consumer and honest MCP/ACP parity exemptions.

- 01c151f: Phase 2 (2.0.2) — UI truth: the macOS app projects engine truth instead of
  deriving its own.

  Sidebar liveness: every thread mutation from any surface pings the global
  journal (`thread.head.updated`, content-free) and the app refetches — CLI
  threads, renames, turn counts and terminals arrive without a manual refresh
  (W12+W16). Availability, onboarding, quota, routes and models all read
  server projections: doctor-gated `routableIntents` (W14), derived onboarding
  with no sticky completion flag (W15), a grouped quota footer with cooldown
  overlay badges and a 24h server prune that keeps still-live windows (W17),
  route-scoped model enumeration with an observed≠requested mismatch badge
  (W20), and per-turn Auth-route + Effort controls with the route actually
  taken disclosed on the finished run (W18). The composer gains a first-class
  Access chip with an up-front one-time-grant CTA (W19); pre-start refusals
  land on the turn as typed client-actionable statuses born at the throw
  (trust 403 / requirements 400 / recovery 503; bare errno stays 500 — W19e/
  W24). Turn outcomes reconcile execution, delivery and review into one honest
  line ("Applied · review blocked" is never a green success — W21); the final
  answer renders the agent's actual message as markdown with collapse/expand,
  never the arbitration summary (W22); live transcripts, buffers and caches
  are hard-bounded with disclosed truncation, closing the 30GB main-thread
  layout hang class (W23).

- c5d20d9: Phase 2.5 (2.0.2) — Chat-V2: the conversation reads as a conversation, and
  agent output actually reaches the user.

  Answer finality is typed end to end: adapters carry the vendors' own final
  marker (claude/cursor `result`, codex's finalized last agent message) as
  `final` on the message event, and only for SUCCESS results — a failed
  result's partial text never wins as the answer. The orchestrator's
  AnswerAssembly takes a typed final verbatim across all three task-producing
  lanes; the app renders it as the loudest element (its own bubble) and never
  duplicates it in the transcript. claude's `api_retry` becomes a typed
  `status` event (documented category enum, redacted+bounded prose) that lands
  in the activity feed and a live «Retrying 2/10 · overloaded · in 2s» status
  line — never reasoning junk. Reasoning merges into segments with observed
  durations; mid-run narration is dimmed; tool rows lead with a kind icon and
  a humane short title with the raw command one disclosure away. Opt-in live
  text deltas stream on single-candidate claude/cursor lanes (bounded by a
  per-attempt budget with a disclosed cutoff); the reducer grows one streaming
  block and the complete message replaces it, sealing on final.

  Agent images render inline, path-scoped to the thread's repoRoot / run dir
  (canonical symlink-resolved checks, off-main bounded decode, size+mtime
  cache, disclosed refusal outside the scope); file links open through the
  same gate and ONLY for safe document/image types (an executable inside the
  repo is refused, not launched); the Canvas surfaces every image the run's
  diff touched. Markdown is hard-bounded before layout on every path
  (collapsed, expanded, Run Detail, prompt) — closing the reopened W23 hang
  class. The daemon gains a disclosed SIGTERM escalation ladder (stop deadline
  - post-stop drain sweep, exit code read at fire time, timers cancelled on
    finalize) so a hung or leaked-handle shutdown can no longer leave immortal
    claudexords behind. DESIGN_SYSTEM §5 rewritten to the Chat-V2 vocabulary.

- f8eec3e: F3 "Honest engine": the engine stops lying about readiness, stops leaving
  daemons and disk behind, and pins the stream semantics it kept re-breaking.

  - Auth capability smoke: the verifier consumed EVERY message event and
    concatenated them, so the real claude/cursor shape (narration + a typed
    final repeating the same text) scored "expected+expected" and false-failed
    every compliant probe. It now consumes the engine's typed finality through
    one owner (AnswerAssembly moved to core), and its fixture pins the real
    two-event emission.
  - Read-only routing resolves the run's effective context ONCE and probes
    readiness inside it. Readiness gathered in the host env while the run spawns
    in a scoped throwaway HOME is not evidence — a route whose auth truth dies
    in the run's own env is no longer admitted.
  - Security (G1 class): the protected_paths gate now matches the full touched
    set, so creating a file under a protected glob — or renaming one out of it —
    is tamper exactly like editing it. The risk classifier matches the same
    union while counting files separately (a rename touches two paths but
    changes one file).
  - Daemon shutdown is one state machine: every trigger (signal, socket RPC,
    test dispose) enters through beginShutdown(reason) and gets the same bounded
    force-exit deadline, and stop waits for confirmed death of the exact process
    identity. No more orphaned daemons.
  - Disk retention: a daemon-owned GC service with a typed control-op,
    `claudexor gc` as a thin client, and a bounded pass scheduled after the
    daemon is ready. Only terminal, unreferenced, non-actionable run trees age
    out (30d runs / 14d reviews, newest N per project always kept), each leaving
    a tombstone so an old thread fails honestly instead of 404ing. It fails
    closed on a quarantined partition and never follows a symlink out of a repo.
  - The artifact gallery decodes through the same bounded thumbnail path as
    inline previews, so a gallery of full-resolution screenshots no longer
    decodes unbounded.
  - docs/INTEGRATIONS.md now carries the per-harness stream truth (wire command,
    event vocabulary, finality, deltas, retry) with a Known-traps section, and
    every fixture declares machine-checked stream expectations that conformance
    asserts.
  - @claudexor/cli@2.0.1

## 2.0.0

### Major Changes

- db7b795: Begin the Claudexor 2.0 breaking reset: observe Codex, Claude Code, and Cursor
  native-login processes end to end, require fresh subscription-only capability
  verification, expose durable typed auth/setup state across every surface, and
  bundle the supervised login helper with release artifacts.

### Patch Changes

- @claudexor/cli@2.0.0
