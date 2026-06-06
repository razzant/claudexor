#!/usr/bin/env bash
# SWE-bench Verified (500 engineer-verified instances), public via HuggingFace.
#   usage: run-verified.sh [limit]    (limit overrides CLAUDEX_SWE_LIMIT)
source "$(dirname "$0")/scripts/_common.sh"
exec bash "$(dirname "$0")/scripts/run-dataset.sh" "princeton-nlp/SWE-bench_Verified" "test" "${1:-${CLAUDEX_SWE_LIMIT:-}}"
