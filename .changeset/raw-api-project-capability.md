---
"@claudexor/harness-raw-api": patch
"@claudexor/orchestrator": patch
---

A Raw API route reads no project files, so it no longer plans a project or reviews a change (#137). Change review is admitted only for a harness that declares it reads files itself, whatever it declares about review. An explicit project Plan, Council or reviewer panel on such a route refuses before any request is sent, and automatic selection skips the route with its reason, whether or not it has a saved account. Ask without a project and Agent implementation stay supported, and a Council merge that cannot read its drafts is refused before it is paid for instead of after.
