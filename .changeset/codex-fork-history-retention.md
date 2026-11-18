---
"@claudexor/harness-codex": patch
---

Keep the history that saved and archived Codex forks need to resume, including
forks located under imported names. Only dated, single-ID session rollouts can
retire. Cleanup counts known bases as it reads them. A new reference with no recognized
filename ID in the inventory defers cleanup for this pass. If just one eligible
file has an unreadable header and no readable header names it as a base, it may
retire alone. Unreadable headers hold the home only when an otherwise eligible
file must wait; the receipt distinguishes that hold from protected files.
