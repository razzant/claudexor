---
"@claudexor/harness-codex": patch
---

Keep the history that saved and archived Codex forks need to resume, including
imports at the archive root and up to three directories below it. Only dated,
single-ID session rollouts can retire. Cleanup counts bases named by readable
headers even after encountering multiple unreadable files. A new reference with no recognized
filename ID in the inventory defers cleanup for this pass. If just one eligible
file has an unreadable header and no readable header names it as a base, it may
retire alone. An otherwise eligible file can remain on hold until the damaged
headers are repaired.
