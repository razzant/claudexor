---
"@claudexor/cli": minor
"@claudexor/delivery": minor
---

`claudexor scanner prepare [--from-archive <file>]` prepares the pinned publication scanner that `pr` delivery requires (#578). An npm install bundles no scanner and its only way to get one was a script in the source tree, so `pr` from npm refused with no supported path forward. The command downloads the pinned official archive, or takes one you already have, proves both digests and the license and places the complete copy under this machine's config root. Installed package files are not written, and a running daemon uses the copy at its next `pr` with no restart. A complete copy already there is reused, anything else there is reported and left untouched, concurrent runs reuse the winner, and an interrupt ends the extraction and activates nothing. `pr` still never downloads, and the scanner lookup order is unchanged.
