---
"@claudexor/util": patch
"@claudexor/schema": patch
"@claudexor/core": patch
"@claudexor/event-log": patch
"@claudexor/control-api": patch
"@claudexor/daemon": patch
"@claudexor/harness-codex": patch
"claudexor": patch
---

`GET /v2/daemon/status` now says what keeps the daemon's main thread busy. Its `timing`
object gains `work`: main-thread milliseconds, section count and longest section, since
the daemon started and in the last ten-second window, for each class of work: handling
control API requests, translating each harness's output into run events (per harness),
appending run events to their journals and live readers, committing to the engine store,
parsing a provider's model list, and launching child processes such as login checks and
Git. A section inside another one counts only once, so the classes add up; time spent
outside these sections is not attributed. The counters live in memory and write nothing.
