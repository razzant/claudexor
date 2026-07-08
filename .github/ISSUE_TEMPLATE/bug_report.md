---
name: Bug report
about: Something in the CLI, daemon, MCP/ACP surface, or macOS app misbehaves
title: ""
labels: bug
---

## What happened

A clear description of the bug and what you expected instead.

## Reproduce

Steps, ideally with the exact command:

```
claudexor ...
```

## Environment

- Claudexor version: (`claudexor --version` or git SHA)
- OS: (macOS 26 / Linux distro + version)
- Surface: (CLI / daemon / MCP / ACP / macOS app)
- Harness(es) involved: (codex / claude / cursor / opencode / raw-api)

## Evidence

Relevant output. For a run, `claudexor inspect <run_id>` and the run's
`.claudexor/runs/<id>/` artifacts are the most useful — please redact any
secrets first (Claudexor redacts what it can, but paste responsibly).
