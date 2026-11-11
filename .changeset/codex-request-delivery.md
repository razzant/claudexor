---
"@claudexor/harness-codex": minor
---

Caller-owned Codex model requests are smaller and their failures are named more
truthfully. The request body is zstd-compressed (`Content-Encoding: zstd`), about
a third of its size on real conversations; `CLAUDEXOR_CODEX_REQUEST_COMPRESSION=off`
turns that off. A send that failed before the request began to be written is
`transport_not_delivered` whatever the error's code, and so is the provider's
HTTP 408, which used to read as an invalid request and keeps its request id and
retry hint. The two five-minute response timeouts are set by the engine on its
own request, and a call one of them ends names that timeout in words while
keeping the library's code as the fact.
