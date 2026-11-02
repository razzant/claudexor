---
"@claudexor/cli": patch
---

Stopping the daemon (SIGTERM or `claudexor daemon stop`) while it is still starting its socket and Control API listeners, or still checking that those transports answer as this exact runtime, now ends it as a clean stop with exit code 0 (#278). Before, such a Stop was logged as `daemon lifecycle FAILED` and the process exited with code 1, although its shutdown had completed and released the writer lease. Only that Stop's own cancellation is treated this way: a check that already found another runtime's identity or serving mode, a Control API port that is already taken, and any other startup failure are still reported and still exit with code 1, even when a Stop is under way at the same moment.
