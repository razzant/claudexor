#!/usr/bin/env python3
"""Summarize Harbor Terminal-Bench results into resolve%, per-task status, cost, and
the Claudex lift (claudex resolve% minus the best baseline).

Harbor writes one ``result.json`` per trial (a serialized TrialResult). A task is
"resolved" when its verifier rewards reach 1.0 (Terminal-Bench scores 0/1).

Usage:
  summarize-results.py <pilot-dir>          # auto-discovers arms as immediate subdirs
  summarize-results.py label=<dir> [...]    # explicit arm dirs
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def _iter_results(root: Path):
    for rj in root.rglob("result.json"):
        try:
            yield json.loads(rj.read_text(encoding="utf-8", errors="replace"))
        except (OSError, json.JSONDecodeError):
            continue


def _resolved(result: dict) -> bool:
    vr = result.get("verifier_result") or {}
    rewards = vr.get("rewards") or {}
    if not rewards:
        return False
    try:
        return max(float(v) for v in rewards.values()) >= 1.0
    except (TypeError, ValueError):
        return False


def _cost(result: dict) -> float:
    ar = result.get("agent_result") or {}
    c = ar.get("cost_usd")
    try:
        return float(c) if c is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def summarize_arm(root: Path) -> dict:
    tasks: dict[str, bool] = {}
    cost = 0.0
    errors = 0
    for r in _iter_results(root):
        # Each arm dir holds BOTH per-trial TrialResult files (have task_name +
        # verifier_result) and Harbor's job-level JobResult (has neither). Skip the
        # latter so it is not counted as a phantom failed task that deflates accuracy.
        name = r.get("task_name") or r.get("trial_name")
        if not name:
            continue
        tasks[name] = tasks.get(name, False) or _resolved(r)
        cost += _cost(r)
        if r.get("exception_info"):
            errors += 1
    total = len(tasks)
    resolved = sum(1 for v in tasks.values() if v)
    return {
        "total": total,
        "resolved": resolved,
        "accuracy": (resolved / total) if total else 0.0,
        "cost_usd": cost,
        "errors": errors,
        "tasks": tasks,
    }


def _discover_arms(argv: list[str]) -> list[tuple[str, Path]]:
    if len(argv) == 1 and "=" not in argv[0]:
        root = Path(argv[0])
        subdirs = sorted(p for p in root.iterdir() if p.is_dir()) if root.is_dir() else []
        # An arm is a subdir that contains at least one result.json; else treat root as one arm.
        arms = [(p.name, p) for p in subdirs if any(p.rglob("result.json"))]
        if arms:
            # Collapse trailing -YYYYMMDD-HHMMSS stamps into a clean arm label.
            return [(_label(name), p) for name, p in arms]
        return [(root.name, root)]
    out: list[tuple[str, Path]] = []
    for a in argv:
        label, _, d = a.partition("=")
        out.append((label or Path(d).name, Path(d)))
    return out


def _label(name: str) -> str:
    import re

    return re.sub(r"-\d{8}-\d{6}$", "", name)


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    arms = _discover_arms(argv)
    summaries = [(label, summarize_arm(d)) for label, d in arms]

    print("\n=== Terminal-Bench results ===\n")
    for label, s in summaries:
        pct = f"{s['accuracy'] * 100:.1f}%"
        print(f"[{label}] resolved {s['resolved']}/{s['total']} ({pct})  cost=${s['cost_usd']:.4f}  errors={s['errors']}")
        for task in sorted(s["tasks"]):
            print(f"    {'PASS' if s['tasks'][task] else 'FAIL'}  {task}")
        print()

    claudex = next((s for label, s in summaries if "claudex" in label.lower()), None)
    baselines = [s for label, s in summaries if "claudex" not in label.lower()]
    if claudex and baselines and claudex["total"]:
        best_base = max(b["accuracy"] for b in baselines)
        lift = claudex["accuracy"] - best_base
        print(f"Claudex lift over best baseline: {lift * 100:+.1f} percentage points "
              f"(claudex {claudex['accuracy'] * 100:.1f}% vs best baseline {best_base * 100:.1f}%)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
