---
"claudexor": patch
---

Ф3 "Honest engine": the engine stops lying about readiness, stops leaving
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
