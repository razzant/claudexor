# @claudexor/journal

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

### Minor Changes

- 1b1476c: The durable journal now replays its file frame by frame instead of loading it whole, so daemon startup memory follows the retained record set rather than the journal size. Callers may supply a fold policy that is applied at replay and at background compaction; sequence numbers, the epoch and live cursors are preserved across compaction, dead records are dropped from the file per that policy, snapshots may span several frames, background maintenance re-requests itself when the file crosses the threshold again, and a declined maintenance pass is reported with a typed reason instead of `null`. An engine from before this change refuses a folded journal loudly rather than reading a partial history. `compactionThresholdBytes` now measures growth since the last background pass that reached the data — an install, a real decline or a failed pass — and a folded replay at open counts as that first pass, so a restart on an already-compacted partition above the threshold no longer rewrites it to reclaim nothing.

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

- Preserve useful contradictory Council drafts as explicitly unverified merger inputs and move journal maintenance after admission, including Windows pending-tail recovery and native coverage.
  - @claudexor/util@3.10.2

## 3.10.1

### Patch Changes

- @claudexor/util@3.10.1

## 3.10.0

### Patch Changes

- dd518f0: Reduce journal startup work by selecting projection record types before copying payloads and validating run-event projections once during creation. Stop compression at the existing frame output limit while preserving full history, recovery checks, and compaction maintenance.
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

- 16f0c27: Keep prepared journal activation healthy for large compacted snapshots by
  replaying records without one whole-array string conversion and treating an
  unmaterializable opportunistic compaction as a no-op.
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
