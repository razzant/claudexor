#!/usr/bin/env bash
# SWE-bench Lite (300 instances), public via HuggingFace. Start small with a limit.
#   usage: run-lite.sh [limit]        (limit overrides CLAUDEX_SWE_LIMIT)
source "$(dirname "$0")/scripts/_common.sh"
exec bash "$(dirname "$0")/scripts/run-dataset.sh" "princeton-nlp/SWE-bench_Lite" "test" "${1:-${CLAUDEX_SWE_LIMIT:-}}"
