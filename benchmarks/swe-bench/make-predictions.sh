#!/usr/bin/env bash
# Generate SWE-bench predictions with Claudexor (best-of-N + cross-family review over
# prepared per-instance repos). Writes a predictions file for the official evaluator.
#   usage: make-predictions.sh <tasks.jsonl> <predictions.jsonl> <workdir>
# Env: CLAUDEXOR_SWE_N (candidates, default 2), CLAUDEXOR_SWE_MAX_USD, CLAUDEXOR_SWE_REVIEWER_MODEL
source "$(dirname "$0")/scripts/_common.sh"
load_keys

TASKS="${1:?usage: make-predictions.sh <tasks.jsonl> <predictions.jsonl> <workdir>}"
PREDS="${2:?usage: make-predictions.sh <tasks.jsonl> <predictions.jsonl> <workdir>}"
WORKDIR="${3:?usage: make-predictions.sh <tasks.jsonl> <predictions.jsonl> <workdir>}"
have_key ANTHROPIC_API_KEY
have_key OPENAI_API_KEY

# The shipped SWE-bench runner is the in-repo `claudexor-benchmark-runner`
# (benchmarks/runner). Default to its built entrypoint; honor an explicit override
# via CLAUDEXOR_BENCHMARK_RUNNER (a path to any compatible runner CLI).
DEFAULT_RUNNER="$CLAUDEXOR_REPO_ROOT/benchmarks/runner/dist/cli.js"
RUNNER="${CLAUDEXOR_BENCHMARK_RUNNER:-$DEFAULT_RUNNER}"

# Build guard: if using the default in-repo runner and it isn't built yet, stop with
# a clear instruction instead of failing deep in node. (An explicit override is the
# caller's responsibility, so we only guard the default.)
if [ -z "${CLAUDEXOR_BENCHMARK_RUNNER:-}" ] && [ ! -f "$RUNNER" ]; then
  die "SWE-bench runner not built at $RUNNER. Build it first, e.g.:
    (cd $CLAUDEXOR_REPO_ROOT && pnpm build)
  then re-run. (Or set CLAUDEXOR_BENCHMARK_RUNNER to a prebuilt runner CLI.)"
fi

ARGS=(--tasks "$TASKS" --predictions "$PREDS" --workdir "$WORKDIR" --n "${CLAUDEXOR_SWE_N:-2}")
[ -n "${CLAUDEXOR_SWE_MAX_USD:-}" ] && ARGS+=(--max-usd "$CLAUDEXOR_SWE_MAX_USD")
[ -n "${CLAUDEXOR_SWE_REVIEWER_MODEL:-}" ] && ARGS+=(--reviewer-model "$CLAUDEXOR_SWE_REVIEWER_MODEL")
[ -n "${CLAUDEXOR_SWE_TASK_TIMEOUT_SEC:-}" ] && ARGS+=(--task-timeout-sec "$CLAUDEXOR_SWE_TASK_TIMEOUT_SEC")

log "SWE-bench runner -> $PREDS (n=${CLAUDEXOR_SWE_N:-2}, workdir=$WORKDIR, runner=$RUNNER)"
# A .js entrypoint is run with node; any other path is executed directly.
case "$RUNNER" in
  *.js) node "$RUNNER" "${ARGS[@]}" ;;
  *) "$RUNNER" "${ARGS[@]}" ;;
esac
log "predictions: $PREDS"
