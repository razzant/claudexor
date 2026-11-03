---
"@claudexor/orchestrator": patch
---

Finish directory-capture cleanup operations before a failed cleanup returns. Later captures and review copies can reuse their artifact paths without outstanding sibling deletions changing the next capture's result. The original capture failure and any cleanup failure remain distinct; authored source files stay untouched.
