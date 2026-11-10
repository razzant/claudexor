---
"@claudexor/workspace": patch
"@claudexor/delivery": patch
"@claudexor/orchestrator": patch
"@claudexor/cli": patch
---

A file a Raw API patch created is no longer lost when a Git ignore rule matches
it (#594). The paths an accepted raw patch wrote stay in the candidate: the next
round's tree, the run's result, Apply and Revert carry them by exact path while
each is still a file, also after a fresh workspace manager, a `continueFrom`
successor that adopts the kept envelope, or orphan recovery. Other ignored files,
a gate's output or a native round's, stay out as before, also when a later patch
makes the ignore rules match them, and so does a file inside an ignored nested
repository. The record lives in per-worktree refs of the envelope's own
repository and is written before the patch's first byte lands; a record that
cannot be written or read refuses the patch, or the capture, instead of dropping
the file. Git before 2.43 cannot tell a failed record lookup from a missing one
and reads it as no record. A persistent thread's Raw API turns keep such files
between turns, before any Apply; a candidate that was rejected or did not win
changes neither the thread's files nor its record.
