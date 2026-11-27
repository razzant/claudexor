---
"@claudexor/workspace": patch
"@claudexor/orchestrator": patch
"@claudexor/review": patch
"@claudexor/delivery": patch
"@claudexor/control-api": patch
"@claudexor/schema": patch
---

Directory runs no longer write a large sparse file (a VM disk image, for example) densely or more than once (#783).

- Copies keep holes: a stream writes only the 4 KiB blocks that hold data. Only engine-owned immutable blobs are cloned, where the runtime can (a Linux reflink); macOS has no clone in Node, and APFS fills holes shorter than about 16 MiB.
- Within one run each digest is stored once and linked into every attempt, the run's final files and review evidence; writable copies stay independent.
- From 1 MiB a copy first needs the file's full length plus 64 MiB free; with unknown free space, copies of 64 MiB or more are refused. Lack of room is a typed `capture_space_insufficient` refusal at every step.
- Apply, its replay, `accept_clean_patch` and `apply/check` answer lack of room with `refusal.code: space_insufficient` and the paths actually written, instead of HTTP 400.
- A refused publication fails only a clean success; beside another cause its failure record keeps the refusal and the kept copy. A cancellation keeps another attempt's failed capture.
