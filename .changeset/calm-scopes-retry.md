---
"@claudexor/cli": patch
---

Run-scope cleanup retries unresolved scopes owned by the live daemon on the existing process tick, keeps unsettled outcomes, and avoids rewriting unchanged compact index data.
