---
"@claudexor/cli": patch
---

Callers of the shared control-API client no longer pass their own `Authorization` header; the client already sets it on every request. Methods, URLs, header values and bodies are unchanged; only the header order on the wire can differ.
