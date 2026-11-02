---
"@claudexor/orchestrator": patch
---

A live in-place single-candidate run, and each in-place convergence attempt, no longer takes a post-turn Git snapshot when its complete final capture found no change (#502). That snapshot is only the postimage of the revert anchor, and every reader of it already required a candidate change, so an unchanged run keeps the same result: no `post_turn_sha`, no revert anchor, and `revert_run` still refuses with 409. Changed runs, refused continuations and runs with no completed capture keep the post-turn snapshot; a refused capture keeps its existing no-snapshot rule. The pre-turn and envelope-base snapshots, both captures and revert anchors are unchanged.
