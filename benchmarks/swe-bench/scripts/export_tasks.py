#!/usr/bin/env python3
"""Export a SWE-bench HuggingFace dataset split to a Claudexor tasks.jsonl.

Each line matches @claudexor/benchmark's BenchTask shape:
    {"instance_id", "problem_statement", "repo", "base_commit"}

Run via uv so `datasets` need not be installed globally:
    uv run --with datasets python export_tasks.py <dataset> <split> <out.jsonl> [limit]
"""

from __future__ import annotations

import json
import sys


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print("usage: export_tasks.py <dataset> <split> <out.jsonl> [limit]", file=sys.stderr)
        return 2
    dataset, split, out = argv[0], argv[1], argv[2]
    limit = int(argv[3]) if len(argv) > 3 and argv[3] else None

    from datasets import load_dataset

    ds = load_dataset(dataset, split=split)
    n = 0
    with open(out, "w", encoding="utf-8") as f:
        for row in ds:
            if limit is not None and n >= limit:
                break
            rec = {
                "instance_id": row["instance_id"],
                "problem_statement": row.get("problem_statement", ""),
                "repo": row.get("repo"),
                "base_commit": row.get("base_commit"),
            }
            f.write(json.dumps(rec) + "\n")
            n += 1
    print(f"wrote {n} tasks to {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
