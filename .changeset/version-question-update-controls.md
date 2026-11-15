---
"@claudexor/core": patch
---

Version checks ask the selected program under its adapter-declared update controls.
Copilot is asked `--no-auto-update --version` and Cursor
`--disable-auto-update --version`; Antigravity and Grok receive their declared
environment values. Inventory, doctor, maintenance receipts, npm-copy conversion and
program provenance on model lists therefore observe the program in that declared mode. Copilot
documents that its switch keeps a newer cached version from running instead of the
installed one. Before, such a cached version could answer for an older installed copy,
hide an older replacement during conversion or turn an exact-version request into a
false no-op. Receipts recorded earlier keep the answers they received.

A program that rejects its declared switch reports no version, as its runs already fail.
The existing second read repeats the same switched question, no check falls back to an
unswitched one, and the 10-second limit is unchanged, so a later answer stays unknown.
Explicit install, update and exact-version commands keep their own arguments and
installation environment.
