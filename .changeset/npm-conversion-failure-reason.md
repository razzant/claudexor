---
"@claudexor/cli": patch
---

Harness Update keeps the reason a product-made npm copy was not replaced. When
the vendor installer exits nonzero and the conversion then fails, the installer's
exit still decides the problem, and the conversion's own code and message are now
added to the receipt's `limitations` instead of disappearing. Text output of
`claudexor harness install|update` (without `--json`) now prints the receipt's
limitations before the problem or outcome line; JSON output and exit codes are
unchanged. When a failed commit check also cannot restore the hidden old package,
the error keeps the original failure and names the restore error and the
`<package>.claudexor-converted` location, which the next explicit maintenance
recovers; it no longer reports only the restore error. Conversion failure
messages now say that conversion removed nothing instead of claiming the old copy
is unchanged, which was false when the vendor installer had removed it itself.
