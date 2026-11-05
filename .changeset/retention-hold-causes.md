---
"@claudexor/daemon": patch
"@claudexor/control-api": patch
"@claudexor/cli": patch
---

Carry the retention observer's latched cause into the GC hold example, so a
generation becoming an owner or a registry transition names the affected partition
instead of reporting only that references changed.
