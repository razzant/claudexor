---
"@claudexor/schema": minor
"@claudexor/harness-codex": patch
"@claudexor/harness-claude": patch
"@claudexor/harness-cursor": patch
"@claudexor/budget": patch
"@claudexor/cli": patch
---

Separate Codex Ultrafast from ordinary Fast. `processingPreference` accepts `ultrafast`, and processing receipts and model capabilities report it as its own mode. Advisory Fast selects only an advertised `fast` or `priority` tier, whatever order the account lists its tiers in; before, a model that listed `ultrafast` first received Ultrafast for a Fast request. Ultrafast is submitted only where the selected model and account advertise it. Otherwise the request continues on ordinary service, the unsupported tier is not sent, and the receipt keeps `requested: ultrafast` with its reason; Claude and Cursor report `ultrafast_not_supported`. Ultrafast has no subscription allowance, so a no-paid policy keeps ordinary service, and observed Ultrafast is never counted as included work. A confirmed pre-generation refusal of a submitted Ultrafast tier may fall back to Standard like Fast; an unknown outcome is not retried. A retry keeps the Ultrafast intent of a receipt recorded before this change, which named it Fast. Engines before this change reject records that contain `ultrafast`. After a downgrade, they refuse Exact Retry of a run started with Ultrafast, and a run that inherited a native Ultrafast setting chooses its speed again on retry.
