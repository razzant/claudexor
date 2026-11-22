---
"@claudexor/schema": minor
"@claudexor/orchestrator": minor
"@claudexor/cli": minor
"@claudexor/mcp-server": minor
"@claudexor/harness-grok": minor
---

A one-shot run can state its complexity (`--complexity easy|medium|hard`,
`complexity` on `POST /v2/runs` and the MCP launch tools). Its harness, model
and effort candidates come from your `routing.complexity_routes` table, and
account rows marked `tier: auxiliary` or `tier: primary` order the accounts:
auxiliary accounts first, soonest limiting reset first, and a primary account
only below `routing.account_tiers.primary_reserve` (85% of a long window by
default). Unknown quota ranks last and never counts as room on a primary
account. When no candidate can serve, the run refuses with every candidate's
reason instead of using a reserved account, and the decision is recorded in
the routing rationale. Runs that state no complexity route as before, and
nothing is configured by default.

A Grok account with a `usage_allowance` now has a quota window: spend summed
from the Grok CLI's local usage records against that allowance, reset at the
end of each period. A provider refusal for spent credits is held until that
period ends. Only `usage.json` is read.
