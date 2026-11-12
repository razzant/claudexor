import type { RunEventBus } from "@claudexor/daemon";

/** Derived only from native attempt lifecycle events, never requested routing. */
export function trackHarnessRuns(bus: RunEventBus) {
  const runs = new Map<string, Map<string, string>>();
  const unsubscribe = bus.subscribe((event) => {
    if (["run.completed", "run.failed", "run.blocked"].includes(event.type)) {
      runs.delete(event.run_id);
      return;
    }
    const harness = event.payload.harness_id;
    const attempt = event.payload.attempt_id;
    if (typeof harness !== "string" || typeof attempt !== "string") return;
    if (event.type === "harness.started") {
      const active = runs.get(event.run_id) ?? new Map<string, string>();
      active.set(attempt, harness);
      runs.set(event.run_id, active);
    } else if (event.type === "harness.completed") {
      const active = runs.get(event.run_id);
      active?.delete(attempt);
      if (!active?.size) runs.delete(event.run_id);
    }
  });
  return {
    count: (harness: string) =>
      [...runs.values()].filter((attempts) => [...attempts.values()].includes(harness)).length,
    close: () => {
      unsubscribe();
      runs.clear();
    },
  };
}
