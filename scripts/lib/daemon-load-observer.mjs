/** Benchmark-only, constant-space synchronous maxima for each loop window. */
export class SyncWindowObserver {
  sections = new Map();

  record(operation, durationMs, endedAt = Date.now()) {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    if ((this.sections.get(operation)?.durationMs ?? -1) > durationMs) return;
    this.sections.set(operation, {
      operation,
      durationMs: Math.round(durationMs * 1_000) / 1_000,
      startedAt: new Date(endedAt - durationMs).toISOString(),
      at: new Date(endedAt).toISOString(),
    });
  }

  reset() {
    this.sections.clear();
  }

  roll(loopWindow) {
    const syncSections = [...this.sections.values()].sort((a, b) => b.durationMs - a.durationMs);
    this.reset();
    return { ...loopWindow, worstSync: syncSections[0] ?? null, syncSections };
  }
}

export const syncWindows = new SyncWindowObserver();

export function measureSyncSection(operation, body) {
  const began = performance.now();
  try {
    return body();
  } finally {
    syncWindows.record(operation, performance.now() - began);
  }
}
