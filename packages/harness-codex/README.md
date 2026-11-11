# @claudexor/harness-codex

Internal package of [Claudexor](https://github.com/razzant/claudexor) — Codex CLI adapter over the native app-server JSON-RPC lifecycle.

One app-server child owns one Claudexor run. Native goal continuations and
run-owned background terminals keep that run active; Stop pauses the goal,
interrupts the exact active turn, and terminates only terminals observed in
that run.

The native fixture stamp is codex-cli 0.162.1. Installation and maintenance use
the vendor's standalone installer and the selected program's `update` verb;
fixture stamps do not select install versions. Exact versions use the adapter's
declared installer input. Each native run records the selected path and the
server's own startup version.
Its selected-account `model/list`
capture is `fixtures/models-0.162.1.json`; the fallback keeps historical model
ladders but takes the captured default (`gpt-6.1-sol`) from that version. The
native turn-text bound was re-probed against an unauthenticated loopback
provider: 1,048,576 Unicode scalars accepted; 1,048,577 refused before a provider
request. This is a character bound, not a model token-window guarantee.

Live messages (`POST /v2/runs/:id/messages`, capability `live_input: mid_turn`):
`message(sessionId)` steers the ACTIVE turn through `turn/steer`. Outcomes come
from adapter state, never from error prose: `accepted` when the server answers
`{turnId}`; `delivered` when the `userMessage` echo carrying our client id
arrives (also yielded as a `live_input_delivered` status event); `rejected` when
a refusal lands while the turn is still active; `not_active` when no turn is
active (goal-continuation gap, background-terminal wait, after Stop);
`delivery_unknown` on transport loss, a malformed reply or a missed 30 s
deadline. A steer never fails or cancels the run. Recorded on codex-cli 0.156.1
in `fixtures/app-server/recorded-steer-0.156.1.jsonl`.

Published as part of the Claudexor toolchain; it follows the monorepo's
lockstep version and has no separate semver contract. Use the `claudexor`
CLI (or `@claudexor/cli`) as the supported entry point.
