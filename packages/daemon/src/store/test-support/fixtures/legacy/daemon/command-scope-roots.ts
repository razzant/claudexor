/** Project scope roots named by command params — the one journal fact the
 * startup orphan sweep needs. Fed from the prepared global CommandStore's
 * records plus the roots its prune tombstones retained. */
export function commandScopeRoots(records: Iterable<{ params?: unknown } | undefined>): string[] {
  const roots = new Set<string>();
  for (const record of records) {
    const scope = (record?.params as { scope?: { kind?: unknown; root?: unknown } } | undefined)
      ?.scope;
    if (scope && scope.kind === "project" && typeof scope.root === "string") roots.add(scope.root);
  }
  return [...roots];
}

/** Caller-owned execution roots a delegated command recorded. Crash GC reaches
 * only Claudexor's own runtime scratch under them (envelopes), never the
 * caller's tree or its Git refs. */
export function commandExecutionRoots(
  records: Iterable<{ params?: unknown } | undefined>,
): string[] {
  const roots = new Set<string>();
  for (const record of records) {
    const root = (record?.params as { execution?: { workspaceRoot?: unknown } } | undefined)
      ?.execution?.workspaceRoot;
    if (typeof root === "string" && root) roots.add(root);
  }
  return [...roots];
}
