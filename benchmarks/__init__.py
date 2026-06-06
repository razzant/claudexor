"""Claudex benchmark suite (operator-facing harnesses and adapters).

Importable so Harbor can load the Terminal-Bench agent via a dotted path:

    PYTHONPATH=<repo-root> harbor run \\
      --agent-import-path benchmarks.terminal_bench.claudex_agent:ClaudexAgent ...
"""
