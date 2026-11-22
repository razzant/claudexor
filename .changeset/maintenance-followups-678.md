---
"@claudexor/cli": patch
---

Vendor program updates skip a redundant version check when there is nothing to clean up. If an update selects an unsupported major, its receipt reports the observed change and identifies the incompatible version. Maintenance errors with an empty code now retain their original diagnostic instead of failing to build the receipt.
