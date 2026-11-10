---
"@claudexor/daemon": patch
"@claudexor/schema": patch
---

A failed model operation names the model it asked for (#649). A failed or
interrupted operation, and one cancelled before it started, carries the
requested model in `problem.context.requestedModel`; `route.model` still names
only a model the provider reported, so a failure no longer reads as if no model
was requested. Execution reports the model named by the request bytes it read,
and none when those bytes do not parse. An operation that ends before that read
(cancelled while queued, or unable to read its input), and one the engine marks
interrupted at restart without an execution receipt, names the model stored in
the command parameters outside idempotency identity, so a same-key retry is
unchanged. Create stores the model its request bytes parsed; a raw
`claudexor.enqueue` caller that bypasses create can set that parameter itself,
and the engine does not verify it. A queued cancel now reports the honest
`model_operation_cancelled` problem with dispatch still `not_started` and no
response, usage or cost. Successful results and operations recorded before this
release read back unchanged. An older release refuses a store this release has
served (`root_authority_floor_regression`); only an older build of the same
version could open it, and it would reject the new parameter and report those
operations as not found.
