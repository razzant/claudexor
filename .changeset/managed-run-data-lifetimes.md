---
"@claudexor/cli": minor
---

Keep project-owned run data under the logical project when execution uses a temporary copy, and place explicit one-shot runs in a shared run-addressed namespace. Preserve legacy addresses, retention periods, last-run protection and tombstones; leave live workspace envelopes to their existing owner.

Add opt-in managed uploads and explicit release of future reuse. Accepted commands, turns, deferred work and exports retain the bytes they need; legacy and default uploads remain indefinite. A released ID refuses new references rather than silently importing again. Store schema 7 is forward-only; returning to an older binary does not undo that migration.

Make retention observe concurrent partition and reference changes, preserve partial-effect uncertainty, and compact and coalesce the schema-1 run-scope index without dropping unproven entries, repeating a failed write without another reap. Separately bounded later settlement attempts recheck process identity and can release an unchanged deferred message held solely by process custody; cancellation, shutdown, replacement and other holds still win.

Startup cleanup follows no link below the config root. A linked project namespace, `workspaces` or `threads` directory, thread worktree, or task or attempt entry is reported and kept, with the attempt branches it hides, because it may reach another store. To move Claudexor's data, move the whole root with `CLAUDEXOR_CONFIG_DIR`.
