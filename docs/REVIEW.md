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

## Round 4 — real-harness dogfood (verified multi-model)
After installing real Codex (`codex-cli 0.137.0`) and Claude (`claude 2.1.165`) and dogfooding on a
throwaway repo, three independent critics reviewed only the resulting fixes (`git 2d20492..HEAD`):
**GPT-5.5-extra-high** (OpenAI), **Gemini-3.1-pro** (Google), **Claude-Opus-4.8-thinking-max** (Anthropic).
Dogfood-confirmed blockers fixed:
- codex api_key auth: seed `auth.json` into the isolated CODEX_HOME (codex 0.137 ignores `OPENAI_API_KEY`
  with an empty home → 401 on `/v1/responses`). Daily mode is a guaranteed no-op (uses native codex auth).
- workspace leak: envelope scoped dirs (home/env/logs/artifacts) moved OUT of the worktree so `git add -A`
  no longer captures harness HOME state (was leaking the seeded API key + plugin files into `patch.diff`).
- cli footgun: `--mode` now accepts hyphenated aliases and rejects unknown modes loudly (was silently
  downgrading `--mode until-convergence` to `daily`).
Result: a real Codex-vs-Claude `race` converges to **success** with a clean, single-file `patch.diff`
that `apply --dry-run` accepts; `max_attempts` convergence + `plan` + daily + MCP/ACP/daemon all smoke clean.
All three critics: **SAFE TO COMMIT**, no hard blockers (verified against code, not just the changelog).
Disclosed v0.2 follow-up (not a regression of this diff): nothing populates `contract.tests.commands`,
so deterministic gates are vacuous from the CLI — convergence is review-driven until config→gates is wired.

## Round 5 — post-pilot framework fixes (verified multi-model)
After a real SWE-bench Verified pilot (flask-5014 solved end-to-end across all modes; eval flaky only
due to a 2 GiB Colima segfault, not the code), five framework fixes were made and reviewed by
**GPT-5.5-extra-high**, **Gemini-3.1-pro**, **Claude-Opus-4.8-thinking-max**. Fixes: official id-bearing
prediction format; `config→gates` (test-driven convergence); `--max-usd` budget cap; codex cost
estimation (`usage.estimated`, recorded as "observed"); per-family reviewer-model override; plus
`--access`/`--model` for daily runs and a Terminal-Bench 2.1 installed-agent adapter.
Verdicts: Gemini SAFE, Opus SAFE, GPT FIX-FIRST. Agreed findings fixed in a follow-up commit:
- `bench run` now honors `--max-usd` / `--reviewer-model` (was silently ignored).
- `decision.budget_summary` renamed `exact_usd`→`spend_usd` + `estimated` flag, so token-estimated
  codex spend is never presented as exact.
- `writePredictions([])` no longer writes a lone blank `.jsonl` line; negative `--max-usd` ignored.
Deferred (documented, low practical risk): a malformed `.claudex/config.yaml` is swallowed by the
pre-existing `loadConfig`/`readYaml` and yields empty gates rather than failing loudly; benchmark gates
come from `--test`, and real task repos ship no `.claudex/config.yaml`. Fail-loudly-on-malformed-config
is a config-package change tracked as a follow-up.
