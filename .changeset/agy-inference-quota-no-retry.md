---
"@claudexor/harness-agy": patch
"@claudexor/orchestrator": patch
---

AGY inference-quota refusals are now emitted as typed unknown-reopening quota
evidence. Claudexor preserves the vendor's original error and does not mistake
the refusal for a transport interruption that should retry the same native
session. No reset time is inferred; genuine transport failures keep their
existing continuation behavior.
