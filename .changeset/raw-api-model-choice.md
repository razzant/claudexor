---
"@claudexor/schema": patch
"@claudexor/core": patch
"@claudexor/harness-raw-api": patch
"@claudexor/orchestrator": patch
"@claudexor/cli": patch
---

A Raw API request names only a model somebody chose (#395). The built-in fallbacks are gone and no newer name replaces them: the run's model, the saved `harnesses.<id>.default_model` and then that instance's own `CLAUDEXOR_RAWAPI_MODEL` or `CLAUDEXOR_OPENROUTER_MODEL` decide, before admission and sizing, and the same id reaches the request and its receipt. With no choice the run refuses `model_selection_required` before anything is sent, naming the remedy, and no other model or route stands in. An environment model is now judged by the catalog like any explicit model: a known absence refuses, and an unavailable catalog still forwards it with its note.
