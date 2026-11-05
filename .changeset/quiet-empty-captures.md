---
"@claudexor/orchestrator": patch
"@claudexor/control-api": patch
---

Record `capturedNoGitChange` when a complete Git capture proves that the base and candidate trees are equal, so those no-change patches follow the ordinary age and keep-last retention window. Legacy, refused, incomplete and directory captures retain their actionable hold, and failed checks or blocked review still take precedence.
