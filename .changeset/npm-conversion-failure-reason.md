---
"@claudexor/cli": patch
---

Harness Update keeps the reason a product-made npm copy was not replaced. When
the vendor installer exits nonzero and the conversion then fails, the installer's
exit still decides the problem, and the conversion's own code and message are now
added to the receipt's `limitations` instead of disappearing. When a failed commit
check also cannot restore the hidden old package, the error keeps the original
failure and names the restore error and the `<package>.claudexor-converted`
location, which the next explicit maintenance recovers; it no longer reports only
the restore error.
