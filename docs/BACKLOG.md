# Backlog

Explicitly deferred work with a recorded owner decision. Rule: an item leaves
this file only by shipping or by an owner decision recorded in its row.
Silent drops are the failure mode this file exists to prevent — the 2.1.0
audit found ten Ф2.5 leftovers that were neither shipped nor consciously
deferred; they are recorded here now.

## Deferred from the v3 plan itself (sol triage #13/#34)

- HarnessLogo overlay everywhere (old W27) — cosmetics, after 2.1.0.
- M7 reasoning-segment closing-block timer; M11 remainder (`file://`
  host/percent-encoding); E11 usage snapshot-vs-delta discriminator.
- Codex proto-mode for smooth deltas; codex `rateLimitResetCredits` mini-gap.

## Ф2.5 leftovers surfaced by the 2.1.0 audit (previously untriaged)

- C1: CLI live-printer double-prints codex narration+final (dedup fix exists
  on an unmerged branch).
- C2: `claudexor follow` reports "stream ended without a terminal event" on
  some successful runs.
- C3: cancelling a QUEUED run emits no head ping / `enqueue_error` — the
  thread view can miss the cancellation.
- E1: fd-based no-follow TOCTOU closure for scoped file serving.
- E2: daemon↔app protocol version handshake/negotiation.
- E3: engine-typed `queuedAt`/`startedAt`/`terminalAt` timestamps.
- E4: producer-side byte/latency delta coalescing.
- E5: denyPaths native pre-write enforcement (gated on claude ≥2.1.208).
- P13: dead `TaskRun.isLive` / `ProvenanceTag "Sample"` knobs left from the
  demo-mode removal.

## Deferred during the 2.1.0 release loop (decision recorded per row)

- Profile-policy `ask` interactive UX (see `docs/FEATURES.md` row).
- macOS credential-profile management beyond the 2.1.0 picker scope: full
  in-app login flow for ADDING a profile end-to-end (the 2.1.0 app ships
  list + picker + guided add via `claudexor profiles login`).
- Thread-scoped run creation via POST /runs: preflight refusals happen
  before the turn exists, unlike the turns route (round-18 scope advisory;
  see `docs/FEATURES.md` row).
- raw-API profile bootstrap when the instance key is absent (ARCHITECTURE
  Design constraint; revisit only if raw-API instances get profile demand).
