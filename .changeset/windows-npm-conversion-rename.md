---
"@claudexor/cli": patch
"@claudexor/core": patch
---

When Windows refuses to rename an old managed npm package during conversion, the updater can retry that rename for up to two seconds without running the installer again. A brief file hold can clear within the same Update. If the refusal persists, the Update ends before anything is retired and the old copy stays in place. On every platform, conversion retires a hidden package only if its own rename moved it and the package still matches what it proved before the hide. It then checks the final selection; if that differs from the verified replacement, the Update reports the difference, and that refusal does not undo retirement. The receipt records the first error, how many renames were attempted and the elapsed time. The natural cause of the Windows refusal is still unknown.
