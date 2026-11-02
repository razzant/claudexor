---
"@claudexor/cli": patch
---

`GET /v2/agent-capabilities` (and the MCP `claudexor_capabilities` tool, which reads it) now uses the daemon's existing status-projection cache, the same one default `GET /v2/harnesses` reads use. Concurrent reads share one harness sweep, a computed catalog is served for 15 seconds (its `generatedAt` says when it was built), a change to the global config recomputes it at once, and the daemon's credential mutations and setup logins invalidate it. Callers that read the catalog for one static fact, such as a harness row's `liveInput`, no longer each start a full discovery, doctor and model-inventory sweep, nor leave several sweeps running after they give up. `claudexor capabilities` still composes the catalog in-process.
