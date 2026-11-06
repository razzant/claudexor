---
"@claudexor/mcp-server": patch
---

The MCP Accounts tool now projects structured responses through its published
schema before handing them to the SDK. Additive fields from newer engines no
longer break older connected clients, while known fields and required types
remain strict. The projection preserves the distinction between legacy quota
snapshots and the opt-in resources response and never fabricates missing
`quota.resources`; malformed resources responses remain typed validation
errors.
