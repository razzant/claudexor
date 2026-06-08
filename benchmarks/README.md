# Claudex Benchmarks

Reproducible benchmark harnesses for Claudex. Two families, two paradigms:

- [`terminal_bench/`](terminal_bench/) — **Terminal-Bench 2.1** via the official
  **Harbor** harness. Stateful terminal tasks scored on container state. Claudex runs
  **in-place convergence + cross-family review** inside one container, so the benchmark
  measures Claudex's orchestration lift, not just a single model. Latest stable dataset
  only (no legacy `tb`).
- [`swe-bench/`](swe-bench/) — **SWE-bench** (Verified / Lite, with notes for Full,
  Pro, Live, Multimodal, Multilingual). Patch-oriented tasks scored by applying a diff
  and running hidden tests; Claudex uses best-of-N + cross-family review and emits
  predictions for the official evaluator.

## Why two paradigms

- Terminal-Bench tasks are **stateful**: you cannot merge two independent container
  states, so the lever is intra-trial (implement -> review -> repair -> converge).
- SWE-bench tasks are **patch-oriented**: independent candidate diffs can be reviewed
  and one selected, which is exactly Claudex's best-of-N + arbitration.

## Conventions

- Secrets are read from exported env vars, or from an explicit `CLAUDEX_KEYS_FILE`
  path when you opt in. Values are never printed.
- Model slugs rotate over time and are therefore **not hardcoded** — set the current
  ones via env (see each suite's `config.example.env` / README).
- Run artifacts default to `~/.claudex/cache/bench-experiments/` (gitignored).
- Anti-cheating: Claudex never reads a benchmark's hidden grading tests; convergence is
  driven by cross-family review and the agent's own checks.

Start with each suite's `README.md`.
