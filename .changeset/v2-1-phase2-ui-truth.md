---
"claudexor": patch
---

Phase 2 (2.0.2) — UI truth: the macOS app projects engine truth instead of
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
