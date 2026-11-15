---
"@claudexor/orchestrator": patch
---

The fast-uri floor is raised from 3.1.4 to 3.1.9, the release that carries the
fixes for parser advisories affecting 3.1.4 (host confusion,
SSRF-style normalization, and scheme or path equivalence defects). fast-uri
reaches the engine only through ajv, which resolves an output schema's `$id` with
it. The structured-output validator never fetches a URI, so the advisories' fetch
scenarios do not apply to it. The regression covered here is reference resolution:
when ajv resolves a local reference against a root `$id` with a malformed
authority, such as a backslash before `@`, compilation now fails at run admission
as `invalid_output_schema` (HTTP 400). The same `$id` without such resolution can
still compile; this adds no blanket prohibition on `$id` values. Packages
installed from npm resolve fast-uri through ajv's own range; this floor applies
to the lockfile-built engine and CLI bundles.
