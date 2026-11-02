---
"@claudexor/daemon": patch
"@claudexor/cli": patch
---

Large stored bodies (over 64 KiB) whose bytes are known before their database commit are now written to disk off the daemon's request thread: an enqueued command's parameters and its acceptance record, a finished run's returned result and its update record, a thread turn's prompt, and a deferred draft after its capture. The same write-through temp file is written on Node's file worker pool and linked into place only if that body is not already stored; the synchronous commit then finds it and only registers its directory for the usual durability barrier. The store creates its body directory, registered like any other new directory, before the first such write, so a new store, or one whose bodies all stayed small, stages too. Nothing about durability, ordering or the stored bytes changes, and if the staged file was cleaned up or staging failed, the commit writes the body itself as before. HTTP requests, Stop and stream heartbeats no longer wait behind those writes when the disk is slow.
