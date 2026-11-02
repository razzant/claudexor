---
"@claudexor/cli": patch
"@claudexor/mcp-server": patch
---

`GET /v2/agent-capabilities` (and the MCP `claudexor_capabilities` tool, which reads it) now uses the daemon's existing status-projection cache, the same one default `GET /v2/harnesses` reads use. Concurrent and in-window reads share one harness sweep, so at most one sweep runs at a time and about one per 15 seconds; the first read after the window still waits for a full sweep. A computed catalog is served for 15 seconds (its `generatedAt` says when it was built), on top of the doctor's own reuse of a report (by default 90 seconds when OK, 15 seconds otherwise), so an out-of-band change such as a vendor CLI login outside the daemon can take about 30 seconds (non-OK to OK) or 105 seconds (OK to broken) to show, plus sweep time. A change to the global config recomputes it at once, and the daemon's credential mutations and setup logins invalidate it. Callers that read the catalog for one static fact, such as a harness row's `liveInput`, no longer pile up concurrent discovery, doctor and model-inventory sweeps or leave several running after they give up. `claudexor capabilities` still composes the catalog in-process.
