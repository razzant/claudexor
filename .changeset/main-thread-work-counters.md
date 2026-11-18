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

A raw model operation's preparation receipt (`includePreparation=true`) gains
`process.eventLoopDelayMs`: how long one of its steps waited, on average, for the
daemon's main thread while it prepared, measured by the daemon's own loop-delay sampler.
With the operation's `createdAt` and `dispatch.startedAt`, a successful operation's
receipt now shows when it was accepted, when it was sent and how long it waited for the
loop. The status field is optional, and preparation timings are still sent only to clients
that ask for them.
