---
"@claudexor/cli": patch
"@claudexor/daemon": patch
"@claudexor/control-api": patch
---

Keep retention progressing when projects and partitions are created during a pass.
Registration changes preserve their affected namespaces, while unrelated old runs,
orphan lanes and Codex rollouts can retire. Unreadable references and pending recovery
continue to hold cleanup.
