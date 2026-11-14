---
"@claudexor/cli": patch
"@claudexor/schema": patch
"claudexor": patch
---

The capability catalog (`GET /v2/agent-capabilities` and the MCP
`claudexor_capabilities` tool) no longer makes a reader wait for a full sweep of
every harness once its 15-second window has passed. For five more minutes the
daemon answers with its last composition, dated by `generatedAt`, and that read
starts the one recompute that replaces it. On a large install the sweep took 11
to 19 seconds, and a host that read the catalog after a quiet spell waited that
long for its Accounts page. Nothing sweeps when nobody reads. The first read after
start, after a credential change, a setup-login transition, a harness install or
update or a changed global config, and any read more than five minutes past the
window still wait for a new composition. A recompute that fails leaves the
previous composition under its own `generatedAt`, and the next read tries again.
`/v2/harnesses`, `claudexor doctor` and the MCP status tool still wait for a new
sweep once the window has passed.

A harness install or update through the daemon now also drops the cached status
projections, so `/v2/harnesses` and the catalog show the new program at the next
read instead of up to 15 seconds later, and the Accounts harness statuses, which
had no expiry, show it too; the first Accounts read after an install or update
waits for one harness sweep. The catalog schema's `status` and
`enabledIntents` descriptions no longer claim a cache time or "right now": both
hold as of `generatedAt`.
