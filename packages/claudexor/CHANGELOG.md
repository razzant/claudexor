# claudexor

## 2.0.2

### Patch Changes

- 5f2dddf: Ф4 "Simple UI": the chat card, transcript, inspector, and Doctor stop being
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

- cbf0540: CLI live printer: the codex answer prints once, not twice (Ф2.5 sol #4
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

- f8eec3e: Ф3 "Honest engine": the engine stops lying about readiness, stops leaving
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
