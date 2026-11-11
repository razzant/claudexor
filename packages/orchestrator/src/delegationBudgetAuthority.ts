import { BudgetLedger, type CashSettledCallback } from "@claudexor/budget";
import { MAX_DELEGATED_CHILDREN } from "@claudexor/schema";

interface ParentAuthority {
  ledger: BudgetLedger;
  accepting: boolean;
  acceptedChildren: number;
  pendingAdmissions: Set<string>;
  children: Map<string, { ledger: BudgetLedger; admissionId: string }>;
  waiters: Set<() => void>;
  cancellationStarted: boolean;
}

export interface DelegationBudgetAuthorityOptions {
  /** Daemon-owned cancellation by admission/job id. Bound once at the
   * composition root so the budget registry never owns process control. */
  cancelAdmission?: (admissionId: string) => void | Promise<void>;
}

/**
 * Daemon-lifetime financial registry for active Delegate families. It is
 * intentionally narrow: no grants or general identity framework, only one
 * live parent ledger, its monotonic child count, and task-scoped child views.
 */
export class DelegationBudgetAuthority {
  private readonly parents = new Map<string, ParentAuthority>();
  private readonly childParents = new Map<string, string>();

  constructor(private readonly options: DelegationBudgetAuthorityOptions = {}) {}

  registerParent(runId: string, ledger: BudgetLedger): void {
    if (this.parents.has(runId)) {
      throw Object.assign(new Error(`Delegate budget authority already exists for ${runId}`), {
        code: "delegation_budget_parent_duplicate",
        status: 409,
      });
    }
    this.parents.set(runId, {
      ledger,
      accepting: true,
      acceptedChildren: 0,
      pendingAdmissions: new Set(),
      children: new Map(),
      waiters: new Set(),
      cancellationStarted: false,
    });
  }

  hasParent(runId: string): boolean {
    return this.parents.has(runId);
  }

  assertCanAdmitChild(parentRunId: string): void {
    const parent = this.parents.get(parentRunId);
    if (!parent || !parent.accepting) {
      throw Object.assign(
        new Error(`no live effective Delegate budget authority for parent ${parentRunId}`),
        { code: "delegation_budget_parent_unavailable", status: 409 },
      );
    }
    if (parent.acceptedChildren >= MAX_DELEGATED_CHILDREN) {
      throw Object.assign(
        new Error(
          `delegation sub-run cap reached (${parent.acceptedChildren}/${MAX_DELEGATED_CHILDREN}) for parent ${parentRunId}`,
        ),
        { code: "delegation_subrun_cap", status: 409 },
      );
    }
  }

  noteChildAccepted(parentRunId: string, admissionId: string): void {
    this.assertCanAdmitChild(parentRunId);
    const parent = this.parents.get(parentRunId)!;
    parent.acceptedChildren += 1;
    parent.pendingAdmissions.add(admissionId);
  }

  cancelAcceptedChild(parentRunId: string, admissionId: string): void {
    const parent = this.parents.get(parentRunId);
    if (!parent?.pendingAdmissions.delete(admissionId)) return;
    this.notifyIfDrained(parent);
  }

  attachChild(
    parentRunId: string,
    admissionId: string,
    childRunId: string,
    taskId: string,
    onCashSettled?: CashSettledCallback,
  ): BudgetLedger {
    const parent = this.parents.get(parentRunId);
    if (!parent || !parent.pendingAdmissions.has(admissionId)) {
      throw Object.assign(
        new Error(`delegated child ${childRunId} has no admitted parent budget authority`),
        { code: "delegation_budget_parent_unavailable", status: 409 },
      );
    }
    if (this.childParents.has(childRunId)) {
      throw Object.assign(new Error(`delegated child ${childRunId} is already attached`), {
        code: "delegation_budget_child_duplicate",
        status: 409,
      });
    }
    parent.pendingAdmissions.delete(admissionId);
    const ledger = parent.ledger.scopedToTask(taskId, onCashSettled);
    parent.children.set(childRunId, { ledger, admissionId });
    this.childParents.set(childRunId, parentRunId);
    return ledger;
  }

  beginParentClose(parentRunId: string): void {
    const parent = this.parents.get(parentRunId);
    if (parent) parent.accepting = false;
  }

  async waitForChildren(parentRunId: string, timeoutMs = 30_000): Promise<void> {
    const parent = this.parents.get(parentRunId);
    if (!parent || this.isDrained(parent)) return;
    if (!parent.cancellationStarted && this.options.cancelAdmission) {
      parent.cancellationStarted = true;
      const admissionIds = new Set([
        ...parent.pendingAdmissions,
        ...[...parent.children.values()].map((child) => child.admissionId),
      ]);
      await Promise.allSettled(
        [...admissionIds].map((admissionId) =>
          Promise.resolve().then(() => this.options.cancelAdmission!(admissionId)),
        ),
      );
      if (this.isDrained(parent)) return;
    }
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        parent.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        parent.waiters.delete(done);
        // The daemon already signalled every admission above. If a broken
        // injected runner ignores abort, fence its scoped financial mutations
        // BEFORE the parent failure terminal is allowed to flush: it can no
        // longer emit parent-family cash or retain a hold. Production Delegate
        // lanes are narrower: Claude/Codex run through core spawnProcess, whose
        // abort path sends the cooperative signal, escalates to SIGKILL after
        // 1s, bounds tree reaping, and then completes the generator with typed
        // termination_unconfirmed at worst. Their daemon jobs therefore settle
        // well inside this 30s bound. This timeout is a typed broken-runner
        // fail-safe, not a claim that an arbitrary injected runner is dead.
        for (const child of parent.children.values()) child.ledger.releaseTask();
        reject(
          Object.assign(
            new Error(
              `timed out waiting for ${parent.children.size + parent.pendingAdmissions.size} delegated child run(s) of ${parentRunId}`,
            ),
            { code: "delegation_child_drain_timeout", status: 503 },
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      parent.waiters.add(done);
      if (this.isDrained(parent)) done();
    });
  }

  releaseRun(runId: string): void {
    const parentRunId = this.childParents.get(runId);
    if (parentRunId) {
      const parent = this.parents.get(parentRunId);
      const child = parent?.children.get(runId);
      child?.ledger.releaseTask();
      parent?.children.delete(runId);
      this.childParents.delete(runId);
      if (parent) this.notifyIfDrained(parent);
      return;
    }
    const parent = this.parents.get(runId);
    if (!parent) return;
    parent.accepting = false;
    parent.pendingAdmissions.clear();
    for (const child of parent.children.values()) child.ledger.releaseTask();
    for (const childRunId of parent.children.keys()) this.childParents.delete(childRunId);
    for (const waiter of [...parent.waiters]) waiter();
    this.parents.delete(runId);
  }

  acceptedChildCount(parentRunId: string): number {
    return this.parents.get(parentRunId)?.acceptedChildren ?? 0;
  }

  private isDrained(parent: ParentAuthority): boolean {
    return parent.children.size === 0 && parent.pendingAdmissions.size === 0;
  }

  private notifyIfDrained(parent: ParentAuthority): void {
    if (!this.isDrained(parent)) return;
    for (const waiter of [...parent.waiters]) waiter();
  }
}
