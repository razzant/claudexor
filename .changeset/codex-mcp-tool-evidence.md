---
"@claudexor/harness-codex": patch
"@claudexor/harness-claude": patch
---

Codex MCP tool results keep what the server returned. A completed call now carries the text of its result, or its structured content when no text came back, as the bounded `content_summary`, so a Browser navigation records the page URL and title it actually loaded instead of only the tool name. A failed call keeps the vendor's `error.message`, or the text of a result the server marked as an error, instead of a generic "mcp tool call failed". A completion with any other status is no longer reported as a success; it stays statusless. Tool names and the `server:tool` target that Browser and Delegate evidence match are unchanged. In both Codex and Claude, an MCP result's `content_summary` now keeps the line breaks of the server's text, so a Browser result's page fields, code and snapshot stay on their own lines; whitespace within a line still collapses, blank lines are dropped, and the 1,000-character bound is unchanged. The `error_summary`, the event text and the summaries of all other tools stay on one line.
