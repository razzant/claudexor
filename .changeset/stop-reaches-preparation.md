---
"@claudexor/core": patch
"@claudexor/workspace": patch
"@claudexor/orchestrator": patch
"@claudexor/cli": patch
"@claudexor/control-api": patch
"@claudexor/daemon": patch
---

A Stop accepted while a run is still preparing its workspace, before any model
dispatch, now reaches that preparation and always ends it (#694). The Git and
directory steps that build the envelope or an isolated thread's worktree take
the stop; their child processes belong to the run's process scope, or to a
short scope a thread turn opens before its first Git step when its worktree must
be made, so background hook and filter processes end with it (also after a
successful preparation). Such a Git step never starts the user's fsmonitor
daemon. The attempt's reserved budget lease is released without inventing an
unknown cost and it completes as cancelled. When the end of a stopped Git step
cannot be proven (a process it started may still run), the attempt's completion
and the run's cancelled terminal disclose `termination_unconfirmed`, in the
shape a harness's completion already uses, and the worktree, base or object
staging it was making is kept rather than removed or reused until a later read
shows that nothing of it runs (on macOS and Linux; Windows below): Retry, the
next turn, purge, Apply, read-only runs and file reads refuse such a thread
worktree with what is held, as a retryable 409 that an idempotent Apply replay
repeats; the next turn that changes files, or a purge, releases it. The store's
ordinary prune reads a held staging's scope with the daemon's recorded members. A
thread's preparation is recorded before its first Git step, so a stop during
the project's initialization or the base snapshot is held the same way, and
what existed before it is never removed. An initialization step that Git's
60-second bound cut with its end unproven is reported as partial
initialization with that termination, as a stopped one is. A completed thread worktree whose
preparation left a process alive is held the same way and then handed over as
made; a ready worktree the thread does not name yet (its hand-over was cut by a
stop or a crash) is recorded by the next turn that gets it. An isolated thread
worktree is made only once its preparation scope is durably recorded: when
`run-scopes.json` cannot be written, that turn is refused before any process
starts (ordinary runs still degrade to in-process custody). On macOS and Linux
an isolated candidate base whose preparation failed or was stopped inside a run
is removed after the run's scope settled, by the same read, so never from under
a filter's process that left its Git's group; one still held when its run ends
is released by the next daemon start; an envelope whose owner record cannot be
read is kept, not collected. When everything a preparation started has provably ended
but its record or files cannot be removed, the turn, and then Apply, read-only
runs and file reads of that worktree, are refused as
`preparation_cleanup_failed` (retryable once the fault is cleared) instead of
`termination_unconfirmed`. `harness.started` is emitted when the
attempt enters its execution path.

Windows keeps its existing tree-only limit. A Git step that takes the user's
own locks finishes before the stop is taken, and none starts after it; no
`taskkill` names the direct child's pid once its exit was seen. There is no process-group probe
and no process census. A direct exit with naturally closed pipes remains a
confirmed stop with `not_provable` tree-only proof and releases under that limit. A genuinely unconfirmed
stop (`output_held` or `direct_child_alive`), or a crash, leaves its resources held (`release_requires: operator_confirmation`), never released by
age, Retry, purge or a restart; healthy preparations and ordinary failures are
unaffected. `claudexor gc preparations` lists what is held under the daemon's
known roots (a purged thread's leftover record included) with a fresh read, and
`claudexor gc release-preparation <selector> --digest <sha256> --confirm-ended`
releases one of them once you have checked that its processes ended: your
confirmation is recorded at that resource and the same release runs, as one
durable daemon operation whose receipt (the record's generation, its stop, the
outcome) stays; repeating its `--idempotency-key` reads that receipt back. A
process a read measures alive, a queued or running turn of the thread, a live
creator, a current child awaiting its actual exit, an unreadable recorded writer
identity, a writer pid born during preparation and a link below the runtime root
still refuse. Old PID-only records remain eligible for operator recovery after
Restart. Root-discovery failures are disclosed as missing inspection coverage.
A thread record is read as its release reads it: one that names another tree,
such as one written while the config root was spelled differently (through a
link or in another letter case), is listed as unreadable and refused; start the
daemon with the original spelling to release it. The run's stop stays `termination_unconfirmed`;
its costs and dispatch facts are unchanged.
