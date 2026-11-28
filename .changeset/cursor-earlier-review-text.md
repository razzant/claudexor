---
"@claudexor/schema": minor
"@claudexor/control-api": patch
"@claudexor/event-log": patch
"@claudexor/orchestrator": patch
"@claudexor/harness-cursor": patch
"@claudexor/cli": patch
---

Show a successful Cursor Ask or Agent run's speech after its matched background handoff before the accepted final, in order, even when tool reads or notices come between them. Narration only before the handoff is not selected. `GET /v2/runs/:id?includeEarlierAssistantOutput=true` adds `primaryOutput.earlierAssistantOutput` (bounded preview and artifact path) or `earlierAssistantOutputUnavailable`; the default response, the accepted answer, WorkReport and history keep their shapes. MCP results, text inspect, ACP turns and replay, and addressed macOS run details show the earlier text, or a short note when it could not be determined or read.
