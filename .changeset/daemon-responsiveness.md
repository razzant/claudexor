---
"@claudexor/schema": minor
"@claudexor/daemon": minor
"@claudexor/control-api": minor
"@claudexor/event-log": minor
"@claudexor/util": minor
"@claudexor/config": minor
"@claudexor/harness-codex": minor
"@claudexor/cli": minor
---

Keep the daemon responsive under load without changing any on-disk format. The control API, model operations and harness maintenance reach the daemon's dispatcher in process (`DaemonLocalClient`), so a slow event loop no longer turns their calls into ten-second `daemon_busy` failures; problem fields are unchanged and socket clients keep their transport bound. `ControlDaemonStatus.loop` reports the last ten-second event-loop window (delay p50/p99/max, busy share, GC pauses) as facts, and `claudexor daemon status` prints it. `POST /v2/projects` answers `created`, which `claudexor project register` prints. Run detail reads `lastSeq` from the live writer or the log tail, the project list computes nesting in one pass, `appendLine` takes Node's UTF-8 write without a mkdir per line, Codex rate limits are read incrementally, pid snapshots are written asynchronously on change only, per-request config reads reuse the parse until a source changes, and the control API sets explicit HTTP keep-alive, header and request timeouts.
