# Claudex

> Harness-agnostic, local-first, evidence-driven AI coding control plane.

Claudex orchestrates **Codex CLI**, **Claude Code**, **Cursor CLI**, and **OpenCode** (plus future harnesses) as interchangeable *harnesses* — no privileged harness, no hardcoded roles. It adds best-of-n tournaments, cross-family adversarial review with evidence-grounded findings, budget/quota balancing across subscriptions and API keys, and reproducible benchmark runs.

It collapses cleanly to a single native harness: configure only Codex and it feels like Codex plus artifacts, policies, and a budget ledger; add Claude and it becomes stronger through cross-review and synthesis.

> Status: **v0.1.0 — under active construction** (breadth-first build). Codename `Claudex`; package/binary name is kept abstract pending a naming gate. Benchmark-first proof target: SWE-bench Verified.

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

## Quickstart (target UX)

```bash
pnpm install && pnpm build
claudex init          # scaffold repo-local config
claudex doctor        # detect + conformance-test harnesses
claudex run "fix the flaky auth refresh"
claudex race "implement feature X" --n 4
claudex inspect <run_id>
```

## Documentation

- [docs/SPEC.md](docs/SPEC.md) — canonical technical specification.
- [docs/PLAN.md](docs/PLAN.md) — the build plan.
- [docs/DECISIONS.md](docs/DECISIONS.md) — design decision log.
- [AGENTS.md](AGENTS.md) — guidance for agents (and humans) working in this repo.

## License

[MIT](LICENSE) © 2026 joi-lab
