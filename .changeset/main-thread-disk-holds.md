---
"@claudexor/util": patch
"@claudexor/event-log": patch
"@claudexor/orchestrator": patch
"@claudexor/review": patch
"@claudexor/core": patch
"@claudexor/workspace": patch
"@claudexor/artifact-store": patch
"@claudexor/budget": patch
"@claudexor/control-api": patch
"@claudexor/daemon": patch
"@claudexor/delivery": patch
"@claudexor/harness-codex": patch
"@claudexor/schema": patch
"@claudexor/cli": patch
"claudexor": patch
---

The daemon no longer stops answering while running lanes write their event
files. Every harness event used to be written to the run's `events.jsonl`, and
to the attempt and reviewer journals, on the daemon's main thread, so on a slow
or busy disk each write held every control request, event stream and other lane
until the disk answered. These writes now go to the disk in the background, in
order and one write at a time per file, and a lane whose harness produces events
faster than the disk takes them slows down to the disk's pace while the rest of
the daemon keeps serving. Creating and removing a lane's workspace, removing a
read-only lane's scratch home, keeping an unfinished run's workspace for a later
continuation, writing a run's final answer, patch, facts and summary (the run
telemetry file is still written on the main thread, under its own label) and the
Git watchdog's progress check no longer wait on the disk either, and a spawned
process's identity is read once instead of twice. A final file being replaced is
never seen half written.

A run's progress lines reach `events.jsonl` and live streams a moment after the
harness produced them, never out of order. The lines a run waits for (its
creation, a question to you, a live message) and its final event are on disk
before the run goes on. If a progress line cannot be written, the run's final
event still lands and says so ("Run events did not reach the journal"), and a
control audit or a live message is never refused for another line's failure. If
the daemon process crashes, the last progress lines of a run can be missing from
its event file. The daemon status's `worstSync` list can now name six more
sections, the work that still runs on the main thread:
`process.identity_capture`, `run.telemetry_write`, `metrics.harness_write`,
`file.write_text`, `file.capture_write` and `daemon.log_line`.
