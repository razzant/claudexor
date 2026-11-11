---
"@claudexor/daemon": patch
"@claudexor/cli": patch
---

Reclaiming expired upload bindings no longer stops the daemon at the end of a
retention pass. It used to read every binding's upload and resource in one
synchronous loop; on a store with hundreds of thousands of uploads that held the
event loop for minutes, and every model operation, upload and control request
waited. The cleanup now works in bounded steps (a window of rows, or a batch of
at most 100 upload targets) and yields after each one. It stops when the pass is
cancelled, and such a pass is recorded as truncated. A finished scan repeats at
the hourly age revisit, not after every continuation pass.
