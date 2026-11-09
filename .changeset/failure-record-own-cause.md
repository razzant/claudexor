---
"@claudexor/harness-codex": patch
"@claudexor/orchestrator": patch
---

A failed run's message now names the cause the vendor recorded for the try it
describes (#633, #635). When that record is known, the message quotes its
source, code and words beside the error, so a Codex run that ended as "settled in
systemError" also shows, for example, `server_overloaded` and the vendor's own
words. An untyped harness failure's first next action points to that record. The
code stays evidence only: retries, account choice, cooldowns and the record's
category are unchanged, and a typed refusal keeps its own remedy. Codex also
keeps the root turn's own error record from the app-server wire when its session
rollout holds none.

When the winning candidate changed files and then failed, its own cause now
leads the failure message and the returned summary, before the ranking line,
and the run summary (`summary.md`) names it as a `- Failure:` line. A repair
loop (`--attempts`) that ends not converged on such an attempt leads with that
attempt's own cause and keeps its vendor record. No earlier or losing attempt's
cause is ever used, and the failure phases stay `arbitration` and `convergence`.

In a delegated write run, an attempt that failed while it was being prepared,
before its home directory was decided, now ends with its own failure instead of
`delegated_evidence_incomplete` (#648), and a healthy sibling candidate can still
win. Only an attempt the engine itself saw fail at that point is exempt, never a
record that merely lacks the fields; an attempt whose adapter ran without
stating what it ran under is still refused.
