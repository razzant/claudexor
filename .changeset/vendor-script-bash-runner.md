---
"@claudexor/cli": patch
---

`claudexor harness install agy|cursor` on Linux and macOS now runs the downloaded vendor script with `/bin/bash` instead of `/bin/sh` (#639). Both vendor installers are Bash programs (Antigravity's starts with `#!/bin/bash` and `set -euo pipefail`; Cursor's uses `${VAR//…}` and `[[ … ]]`), and on Debian and Ubuntu `/bin/sh` is dash, which rejected Antigravity's script with exit 2 before it did anything. The disclosed command names the same `/bin/bash` runner. A host without `/bin/bash` now gets the typed `installer_interpreter_missing` refusal before anything is downloaded, with no `sh` fallback. Download, size and SHA-256 disclosure, the human-observed and unattended evidence classes, failure codes, cleanup and Antigravity's Windows PowerShell runner are unchanged.
