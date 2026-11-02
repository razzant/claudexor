---
"@claudexor/harness-raw-api": patch
---

Raw API diagnostics are masked whole before they are cut to their bound (#172). The body of a non-OK HTTP answer other than 429 was cut to 500 UTF-16 units first, so a credential-shaped value crossing that cut could leave a fragment too short for the redactor to recognize in the run's events and journals. No raw-API bound splits a surrogate pair any more: the provider's completion error, a non-OK HTTP body, a failed model-catalog read's detail and the model's partial output end before an astral character the cut would split, within their unchanged 500 and 200 UTF-16-unit limits. The partial output stays exact and unmasked, its `partial_output_truncated` flag keeps its meaning, and a 429 still carries only its reset time.
