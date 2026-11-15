---
"@claudexor/acp-server": minor
"@claudexor/harness-acp": minor
---

Update the ACP SDK from 1.5.1 to 2.6.0. Claudexor keeps using the SDK's stable
v1 export, so the wire protocol stays ACP version 1 for `claudexor acp serve`
and the Copilot client. `acp serve` now refuses any request other than
`initialize` before the first successful handshake with JSON-RPC `-32600`,
without reaching the daemon. A repeated `initialize` is still answered; the
Copilot client already initializes first.

`session/new`, `session/load` and `session/resume` now reject malformed
`mcpServers` or `additionalDirectories` with `-32602`, instead of silently
skipping invalid entries as SDK 1.5.1 did. Clients must send the stable-v1
parameter shapes. JSON-RPC batches receive `-32600` without closing the
connection; ACP still does not process batches. These stricter experimental ACP
contracts are delivered as a minor change, as documented in the stability policy.
