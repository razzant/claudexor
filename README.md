# Claudex

> Harness-agnostic, local-first, evidence-driven AI coding control plane.

Claudex orchestrates **Codex CLI**, **Claude Code**, **Cursor CLI**, and **OpenCode** (plus future harnesses) as interchangeable *harnesses* — no privileged harness, no hardcoded roles. It adds best-of-n tournaments, cross-family adversarial review with evidence-grounded findings, budget/quota balancing across subscriptions and API keys, and reproducible benchmark runs.

It collapses cleanly to a single native harness: configure only Codex and it feels like Codex plus artifacts, policies, and a budget ledger; add Claude and it becomes stronger through cross-review and synthesis.

> Status: **v0.1.0 — under active construction** (breadth-first build). Codename `Claudex`; package/binary name is kept abstract pending a naming gate. Ships a reproducible SWE-bench Verified runner.

## Why

The leader among Codex / Claude / Cursor / OpenCode keeps changing. Switching, combining, reviewing, and budget-balancing them by hand is tedious. Claudex turns unstable AI coding agents into a reproducible, evidence-driven, budget-aware software development system — and the best performance is at the seam, where harnesses check each other.

## Core ideas

- **No privileged harness, no hardcoded roles.** Every role (plan / implement / review / synthesize / arbitrate / benchmark …) is an *intent*; any harness that declares the capability can be assigned it.
- **Evidence over vibes.** Findings require `file:line` / diff / command / log evidence; winners are chosen by hard gates and acceptance coverage first, LLM judgment only as a grounded tiebreak.
- **No silent truncation.** Context is accounted for; omissions are explicit.
- **Files-first SSOT.** Append-only JSONL event log + typed YAML/JSON artifacts under `.claudex/`.
- **Local-first & privacy-first.** Your credentials, your machine; no SaaS broker.

## Modes

`daily` · `plan` · `create` (from scratch) · `race` (best-of-n) · `until-convergence` · `max-attempts` · `audit/map` (read-only swarm) · `benchmark`.

## Quickstart

```bash
pnpm install && pnpm build && pnpm test
node packages/cli/dist/cli.js doctor          # detect + conformance-test harnesses
node packages/cli/dist/cli.js run "fix the flaky auth refresh"
node packages/cli/dist/cli.js race "implement feature X" --n 4
node packages/cli/dist/cli.js inspect <run_id>
```

> Local Node note: on macOS 26.4 the OS code-signing monitor SIGKILLs Homebrew's
> adhoc-signed `node`. Use an official notarized Node (e.g. under `~/.claudex/node`).

## CLI surface

`init` · `doctor` · `run` (`--mode`) · `race` · `plan` · `create` · `audit`/`map` ·
`until-convergence`/`max-attempts` (via `--mode`) · `inspect <run_id>` ·
`apply <run_id>` (`--mode apply|commit|branch|pr` / `--dry-run`) ·
`daemon start|status|stop|logs` · `mcp serve` · `acp serve` ·
`plugin install <cursor|claude|codex|opencode>` · `bench list|instructions|run` ·
`release check-name <name>` · `harness list`. Every command supports `--json`.

## Embedding

Claudex exposes a stable CLI `--json`, a JSON-RPC-over-stdio boundary, and an MCP
server so other agents (e.g. Ouroboros) can use it as an edit/review substrate.
See [docs/EMBEDDING.md](docs/EMBEDDING.md).

## Documentation

- [docs/SPEC.md](docs/SPEC.md) — canonical technical specification.
- [docs/PLAN.md](docs/PLAN.md) — the build plan.
- [docs/DECISIONS.md](docs/DECISIONS.md) — design decision log.
- [AGENTS.md](AGENTS.md) — guidance for agents (and humans) working in this repo.

## License

[MIT](LICENSE) © 2026 joi-lab
