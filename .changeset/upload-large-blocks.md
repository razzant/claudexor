---
"@claudexor/daemon": patch
"claudexor": patch
---

An uploaded file is now written to disk in blocks of at least 1 MiB instead of one
write per network chunk. A 3.8 MB model request used to take about sixty disk writes,
each needing a turn of the daemon's main thread to continue; it now takes four, so
uploads slow down far less when the daemon is busy. The bytes are still on the drive
before the upload reports `uploaded` (the same write-through files), every chunk is
still checked against the declared size before it is accepted, and the digest still
covers every byte. An upload keeps at most one block of unwritten bytes in memory.
