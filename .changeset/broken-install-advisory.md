---
"@claudexor/core": patch
"@claudexor/harness-codex": patch
---

Doctor and discover now explain WHY the codex CLI failed to resolve when the filesystem still holds evidence of an install: a dangling Homebrew symlink, a stripped exec bit, a directory shadowing the name, or a Caskroom/Cellar registration whose payload vanished — each with the exact `brew reinstall [--cask]` remediation. Diagnostic only: never gates a run, never executes a package manager. The codex doctor probes and diagnoses in the same scoped environment.
