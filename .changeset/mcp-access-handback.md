---
"@claudexor/harness-codex": patch
---

Codex workspace-write runs can hand simple MCP requests and correlated
automatic-review MCP denials back to their controller. A denial retry remains
under native review and does not promise argument-bound authorization. Local
repeat detection compares MCP arguments by their exact key-order-independent
JSON, keeping own `__proto__` keys, and completed turns do not exhaust later
turns' call correlation.
