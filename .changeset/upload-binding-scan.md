---
"@claudexor/daemon": patch
"@claudexor/cli": patch
---

The daemon no longer stops answering at the end of a retention pass. Reclaiming
expired upload bindings used to read every binding's upload and resource in one
synchronous loop; on a store with hundreds of thousands of uploads that held the
event loop for minutes, and every model operation, upload and control request
waited. The cleanup now reads a window of rows at a time, yields after each
window, deletes in short transactions, stops when the pass is cancelled and
resumes on the next pass. A finished scan repeats at the hourly age revisit,
not after every continuation pass.
