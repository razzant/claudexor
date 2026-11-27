---
"@claudexor/core": patch
---

Bump @playwright/mcp to 0.0.86 with its pinned Playwright runtime. The browser-page-retrieval recording is re-recorded against the new pin (the old 0.0.85 recording stays as the compatibility comparison), and the new recording covers the upstream 0.0.86 download fix: two downloads offering the same filename now land as two files, the second under a suffixed name, instead of overwriting the first.