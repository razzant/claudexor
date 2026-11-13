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
the daemon keeps serving. Creating and removing a lane's workspace, writing a
run's final artifacts and the Git watchdog's progress check no longer wait on
the disk either, and a spawned process's identity is read once instead of
twice.

A run's progress lines reach `events.jsonl` and live streams a moment after the
harness produced them, never out of order. The lines a run waits for (its
creation, a question to you, a live message) and its final event are on disk
before the run goes on. If the daemon process crashes, the last progress lines of
a run can be missing from its event file. The daemon status's `worstSync` list
can now name five more sections, the work that still runs on the main thread:
`process.identity_capture`, `run.telemetry_write`, `metrics.harness_write`,
`file.write_text` and `daemon.log_line`.
