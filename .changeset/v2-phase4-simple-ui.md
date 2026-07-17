---
"claudexor": patch
---

Ф4 "Simple UI": the chat card, transcript, inspector, and Doctor stop being
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
