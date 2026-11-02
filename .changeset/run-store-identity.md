---
"@claudexor/schema": patch
"@claudexor/control-api": patch
"@claudexor/cli": patch
"@claudexor/mcp-server": patch
---

A `no such run` answer now says which engine store answered, so one from another store cannot pass for proof of absence (#163). `GET /v2/runs/:id` adds `context.storeId` to its `http_404` problem, and `claudexor inspect` reports that store in its message and `--json` context. A client can also bind a run to its store at admission: with the request header `X-Claudexor-Store-Identity: 1`, `POST /v2/runs`, Exact Retry, the `rerun_with_feedback` decision, `POST /v2/threads/:id/turns` and its retry name the store that holds the accepted job. The CLI and MCP send that header, so `--json` and NDJSON results, MCP launch and continuation results and `claudexor_thread_turn` handles now carry `storeId`. Without the header receipts keep their shape, so shipped clients that parse them strictly keep working, and an admission whose store has no identity is still accepted and claims nothing. A different or missing store means unknown. The same store means only that it retains no such record, never that the run did not start. After a bound launch receipt has returned, a `--json` or `--json-stream` run whose subsequent detail read fails keeps that receipt's `jobId` and `storeId` (or task group) beside `runId` in the failure envelope. This does not cover an error while still awaiting the admission outcome. A thread-turn refusal no longer passes a producer's `storeId` through as if the server had said it. Other run-scoped 404 routes still name no store.
