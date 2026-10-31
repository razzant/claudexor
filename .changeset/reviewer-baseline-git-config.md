---
"@claudexor/review": patch
---

The baseline commit Claudexor makes in a reviewer's workspace no longer reads your global Git configuration or attributes file: a filter or monitor you configured (git-lfs's among them) no longer runs there, and a required filter that cannot run or a line-ending setting of yours no longer keeps review from starting.
