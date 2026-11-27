---
"@claudexor/workspace": patch
"@claudexor/orchestrator": patch
"@claudexor/review": patch
"@claudexor/delivery": patch
"@claudexor/control-api": patch
"@claudexor/schema": patch
"@claudexor/event-log": patch
---

Directory runs no longer write a large sparse file (a VM disk image, for example) densely or more than once (#783).

- Copies keep holes where the destination can: a stream writes only the 4 KiB blocks that hold data. Only engine-owned immutable blobs are cloned, where the runtime can (a Linux reflink); macOS has no clone in Node, APFS fills holes shorter than about 16 MiB, and on Windows/NTFS the copy is not marked sparse, so its holes are filled.
- Within one run each digest is stored once and linked into every attempt, the run's final files and review evidence; every file is hashed before it is kept, so a repeated file needs no staged copy. Without hard links (or across volumes) each name gets one independent copy instead. Writable copies stay independent.
- From 1 MiB a copy first needs the file's full length plus 64 MiB free; with unknown free space, copies of 64 MiB or more are refused. Lack of room is a typed `capture_space_insufficient` refusal at every step, a directory workspace's preparation included, with the system's code (`ENOSPC`, `EDQUOT`) as its `causeCode`.
- Retention's reclaimable figure counts allocated bytes where the platform reports them, not the logical length; extents a clone shares are still counted in full.
- Apply, its replay and `apply/check` answer lack of room with `refusal.code: space_insufficient` and the paths actually written, instead of HTTP 400. A verification copy without room is unproven (`applied_cleanly: null`), never a conflict, and an accepted risk does not authorize it. `accept_clean_patch` keeps its response fields and states the refusal, the path it stopped at and the paths already written in its `message`; the typed receipt is the one Apply answers. Verification copies are not flushed and read each blob once per check.
- A delivery that completes an earlier partial one reads applied: the delivery state also counts the changes the target already holds against the same manifest, while each receipt's `appliedPaths` stay its own writes.
- A refused publication fails only a clean success; beside another cause (an executor's, review's or arbitration's error first) its failure record keeps the refusal and the kept copy. A run that reports it needs input or is incomplete keeps that reason and remedy, with a failure record naming the refusal. When only the journal after a written ready event fails, the files that event names stay. A cancellation keeps another attempt's failed capture.
