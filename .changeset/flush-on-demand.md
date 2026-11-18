---
"@claudexor/daemon": patch
"claudexor": patch
---

A model call no longer waits for the engine store's next scheduled disk flush before it
is sent. The record that a call is about to be sent must reach the disk first; that wait
used to last until the flusher's next pass, every 200 ms plus the pass itself. A caller
waiting for that proof (a model or image send, an account-reset consume, startup and
shutdown) now wakes the flusher, which runs the pass that was scheduled at once; callers
that arrive together share it, and the next scheduled pass keeps its time, so waking adds
no pass. Such a woken pass makes the same directory entries and write-ahead log durable
but leaves the space-reclaiming checkpoint, with its own two full flushes, to the regular
passes unless none ran it for two intervals.

On a scripted load against an isolated store on the same machine (model-shaped
operations: accept, dispatch record, dispatch barrier, a 150–500 ms simulated provider,
result), the wait before sending fell from a mean of 248 to 96 ms one call at a time,
from 296 to 87 ms with other work committing every 25 ms, and from 262 to 97 ms with four
calls at once. Full flushes (`F_FULLFSYNC`, counted in the process) per call fell from 4.45
to 2.82 and from 4.33 to 2.72 in the first two loads and stayed level with four calls at
once (1.19 ± 0.06 before, 1.23 ± 0.02 after, over six runs each). Writes that nobody waits
for keep the regular schedule.
