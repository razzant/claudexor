---
"@claudexor/event-log": patch
"@claudexor/orchestrator": patch
"@claudexor/daemon": patch
"@claudexor/cli": patch
---

A run's terminal receipts (`final/run_facts.yaml`, `final/telemetry.yaml`), any rewrite of its event log that the terminal needs, and its large terminal bodies are now written to disk off the daemon's request thread before the terminal commits. The terminal is prepared first, with its outcome and receipt frozen, then its bytes are written as write-through temp files on Node's file worker pool (in the store's body directory, which a new store creates before its first terminal), and the synchronous terminal commit renames them into place right after the database commit instead of writing them there. Durability, the order in which a terminal becomes visible, and the receipt contents are unchanged; anything that could not be staged, or changed meanwhile, is written by the commit as before. A control audit or live-message receipt that arrives during that write is recorded before the terminal, which takes the next sequence number and keeps its prepared outcome and time; a cancel arriving then does not change the outcome. If the daemon stops before the commit, there is no terminal and no receipt, and the leftover temp files and unowned bodies are removed by the existing orphan sweep after the next start.
