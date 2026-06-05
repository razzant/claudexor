# Adversarial multi-model review — v0.1.0

Three independent critics on distinct providers (verified multi-model) reviewed the build,
in a loop, until no agreed blocker remained. Models: **GPT-5.5-extra-high** (OpenAI),
**Gemini-3.1-pro** (Google), **Claude-Opus-4.6-max-thinking** (Anthropic). Evidence packet
(intent / forbidden / decided / diff / tests) lived under `.adversarial-review/`.

## Round 1 — verdicts: GPT FIX-FIRST, Gemini BLOCK, Opus SAFE
Agreed blockers fixed:
1. race/benchmark produced zero candidates when `--harness` omitted → auto-resolve via gateway.
2. budget `reserve().granted` ignored → enforce hard cap before spawning paid work.
3. failed candidate leaked worktrees → per-candidate envelope in try/finally.
4. `until_convergence` had a hidden 50-attempt cap → removed; ReadinessLedger wired.
5. synthesis decided but never executed → run synthesizer as a new re-checked candidate.
6. convergence was a retry, not a repair loop → carry envelope + feed findings back.
7. plan mode was a single prompt → multi-harness planning + plan review + SpecPack.
8. convergence ignored the formal predicate → use `evaluateConvergence`.
9. "clean review" claimed with no reviewers → record `review_verified:false`.
Declined (disagreed): readonly summary preview (full report on disk); conserve-* portfolios
are family-specific by design.

## Round 2 — verdicts: GPT FIX-FIRST, Opus FIX-FIRST, Gemini SAFE
Round-1 fixes verified. New agreed blockers fixed:
- A: `until_convergence` lacked robust termination → observe quota signals; stop on
  budget-hard / all-cooled-down / no-progress-across-harnesses (no fixed cap).
- B: `runConvergence` never wrote `final/` → write patch/work_product/summary so
  `apply`/`inspect` work.
- soft: synth candidate now included in returned candidates; create moved inside try/finally.

## Round 3 — verdicts: GPT SAFE, Opus SAFE, Gemini SAFE (converged)
Round-2 fixes verified by both FIX-FIRST critics. Two agreed soft hardenings applied:
- conservative rate-limit detector (no spurious cooldown from benign "429"/"quota").
- convergence resilient to a throwing adapter (treated as a failed attempt).
Declined (intent-aligned / disclosed v1 gaps): oscillating-signature unbounded edge terminates
on budget/quota per the explicit "no limits, run until money runs out"; plan live interview,
single-harness `readonly_swarm`, final fresh-envelope re-verify, synthesizer = adapters[0],
`require_rebuttals_not_overturned` dormant (no producer yet), ContextPack built only in race.

## Outcome
All three critics: **SAFE TO COMMIT**. No remaining hard blocker the author agrees with.
The declined items are tracked as v0.2 follow-ups.
