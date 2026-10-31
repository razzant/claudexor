---
"@claudexor/schema": patch
"@claudexor/workspace": patch
"@claudexor/orchestrator": patch
"@claudexor/cli": patch
---

A run whose changes cannot be captured no longer ends as `failed / workspace_unavailable` with advice to retry the run. When capture fails, for example for lack of disk space, on a Git process that stalls or is killed, on a file that cannot be read, on a missing object, or on an I/O or scratch fault, the run ends `failed` with the new reason `capture_refused` ("Failed (changes not captured)") and its capture failure keeps the typed cause. The refusal names what was not recorded (the exact result, a revert point for live changes, apply eligibility, and the configured checks and requested review, which did not run) and what is kept (the final answer, which stays the diagnostic primary output, run-produced media, and the changed files in place or in the retained isolated source); its next actions no longer suggest retrying the run. Completed work whose only defect is the capture is no longer published as resumable; a harness error, a cancellation or an unfinished work state still is. Screenshots and other produced media are now kept on a refusal: the run copies them and in-place cleanup leaves the run's artifact directory. When the capture had written its candidate tree, a separate bounded pass records a non-exact `inventory` of the largest changed files (path, change kind, size) on the capture failure; `claudexor inspect` and the run summary print it.
