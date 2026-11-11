---
"@claudexor/schema": patch
"@claudexor/control-api": patch
---

A caller whose `POST /v2/runs` or `POST /v2/threads/:id/turns` answer was lost can
now learn what that request did without starting anything. `POST /v2/runs/lookup`
and `POST /v2/threads/:id/turns/lookup` take the same body and `Idempotency-Key`,
canonicalize them exactly as create replay does and read the existing command and
turn bindings. They never apply current admission, preflight, enqueue, record a
turn, wait for a run or write, and a miss never falls back to creating.

The answer is HTTP 200 `ControlStartLookupResponse` and always names the store it
read. `found` returns the job handle as it stands: `runId` is null before a run, and
a refusal or failure the job recorded is returned as `problem` instead of an HTTP
failure. `turn_only` is a retained turn whose command was never accepted or was
removed by retention, with the turn's exact `runId` (or null) and `enqueueError`,
also for a turn that is no longer the conversation tail. `not_found` only says this
store's partition retains no binding for the request. Key conflicts, malformed
input, an unregistered project root, an unknown thread and an unreadable index keep
their typed problems, and a store without identity refuses the read. A continuation
whose predecessor retention removed cannot be rebuilt as its create recorded it: it
answers `410 continuation_predecessor_not_retained`, never a guess. Both lookups
are listed in the operation catalog as keyed read-only operations; an engine
without them answers a bare 404.
