---
"@claudexor/daemon": patch
"@claudexor/schema": patch
"@claudexor/config": patch
"@claudexor/cli": patch
---

Upload bytes, model-request reads and the full trust-file list no longer run on the daemon's request thread. A scoped trust entry says whether it came from a file or from defaults, so a caller can tell a missing grant from an explicit refusal without listing every repo.
