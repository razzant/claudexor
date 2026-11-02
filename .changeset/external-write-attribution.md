---
"@claudexor/daemon": patch
"@claudexor/util": patch
---

A slow external file write is now attributed in the daemon log. When a write becomes one of the 32 worst synchronous sections that `GET /v2/daemon/status` reports as `worstSync`, the daemon also logs one `store.external_write` line naming what it carried (a large stored body, a run's terminal receipt, a terminal event-log rewrite, or an import), its byte count, and how its time split between metadata calls, the write-through data write, and the publishing rename. The status schema and its labels are unchanged.
