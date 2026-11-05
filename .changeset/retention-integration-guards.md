---
"@claudexor/cli": patch
"@claudexor/core": patch
"@claudexor/daemon": patch
"@claudexor/control-api": patch
---

Preserve intermediate registration roots and late recovery holds during retention,
and keep anchors while any namespace is deferred. Later process-scope settlement
preserves its first group birth bound, keeps unproven groups unresolved, suppresses
repeated diagnostics and skips identical index publications without losing attempt
reports or failed-write retries.
