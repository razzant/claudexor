---
"@claudexor/schema": patch
"@claudexor/orchestrator": patch
"@claudexor/cli": patch
"@claudexor/control-api": patch
---

Accounts now shows a typed refusal of one model on an account (#200). `GET /v2/accounts/routing-evidence?includeCredentialUnusable=true` adds `credentialUnusable[]`: each registered row's live model-scoped credential refusals with the model, the typed code, redacted evidence such as the vendor's error category, and when it was observed and expires. Without the query the response keeps its earlier shape, and an engine that rejects the query is read again without it. `claudexor profiles`, `claudexor accounts` and the MCP accounts tool print or carry these as dated `recent refusal` lines, and the macOS Accounts row leads its one "Recent refusal" line with "<model> (<reason>, <age>)", most recent first, wrapping that line to at most three lines so the ordinary row states it. A refusal of one model never changes the account's status, Enabled state or order; a credential-wide refusal stays in the account's status. An entry clears when the account later serves exactly that model as the vendor reports it, on a credential change, or on expiry; service the vendor reports under another id, such as a dated id for a requested alias, leaves it until expiry.
