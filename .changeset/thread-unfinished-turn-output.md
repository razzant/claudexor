---
"@claudexor/orchestrator": patch
---

A thread turn that ended without a final answer no longer reaches the next lane as an empty answer (#405). When a later turn runs on another harness or account, the continuation packet (`context/THREAD.md`) and the summary pass now carry what that turn said, read exactly from the run's `final/retained-output.md`, under a heading that the text is not a completion verdict. The heading says the turn ended without a final answer when its run did not succeed; when the run's terminal facts cannot be read it says only that no final answer is recorded and the outcome is unknown. Successful plan and report turns, which write no `answer.md`, keep their earlier rendering. Limits: the recorded output shares the per-turn 4 KiB output budget and keeps its beginning, and a summary cached before this change is reused until the thread's collapse boundary moves.
