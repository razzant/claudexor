---
"@claudexor/workspace": patch
"@claudexor/orchestrator": patch
"@claudexor/review": patch
"@claudexor/delivery": patch
"@claudexor/control-api": patch
"@claudexor/schema": patch
"@claudexor/event-log": patch
"@claudexor/cli": patch
---

Directory runs keep a large sparse file (a VM disk image, for example) sparse when the source reports its holes and the destination filesystem keeps them, and store its bytes once per run where hard links are available (#783).

- A copy of a sparse source skips its all-zero 4 KiB blocks; an allocated file is written in full. Only engine-owned immutable blobs are cloned, where the runtime can (a Linux reflink); macOS has no clone in Node, APFS fills gaps up to about 16 MiB, and on Windows/NTFS the copy is not marked sparse.
- Within one run each digest is stored once and linked into every attempt, the run's final files and review evidence. Writable copies (attempt and review trees, verification and Apply targets) still write the bytes, and without hard links each stored name is its own copy.
- From 1 MiB a copy starts only when free space at that moment covers the file's full length plus 64 MiB; this is an observation, not a reservation, so concurrent copies can still run out of room (typed, partial file removed). Unknown free space refuses copies of 64 MiB or more. Lack of room is `capture_space_insufficient` with the system's code (`ENOSPC`, `EDQUOT`), except in the reviewer workspace's Git baseline, which fails as a Git error.
- Retiring run and review trees counts allocated bytes as reclaimable where the block count is evidence (POSIX; on Windows a zero count for a non-empty file counts its length); anchors and object-store files keep their logical length.
- A final check whose verification copy lacked room still blocks like failed checks (its cause is not kept on the decision): the advice is now to free the room first, then accept the risk and apply, which rebuilds and rechecks the copy. A refused publication beside a review, check or budget block states that block first and offers the kept files instead of an apply.
- Apply answers lack of room with `refusal.code: space_insufficient`, the path it stopped at, `appliedPaths` (completed writes) and `treeMutated`; `apply/check` writes nothing and answers only the typed refusal of its verification copy. A verification copy without room is unproven (`applied_cleanly: null`), never a conflict, and an accepted risk does not authorize it. `accept_clean_patch`, `claudexor apply` and the macOS app state Apply's facts in prose (the typed receipt is Apply's); `claudexor apply --dry-run` states the check's refusal.
- The delivery state is written with the delivery (a same-key replay changes nothing) and counts an earlier automatic delivery of the same manifest and paths the target already holds, so completing a partial delivery reads applied; a refusal that wrote nothing marks nothing. An accepted risk on a files result is shown by every run view.
- A refused publication fails only a clean success; another cause (executor, review, verification, a report that needs input or is incomplete) keeps leading the failure record and the returned summary, with the refusal and the kept copy after it. When only the journal after a written ready event fails, the files it names stay.
- One verification check reads each blob once for integrity and again to build its copy; an in-process review links its evidence through the run's index, while a standalone review verifies every blob.
