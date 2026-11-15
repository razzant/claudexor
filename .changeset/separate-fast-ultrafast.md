---
"@claudexor/schema": minor
"@claudexor/harness-codex": patch
"@claudexor/harness-claude": patch
"@claudexor/harness-cursor": patch
"@claudexor/budget": patch
"@claudexor/cli": patch
---

Separate Codex Ultrafast from ordinary Fast. `processingPreference` accepts `ultrafast`, and processing receipts and model capabilities report it as its own mode. Advisory Fast selects only an advertised `fast` or `priority` tier, whatever order the account lists its tiers in; before, a model that listed `ultrafast` first received Ultrafast for a Fast request. Ultrafast is submitted only where the selected model and account advertise it. Otherwise the request continues on ordinary service and the receipt keeps `requested: ultrafast` with its reason.

When the selected model does not advertise a requested Fast, Ultrafast or Economy tier, a raw Codex HTTP request now omits `service_tier` instead of sending `default`; the Codex CLI still selects `default` explicitly so it cannot inherit a native setting. Claude reports `ultrafast_not_supported`. Cursor reports it when the model has a listed standard/`-fast` pair and selects the standard variant; a model without such a pair keeps `processing_variant_unconfirmed` with the selected model, and an explicitly selected `-fast` model remains native Fast (`native_explicit`) under the existing paid policy. Claude and Cursor now list `ultrafast` in `processing_preferences`, which names the preferences an adapter accepts and answers with a receipt, not the service a model or route provides.

Claudexor does not establish an included allowance for Ultrafast, so its existing no-paid policy keeps ordinary service; this is not a claim about vendor billing. Observed Ultrafast is never inferred to be ordinary included work. A confirmed pre-generation refusal of a submitted Ultrafast tier may fall back to Standard like Fast; an unknown outcome is not retried. A retry keeps the Ultrafast intent of a receipt recorded before this change, which named it Fast.

Engines before this change reject records that contain `ultrafast`. After a downgrade, they refuse Exact Retry of a run started with Ultrafast, and a run that inherited a native Ultrafast setting chooses its speed again on retry. Claudexor.app 6.0.0–6.1.2 cannot decode a run whose reviewer panel names `ultrafast`, so the runtime update floor now requires the app from this release: an older app reports that an app update is required and keeps its current engine.
