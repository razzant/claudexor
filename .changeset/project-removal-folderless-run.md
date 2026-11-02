---
"@claudexor/cli": patch
---

Removing a project no longer fails with `409 active_run_scope_unresolved` while a run with no project, such as an Ask started outside any project, is queued or running (#549). The removal check read every such run as having an unknown scope; it now reads the scope the run's accepted request recorded, so a run with no project, including one whose request omitted the scope, holds no project, and the unrelated project is removed while that run continues. A queued or running run of the project itself, also when it names the project's folder through another path such as a symbolic link, still refuses the removal with `409 project_has_active_run`, and a started, unfinished run whose recorded scope cannot be resolved still refuses every project removal with `409 active_run_scope_unresolved`. Finished runs never refuse it.
