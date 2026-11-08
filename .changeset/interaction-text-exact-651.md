---
"@claudexor/util": patch
"@claudexor/orchestrator": patch
"@claudexor/harness-claude": patch
"@claudexor/harness-codex": patch
"@claudexor/cli": patch
"@claudexor/schema": patch
"@claudexor/acp-server": patch
---

Interaction text reaches callers exactly (#651). The Codex access question
now quotes the worker's complete final output instead of silently cutting it
at 32,000 characters. A Codex approval refused for details over the
32,000-character review limit now says so, with the measured size, instead of
the generic "cannot grant" reason; readonly and workspace_write command refusals
keep their priority. The bounded display labels (a harness event's timeline
`title` and a Claude question's preview text) end in a visible "…" and never
split a character; the complete text still rides beside them.
`claudexor_run_wait` reports `wakeReason: "interactions"` when the next event is
a question too large for any page. Each ACP multi-select include/skip round
shows every option of the question with its description.
