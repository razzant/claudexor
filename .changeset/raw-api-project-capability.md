---
"@claudexor/harness-raw-api": patch
"@claudexor/orchestrator": patch
"@claudexor/review": patch
---

A Raw API route reads no project files, so it no longer plans a project or reviews a change (#137). Change review is admitted only for a harness that declares it reads files itself, whatever it declares about review. An explicit project Plan, Council or reviewer panel on such a route refuses before any request is sent, and automatic selection skips the route with its reason, whether or not it has a saved account. Reviewers a library caller injects through `OrchestratorDeps.reviewers` or passes to `reviewCandidate` are held to the same test: one that does not declare `read_files: true`, or whose discovery fails, refuses the whole list before any reviewer or candidate runs. Ask without a project and Agent implementation stay supported, and a Council merge that cannot read its drafts is refused before it is paid for instead of after.
