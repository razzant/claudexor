---
"@claudexor/schema": patch
"@claudexor/core": patch
"@claudexor/config": patch
"@claudexor/secrets": patch
"@claudexor/orchestrator": patch
"@claudexor/daemon": patch
"@claudexor/control-api": patch
"@claudexor/gateway": patch
"claudexor": patch
"@claudexor/harness-claude": patch
"@claudexor/harness-codex": patch
"@claudexor/harness-cursor": patch
"@claudexor/harness-opencode": patch
"@claudexor/harness-raw-api": patch
---

Credential profiles (INV-135): durable non-secret `credential_profiles`
registry in the global config; the orchestrator resolves an explicit per-run
profile id ONCE and stamps the typed profile on every HarnessRunSpec; adapters
consume exactly the profile's transport (claude config-dir login / non-bare
token / key; codex scoped CODEX_HOME / scoped auth.json; cursor, opencode,
raw-api secret-ref keys) or refuse typed — never a fallback to default
credentials. Namespaced secret slots (`claude_oauth:<profile>`), per-profile
doctor probes (`GET /credential-profiles`, `claudexor profiles`), interactive
`claudexor profiles login`, profile-stamped route evidence, and
profile-isolated native-session resume.
