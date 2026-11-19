---
"@claudexor/cli": patch
"@claudexor/core": patch
---

When Windows refuses to rename an old managed npm package during conversion, the updater can retry that rename for up to two seconds without running the installer again. A brief file hold can clear within the same Update. If the refusal persists, the old copy stays in place. The receipt records the first error, how many renames were attempted and the elapsed time.
