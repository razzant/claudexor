# @claudexor/cli

The Claudexor command-line interface — the primary supported entry point of
[Claudexor](https://github.com/joi-lab/claudexor): a harness-agnostic AI
coding control plane over Codex CLI, Claude Code, Cursor CLI, and OpenCode.

Install the friendly bin wrapper instead of depending on this package
directly:

```bash
npm install -g claudexor
claudexor doctor
```

This package ships the CLI implementation and the explicit `./cli` and
`./claudexord` entry exports; the GLOBAL bin names are owned by the bare
`claudexor` wrapper package (one bin owner, no collisions), so
`npm install -g @claudexor/cli` intentionally installs NO bins — install
`claudexor` instead. It follows the
monorepo's lockstep version; the STABLE contract is the CLI surface itself
(`claudexor help --json`) and the documented `--json` outputs — not this
package's internal module shape.
