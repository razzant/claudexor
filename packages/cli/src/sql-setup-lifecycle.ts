import type { createSqlDaemonServices } from "@claudexor/daemon";
import type { SetupProjectionSlot } from "./setup-lifecycle-binding.js";
import { SqlSetupJobStore } from "./sql-setup-store.js";

/** The existing setup supervisor binding observes SQL's global pid as its
 * generation. No second supervisor or durable generation counter is added. */
export class SqlSetupLifecycleSlot implements SetupProjectionSlot<SqlSetupJobStore> {
  private value: SqlSetupJobStore | null = null;
  private boundPid: number | null = null;
  constructor(
    private readonly rootDir: string,
    private readonly graph: ReturnType<typeof createSqlDaemonServices>,
  ) {}
  generation(): number {
    return this.graph.projects.global().pid;
  }
  current(): SqlSetupJobStore {
    const pid = this.generation();
    if (this.boundPid !== pid) {
      this.graph.rebindGlobal();
      const next = new SqlSetupJobStore(this.rootDir, this.graph.store, this.graph.globalEvents);
      next.validateProjection();
      this.value = next;
      this.boundPid = pid;
    }
    return this.value!;
  }
}
