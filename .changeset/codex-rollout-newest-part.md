---
"@claudexor/harness-codex": patch
---

Codex rollout readers now take only the thread's newest rollout part (#573). Its plain `.jsonl` copy is read; when that part exists only as `.jsonl.zst` or only through a link, the observed model, rollout quota and vendor failure are reported unknown instead of being read from an older part. Nothing is decompressed. Each lookup stops after the first day with a matching part, visits no older days and remembers no absence, so a plain copy written later is read by the next lookup. Continuity names the newest part as the session's holder and still moves every part. Whether Codex ever leaves the newest part compressed-only has not been observed.
