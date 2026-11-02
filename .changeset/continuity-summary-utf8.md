---
"@claudexor/orchestrator": patch
---

Thread continuation no longer turns a character cut at a size limit into U+FFFD (#577). The summary pass's input (2 KiB per prompt or answer, in UTF-8 bytes), its 8 KiB summary and the fallback one-line entries (200 UTF-16 code units) now end on a whole character, which can keep slightly less than the limit; the `…` marking a cut is not counted in it, and text that fits is unchanged. The run-continuation evidence index cuts a tool target (160 UTF-16 code units) and a tool name taken from event text (80) the same way. Limit: a summary saved before this change is reused as saved, including any U+FFFD its byte cut left, until a new head turn advances the collapse boundary; it is not regenerated or migrated.
