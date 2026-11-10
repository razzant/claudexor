---
"@claudexor/mcp-server": patch
"@claudexor/cli": patch
---

`claudexor_run_continue` accepts `effort` and a harness-keyed `efforts` map, so
an MCP caller can restate the reasoning effort a successor must keep (#604).
Both reach `POST /v2/runs` exactly as stated, as the REST continuation already
allowed. Each lane uses its `efforts` entry, else `effort`, else its Settings
default. A successor still inherits no effort from its predecessor: omitting
both keeps the ordinary new-run default. An invalid level is refused before the
request is sent, and an unregistered harness id is refused by the engine as
before. The generated host skills and the portable skill now list effort among
the controls to restate. `claudexor_run` now describes its `effort` as the
engine applies it, to every harness the run executes and not its reviewers,
instead of only the primary harness.
