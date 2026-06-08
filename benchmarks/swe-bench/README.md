# Claudex x SWE-bench

Patch-oriented benchmarking: Claudex runs best-of-N candidates with cross-family
review/arbitration over prepared per-instance repos, emits SWE-bench predictions, and
the **official** `swebench.harness.run_evaluation` scores them in Docker (resolved =
FAIL_TO_PASS and PASS_TO_PASS, hidden test patch applied by the harness).

This is the paradigm that fits SWE-bench: independent candidate diffs can be reviewed
and one selected — unlike Terminal-Bench's stateful containers.

## Datasets and access

Public (downloadable from HuggingFace, no account; Docker required to evaluate):

- SWE-bench Lite — `princeton-nlp/SWE-bench_Lite` (300) — `./run-lite.sh`
- SWE-bench Verified — `princeton-nlp/SWE-bench_Verified` (500) — `./run-verified.sh`
- SWE-bench Full — `princeton-nlp/SWE-bench` (2294) — `CLAUDEX_SWE_* ./scripts/run-dataset.sh princeton-nlp/SWE-bench test`
- SWE-bench Multilingual — `princeton-nlp/SWE-bench_Multilingual` (300) — same engine, different dataset id
- SWE-bench Pro (public set) — `ScaleAI/SWE-bench_Pro` (731) — dataset is public, but evaluation uses Scale's own harness
  (`github.com/scaleapi/SWE-bench_Pro-os`, Modal recommended / local Docker beta), not `swebench.harness`. Export tasks with
  this suite, but evaluate with Scale's harness.
- SWE-bench-Live — `SWE-bench-Live/SWE-bench-Live` (Python) and `SWE-bench-Live/MultiLang` / `…/Windows` — continuously
  updated; evaluate with Microsoft's `evaluation.evaluation` harness (`github.com/microsoft/SWE-bench-Live`), not `swebench.harness`.

Account / partner gated (NOT reproducible here, documented for completeness):

- SWE-bench Multimodal **test** labels — held out; evaluated via the SWE-bench API (`sb-cli`).
- SWE-bench Pro **held-out** and **commercial/private** sets — proprietary; results only on Scale's leaderboard.

## Prerequisites

- Docker running (Colima is fine; the Terminal-Bench `scripts/colima-setup.sh` works here too).
- `uv` (the official `swebench` harness and the `datasets` loader run via `uv run --with ...`; no global installs).
- A built Claudex CLI: `(cd <repo> && pnpm build)`.
- Keys exported in the environment, or loaded from an explicit `CLAUDEX_KEYS_FILE`:
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (cross-family reviewer), `GITHUB_TOKEN`
  (cloning some instance repos).

## Quickstart

```bash
cd benchmarks/swe-bench
./run-gold-validate.sh                      # prove Docker + swebench harness work (gold must resolve)
CLAUDEX_SWE_LIMIT=5 ./run-lite.sh           # 5-instance smoke: export -> repos -> predictions -> eval
CLAUDEX_SWE_LIMIT=10 ./run-verified.sh      # Verified subset
```

Pipeline (engine: `scripts/run-dataset.sh`):

1. `export_tasks.py` dumps the HF split to `tasks.jsonl` (BenchTask shape).
2. `scripts/prepare-repos.sh` clones each repo at its `base_commit` into `<out>/repos/<instance_id>`.
3. `make-predictions.sh` runs `claudex bench run swe-bench` (best-of-N + review) to write `predictions.jsonl`.
4. `swebench.harness.run_evaluation` scores predictions in Docker.

Artifacts default to `~/.claudex/cache/bench-experiments/swe-bench/` (`CLAUDEX_SWE_RUNS_ROOT`).
Knobs: see `configs/lite.env.example` and `configs/verified.env.example`.

## Notes

- Model slugs rotate; set `CLAUDEX_SWE_REVIEWER_MODEL` (and a Claude model if desired) to current slugs.
- Start with a small `CLAUDEX_SWE_LIMIT`; full Lite/Verified are expensive in time and tokens.
- Pin the evaluator if the latest `swebench` changes prediction format: `CLAUDEX_SWEBENCH_SPEC="swebench==4.1.0"`.
