# claudexor

Harness-agnostic AI coding control plane: one CLI that drives Codex CLI,
Claude Code, Cursor CLI, and OpenCode with cross-family review, best-of-N
candidate runs, typed apply gates, and honest run artifacts.

```bash
npm install -g claudexor
claudexor doctor
claudexor ask "what does this repo do?"
claudexor agent "fix the failing test" --harness codex
claudexor best-of "fix add()" --harness codex,claude --n 2
```

This package is the bin wrapper over
[`@claudexor/cli`](https://www.npmjs.com/package/@claudexor/cli). Full
documentation lives in the
[Claudexor repository](https://github.com/razzant/claudexor#readme).
