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
`<package>.claudexor-converted` location instead of reporting only the restore
error. The next explicit maintenance attempts to recover it and never overwrites
anything that occupies the original package path. Conversion failure messages
now say that conversion removed nothing instead of claiming the old copy is
unchanged, which was false when the vendor installer had removed it itself.
The three commit-boundary refusals now name what they compared: a changed
package/launcher relation shows the previous and current relation and the
ordinary selection it was read from, a changed selection shows the expected and
observed path, real path and version, and a changed launcher shows its path and
the differing stat fields with both values. Recovery limitation messages now use
the existing secret masker; structured paths and the recovery acknowledgement
are unchanged. These messages diagnose the intermittent Windows Copilot
conversion failure (#672); they do not fix it.
