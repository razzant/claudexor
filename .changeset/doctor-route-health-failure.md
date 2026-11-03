---
"@claudexor/cli": patch
---

`claudexor doctor` keeps its Git and harness sections when the route-health read fails for any reason other than an older engine's 404 (an HTTP error, a lost connection, or an answer that does not match the schema), and prints route health as unavailable with that cause rather than losing the whole report (#569). `doctor --json` carries the cause as `route_health_problem` beside `route_health: null`; the field is null after a 404 or an answer. A route's failed share keeps its counts and no longer rounds a nonzero failure to 0% or a partial failure to 100%: `1/201 failed (<1%)`, `200/201 failed (>99%)`.
