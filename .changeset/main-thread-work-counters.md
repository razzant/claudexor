---
"@claudexor/util": patch
"@claudexor/schema": patch
"@claudexor/core": patch
"@claudexor/event-log": patch
"@claudexor/control-api": patch
"@claudexor/daemon": patch
"@claudexor/harness-acp": patch
"@claudexor/harness-codex": patch
"@claudexor/harness-raw-api": patch
"claudexor": patch
---

`GET /v2/daemon/status` reports main-thread milliseconds, section count and the longest
section by class in `timing.work`, since startup and in the last completed ten-second
window. The counters cover control requests including body decoding and parsing,
vendor frame translation and raw API completion handling by harness, synchronous
run journal appends, store commits, vendor catalog parsing, child launch and Codex
login output parsing. Each section excludes the time spent in nested sections.
Async continuations count when they enter a measured section. The counters live
in memory.
