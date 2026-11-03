---
"@claudexor/schema": patch
"@claudexor/core": patch
"@claudexor/daemon": patch
"@claudexor/control-api": patch
"@claudexor/cli": patch
"@claudexor/harness-claude": patch
"@claudexor/harness-codex": patch
"@claudexor/harness-fake": patch
---

Add exact thread export (`claudexor thread export`, `GET /v2/threads/:id/export`) and conditional retirement against that export (`claudexor thread-retire`, `POST /v2/threads/:id/retire`), with `POST /v2/threads/:id/retire/abandon` to settle an unanswered operation and `GET /v2/threads/:id/retirement` (`claudexor thread retirement`) to read its outcome. A partial export names each gap and cannot retire. Retirement reaches only what a recorded real session proved, currently Claude 2.1.316 transcripts and spilled tool output on Darwin; any other host platform or session material is a named gap, exported byte-exact only where its harness declares its layout. A name the bundle's volume cannot hold is kept by item id, with the complete name in the manifest and the place in the receipt. `thread-retire` re-hashes and syncs every byte its bundle received, and the directories above it, before it sends a new operation, keeps that request in the bundle until an answer settles it, and names it in every unknown answer, so repeating the command repeats that operation. A purged thread admits no new work: a turn's create or retry, Exact Retry and decision rerun answer 409 `thread_purged`, while a command the thread accepted still answers its replay and a run's retained result can still be applied, discarded or reverted. Stop ends an export's journal or transcript read at its next chunk, and a restart's replay of an open retirement cleanup between lane entries. An export observes the thread's closure in the store maintenance worker's read-only snapshot, off the request thread, and an export read cancelled by Stop answers 503 `daemon_stopping` (retryable); the retirement decision still rereads the closure synchronously inside its transaction, at a cost that grows with the closure.
