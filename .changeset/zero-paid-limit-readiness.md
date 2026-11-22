---
"@claudexor/cli": patch
"@claudexor/control-api": patch
"@claudexor/core": patch
"@claudexor/harness-claude": patch
"@claudexor/harness-codex": patch
"@claudexor/harness-cursor": patch
"@claudexor/mcp-server": patch
"@claudexor/orchestrator": patch
"@claudexor/schema": patch
---

An ordinary read-only Ask with no paid budget left (a $0 limit from the request or Settings, or an inherited limit already used up) no longer sends diagnostic requests that could be billed while it checks which executors are ready, and a vendor-verified native subscription can still serve it, including a first Ask with no earlier run. In that mode each send, including a fallback model or continuity summary, can use subscription pricing only if it still runs strictly on the verified native session or uses an account with its own vendor verification. A processing receipt, preference or past run cannot establish that entitlement. Routing can drop a harness whose only proof was withheld and fails `harness_unavailable` when no route remains, while the ledger refuses an admitted send whose billing is unknown or metered (`finite_zero` at $0). Unverified keys and setup-tokens are reported as not verified, and only where a check was actually withheld does the report name the paid budget and suggest raising the limit. A Claude setup-token on its own, with no vendor verification already on record, therefore cannot serve such an Ask while that check is withheld; a native vendor sign-in is the way to use the subscription with no paid check. Family headroom is sampled once at readiness admission. When that admission takes an account from the pool, an account the vendor verified goes ahead of accounts that have only a login file or a setup-token on record, which never count as included by their kind; an explicit pin or a ready thread account is kept. Accounts `next_up` still names the first candidate in ordinary pool order for the configured default model, so such an Ask, like any run with its own pin, thread, model, mode or auth preference, can use another account; the Accounts help, docs and API descriptions now say so, and the wire is unchanged. Plan, Agent, Deep Scan, review, manual `doctor` and runs that allow paid use keep their checks and dispatch; only an Auto refusal with no route now lists each harness's own reasons.
