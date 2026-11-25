# @claudexor/artifact-store

## 6.4.1

### Patch Changes

- @claudexor/util@6.4.1

## 6.4.0

### Patch Changes

- @claudexor/util@6.4.0

## 6.3.0

### Patch Changes

- Updated dependencies [cdcd850]
  - @claudexor/util@6.3.0

## 6.2.0

### Patch Changes

- @claudexor/util@6.2.0

## 6.1.2

### Patch Changes

- a20bc45: The daemon no longer stops answering while running lanes write their event
  files. Every harness event used to be written to the run's `events.jsonl`, and
  to the attempt and reviewer journals, on the daemon's main thread, so on a slow
  or busy disk each write held every control request, event stream and other lane
  until the disk answered. These writes now go to the disk in the background, in
  order and one write at a time per file, and a lane whose harness produces events
  faster than the disk takes them slows down to the disk's pace while the rest of
  the daemon keeps serving; that wait does not count as the harness being silent
  for `runtime.harness_inactivity_timeout_ms`, and each one starts the window
  again, so a harness whose status output alone keeps filling the journal is not
  cut off by it. Creating and removing a lane's workspace, removing a read-only
  lane's scratch home, keeping an unfinished run's workspace for a later
  continuation, writing a run's final answer, patch, facts and summary (the run
  telemetry file is still written on the main thread, under its own label) and the
  Git watchdog's progress check no longer wait on the disk either, and a spawned
  process's identity is read once instead of twice. A final file being replaced is
  never seen half written.

  A run's progress lines reach `events.jsonl` and live streams a moment after the
  harness produced them, never out of order. The lines a run waits for (its
  creation, a question to you, a live message) and its final event are on disk
  before the run goes on. If a line the run wrote cannot be written by the time it
  finishes, fails or is cancelled, the run's final event still lands and names the
  failure ("Run events did not reach the journal"); a line that fails while that
  final event is already being prepared is missing and not named. A control audit,
  a live message or a run's own diagnostic line is never refused for another line's
  failure, and never hides it. If
  the daemon process crashes, the last progress lines of a run can be missing from
  its event file. The daemon status's `worstSync` list can now name six more
  sections, the work that still runs on the main thread:
  `process.identity_capture`, `run.telemetry_write`, `metrics.harness_write`,
  `file.write_text`, `file.capture_write` and `daemon.log_line`.

- Updated dependencies [a20bc45]
  - @claudexor/util@6.1.2

## 6.1.1

### Patch Changes

- @claudexor/util@6.1.1

## 6.1.0

### Patch Changes

- Updated dependencies [577e275]
  - @claudexor/util@6.1.0

## 6.0.0

### Patch Changes

- Updated dependencies [b9e88de]
  - @claudexor/util@6.0.0

## 5.1.0

### Patch Changes

- Updated dependencies [b1320a9]
  - @claudexor/util@5.1.0

## 5.0.2

### Patch Changes

- Updated dependencies [6ba9b91]
  - @claudexor/util@5.0.2

## 5.0.1

### Patch Changes

- @claudexor/util@5.0.1

## 5.0.0

### Patch Changes

- Updated dependencies [8bae6ae]
- Updated dependencies [d9e7977]
  - @claudexor/util@5.0.0

## 4.8.2

### Patch Changes

- Updated dependencies [97e2f17]
  - @claudexor/util@4.8.2

## 4.8.1

### Patch Changes

- @claudexor/util@4.8.1

## 4.8.0

### Patch Changes

- Updated dependencies [6c31c44]
- Updated dependencies
  - @claudexor/util@4.8.0

## 4.7.1

### Patch Changes

- @claudexor/util@4.7.1

## 4.7.0

### Patch Changes

- @claudexor/util@4.7.0

## 4.6.2

### Patch Changes

- @claudexor/util@4.6.2

## 4.6.1

### Patch Changes

- @claudexor/util@4.6.1

## 4.6.0

### Patch Changes

- Updated dependencies [a81897c]
  - @claudexor/util@4.6.0

## 4.5.0

### Patch Changes

- @claudexor/util@4.5.0

## 4.4.0

### Minor Changes

- Adds `writePatch`, which stores immutable run patches as one content-addressed object per project, hard-linked where the filesystem supports it and copied otherwise (#477).

### Patch Changes

- Updated dependencies
  - @claudexor/util@4.4.0

## 4.3.1

### Patch Changes

- @claudexor/util@4.3.1

## 4.3.0

### Patch Changes

- @claudexor/util@4.3.0

## 4.2.0

### Patch Changes

- @claudexor/util@4.2.0

## 4.1.1

### Patch Changes

- @claudexor/util@4.1.1

## 4.1.0

### Patch Changes

- @claudexor/util@4.1.0

## 4.0.1

### Patch Changes

- @claudexor/util@4.0.1

## 4.0.0

### Patch Changes

- Updated dependencies [2fbf7c9]
  - @claudexor/util@4.0.0

## 3.25.1

### Patch Changes

- @claudexor/util@3.25.1

## 3.25.0

### Patch Changes

- @claudexor/util@3.25.0

## 3.24.0

### Patch Changes

- @claudexor/util@3.24.0

## 3.23.2

### Patch Changes

- @claudexor/util@3.23.2

## 3.23.1

### Patch Changes

- @claudexor/util@3.23.1

## 3.23.0

### Patch Changes

- @claudexor/util@3.23.0

## 3.22.1

### Patch Changes

- Updated dependencies [902532e]
  - @claudexor/util@3.22.1

## 3.22.0

### Patch Changes

- @claudexor/util@3.22.0

## 3.21.0

### Patch Changes

- Updated dependencies [9ccd45d]
  - @claudexor/util@3.21.0

## 3.20.1

### Patch Changes

- @claudexor/util@3.20.1

## 3.20.0

### Patch Changes

- Updated dependencies [c12828c]
  - @claudexor/util@3.20.0

## 3.19.0

### Patch Changes

- @claudexor/util@3.19.0

## 3.18.0

### Patch Changes

- @claudexor/util@3.18.0

## 3.17.2

### Patch Changes

- @claudexor/util@3.17.2

## 3.17.1

### Patch Changes

- @claudexor/util@3.17.1

## 3.17.0

### Patch Changes

- @claudexor/util@3.17.0

## 3.16.0

### Patch Changes

- @claudexor/util@3.16.0

## 3.15.1

### Patch Changes

- @claudexor/util@3.15.1

## 3.15.0

### Patch Changes

- @claudexor/util@3.15.0

## 3.14.0

### Patch Changes

- @claudexor/util@3.14.0

## 3.13.0

### Patch Changes

- @claudexor/util@3.13.0

## 3.12.10

### Patch Changes

- @claudexor/util@3.12.10

## 3.12.9

### Patch Changes

- @claudexor/util@3.12.9

## 3.12.8

### Patch Changes

- @claudexor/util@3.12.8

## 3.12.7

### Patch Changes

- @claudexor/util@3.12.7

## 3.12.6

### Patch Changes

- @claudexor/util@3.12.6

## 3.12.5

### Patch Changes

- @claudexor/util@3.12.5

## 3.12.4

### Patch Changes

- @claudexor/util@3.12.4

## 3.12.3

### Patch Changes

- @claudexor/util@3.12.3

## 3.12.2

### Patch Changes

- @claudexor/util@3.12.2

## 3.12.1

### Patch Changes

- @claudexor/util@3.12.1

## 3.12.0

### Patch Changes

- @claudexor/util@3.12.0

## 3.11.0

### Patch Changes

- @claudexor/util@3.11.0

## 3.10.5

### Patch Changes

- @claudexor/util@3.10.5

## 3.10.4

### Patch Changes

- @claudexor/util@3.10.4

## 3.10.3

### Patch Changes

- @claudexor/util@3.10.3

## 3.10.2

### Patch Changes

- @claudexor/util@3.10.2

## 3.10.1

### Patch Changes

- @claudexor/util@3.10.1

## 3.10.0

### Patch Changes

- @claudexor/util@3.10.0

## 3.9.8

### Patch Changes

- @claudexor/util@3.9.8

## 3.9.7

### Patch Changes

- @claudexor/util@3.9.7

## 3.9.6

### Patch Changes

- @claudexor/util@3.9.6

## 3.9.5

### Patch Changes

- @claudexor/util@3.9.5

## 3.9.4

### Patch Changes

- @claudexor/util@3.9.4

## 3.9.3

### Patch Changes

- @claudexor/util@3.9.3

## 3.9.2

### Patch Changes

- @claudexor/util@3.9.2

## 3.9.1

### Patch Changes

- @claudexor/util@3.9.1

## 3.9.0

### Patch Changes

- @claudexor/util@3.9.0

## 3.8.4

### Patch Changes

- @claudexor/util@3.8.4

## 3.8.3

### Patch Changes

- @claudexor/util@3.8.3

## 3.8.2

### Patch Changes

- @claudexor/util@3.8.2

## 3.8.1

### Patch Changes

- Updated dependencies [ce6dba1]
- Updated dependencies [2794ec7]
  - @claudexor/util@3.8.1

## 3.8.0

### Patch Changes

- @claudexor/util@3.8.0

## 3.7.0

### Patch Changes

- @claudexor/util@3.7.0

## 3.6.0

### Patch Changes

- @claudexor/util@3.6.0

## 3.5.0

### Patch Changes

- Updated dependencies [2316ef8]
  - @claudexor/util@3.5.0

## 3.4.2

### Patch Changes

- @claudexor/util@3.4.2

## 3.4.1

### Patch Changes

- @claudexor/util@3.4.1

## 3.4.0

### Patch Changes

- @claudexor/util@3.4.0

## 3.3.16

### Patch Changes

- @claudexor/util@3.3.16

## 3.3.15

### Patch Changes

- @claudexor/util@3.3.15

## 3.3.14

### Patch Changes

- @claudexor/util@3.3.14

## 3.3.13

### Patch Changes

- @claudexor/util@3.3.13

## 3.3.12

### Patch Changes

- @claudexor/util@3.3.12

## 3.3.0

### Patch Changes

- @claudexor/util@3.3.0

## 3.2.1

### Patch Changes

- @claudexor/util@3.2.1

## 3.2.0

### Patch Changes

- @claudexor/util@3.2.0

## 3.1.2

### Patch Changes

- @claudexor/util@3.1.2

## 3.1.1

### Patch Changes

- @claudexor/util@3.1.1

## 3.1.0

### Patch Changes

- @claudexor/util@3.1.0

## 3.0.3

### Patch Changes

- @claudexor/util@3.0.3

## 3.0.0

### Patch Changes

- @claudexor/util@3.0.0

## 2.1.3

### Patch Changes

- @claudexor/util@2.1.3

## 2.1.2

### Patch Changes

- @claudexor/util@2.1.2

## 2.1.1

### Patch Changes

- @claudexor/util@2.1.1

## 2.1.0

### Patch Changes

- @claudexor/util@2.1.0

## 2.0.2

### Patch Changes

- @claudexor/util@2.0.2

## 2.0.1

### Patch Changes

- @claudexor/util@2.0.1

## 2.0.0

### Patch Changes

- @claudexor/util@2.0.0

## 0.15.0

See the root CHANGELOG.md v0.15.0 entry (stabilization program release: concept freeze, model governance, run honesty, routing/output reality, per-commit review gate, MCP/ACP surface upgrade + integration suite).

## 0.14.1

### Patch Changes

- @claudexor/util@0.14.1

## 0.14.0

### Patch Changes

- @claudexor/util@0.14.0

## 0.13.3

### Patch Changes

- @claudexor/util@0.13.3

## 0.12.1

### Patch Changes

- @claudexor/util@0.12.1
