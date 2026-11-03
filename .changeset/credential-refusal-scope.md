---
"@claudexor/harness-claude": patch
"@claudexor/orchestrator": patch
"@claudexor/schema": patch
---

A credential refusal now keeps its actual scope (#609). A vendor model refusal on a run that named no model no longer marks the whole account failed or refuses other models on it for up to an hour: nothing is recorded as a hard mark, the run keeps its own failure diagnostics, and the existing pre-progress ordering mark applies only under its own conditions. A proven denial of subscription access, meaning the vendor's exact `oauth_org_not_allowed` code or its recorded organization-disabled result on a subscription route, now covers every model of that exact account and route even when the run named a model, and never another route, account or harness. Prose that only the parser's fallback files under that category proves nothing about other models: it keeps its diagnostics and retry class and restricts only the model the run named. A refusal of a known model stays exact, and success, expiry and credential-change clearing are unchanged.
