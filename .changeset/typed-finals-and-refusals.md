---
"@claudexor/schema": minor
"@claudexor/event-log": patch
"@claudexor/orchestrator": patch
"@claudexor/control-api": patch
"@claudexor/mcp-server": patch
"@claudexor/acp-server": patch
"@claudexor/cli": patch
"@claudexor/context": patch
"@claudexor/core": patch
"@claudexor/daemon": patch
"@claudexor/harness-claude": patch
"@claudexor/harness-codex": patch
"@claudexor/harness-agy": patch
---

Recover earlier typed final messages in journal order, with attempt and
provenance. Control GET, MCP result reads and ACP accept `includeFinalMessages`.
CLI inspect accepts `--include-final-messages`. A recorded document transfers
with its verified size and digest. Default reads and launches keep their original shape.

Codex text operations advertise `typedRefusals`. A failed content refusal
ends the request without retrying or penalizing the account. Public Codex
failure details omit or mask unrecognized provider diagnostics. A completed
refusal remains an assistant answer with usage and any tool calls. Claude
Code closes input on a confirmed quota refusal of its own command and still
collects late receipts. A late queue acknowledgment is distinguishable from
actual consumption without sending the message again.

Mandatory-file refusals name the execution root and affected files. Context
paths must resolve inside that root. After repair, a saved turn with a
replayable job can be retried. A blocked Claude pin names a recorded
verification requirement. Antigravity print probes distinguish a timeout,
a bad response and a nonzero exit without exposing arbitrary vendor text.
