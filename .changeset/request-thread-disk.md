---
"claudexor": patch
"@claudexor/daemon": patch
"@claudexor/schema": patch
"@claudexor/config": patch
"@claudexor/cli": patch
---

Upload bytes, model-request reads and the full trust-file list no longer run on the daemon's request thread. A scoped trust entry says whether it came from a file or from defaults, so a caller can tell a missing grant from an explicit refusal without listing every repo. The daemon sizes its libuv pool from the host when that variable is unset, and upload writes leave two of those threads free so DNS still runs while parts are being written.
