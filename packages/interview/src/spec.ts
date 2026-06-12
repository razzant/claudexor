import type { ModeKind, SpecPack, TaskContract } from "@claudexor/schema";
import { SCHEMA_VERSION, SpecPack as SpecPackSchema, TaskContract as TaskContractSchema } from "@claudexor/schema";
import { newId, nowIso, redactSecrets } from "@claudexor/util";

export interface SpecToContractOptions {
  repoRoot: string;
  mode?: ModeKind;
  baseRef?: string;
  maxUsd?: number | null;
}

/** Thrown when a non-frozen / ambiguous SpecPack is mapped to a runnable contract. */
export class SpecNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecNotReadyError";
  }
}

/**
 * Build the typed task graph from a SpecPack's tasks (A3): topologically ordered,
 * failing loudly on unknown dependencies or cycles — an ambiguous graph must
 * never silently flatten into "run them in file order".
 */
export function buildTaskGraph(tasks: SpecPack["tasks"]): TaskContract["task_graph"] {
  if (tasks.length === 0) return null;
  const nodes = tasks.map((t) => ({ id: t.id, title: t.title, depends_on: t.depends_on }));
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    for (const dep of n.depends_on) {
      if (!ids.has(dep)) throw new SpecNotReadyError(`task '${n.id}' depends on unknown task '${dep}'`);
    }
  }
  // Kahn topological sort; leftovers mean a cycle.
  const inDeg = new Map(nodes.map((n) => [n.id, n.depends_on.length]));
  const queue = nodes.filter((n) => n.depends_on.length === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const n of nodes) {
      if (!n.depends_on.includes(id)) continue;
      const d = (inDeg.get(n.id) ?? 0) - 1;
      inDeg.set(n.id, d);
      if (d === 0) queue.push(n.id);
    }
  }
  if (order.length !== nodes.length) {
    const stuck = nodes.filter((n) => !order.includes(n.id)).map((n) => n.id);
    throw new SpecNotReadyError(`task graph has a dependency cycle involving: ${stuck.join(", ")}`);
  }
  return { nodes, order };
}

/**
 * Deterministically map a frozen SpecPack into an immutable TaskContract. Fails
 * loudly if the spec is not frozen or has open clarifications — a run must never
 * start from an ambiguous spec.
 */
export function specPackToTaskContract(spec: SpecPack, opts: SpecToContractOptions): TaskContract {
  // Re-validate against the schema so even a hand-built/disk-loaded spec must satisfy
  // the frozen/clarification invariants before it can become a runnable contract.
  SpecPackSchema.parse(spec);
  if (!spec.frozen) throw new SpecNotReadyError("SpecPack is not frozen");
  const open = spec.open_questions.filter((q) => q.status === "open");
  if (open.length > 0) {
    throw new SpecNotReadyError(`SpecPack has ${open.length} open clarification(s); resolve before running`);
  }
  return TaskContractSchema.parse({
    schema_version: SCHEMA_VERSION,
    task_id: newId("task"),
    created_at: nowIso(),
    repo: { root: opts.repoRoot, base_ref: opts.baseRef ?? "HEAD", dirty_policy: "snapshot" },
    mode: { kind: opts.mode ?? "agent" },
    user_intent: { raw: redactSecrets(spec.intent.raw), normalized: redactSecrets(spec.summary || spec.intent.normalized || spec.intent.raw) },
    success_criteria: spec.success_criteria.map((c) => ({ id: c.id, text: c.behavior, required: c.required })),
    non_goals: spec.non_goals,
    forbidden_approaches: spec.forbidden_approaches,
    decided_tradeoffs: spec.decided_tradeoffs,
    task_graph: buildTaskGraph(spec.tasks),
    constraints: spec.constraints,
    tests: { commands: spec.tests },
    budget: { max_usd: opts.maxUsd ?? null },
  });
}

export interface SpecFieldChange {
  field: string;
  kind: "added" | "removed" | "changed";
  before?: string;
  after?: string;
}

/** Section-level diff between two SpecPack revisions (spec-anchored history). */
export function diffSpecPacks(a: SpecPack, b: SpecPack): SpecFieldChange[] {
  const changes: SpecFieldChange[] = [];

  if ((a.summary ?? "") !== (b.summary ?? "")) {
    changes.push({ field: "summary", kind: "changed", before: a.summary, after: b.summary });
  }

  const diffList = (field: string, before: string[], after: string[]): void => {
    const setB = new Set(before);
    const setA = new Set(after);
    for (const item of after) if (!setB.has(item)) changes.push({ field, kind: "added", after: item });
    for (const item of before) if (!setA.has(item)) changes.push({ field, kind: "removed", before: item });
  };

  diffList("non_goals", a.non_goals, b.non_goals);
  diffList("forbidden_approaches", a.forbidden_approaches, b.forbidden_approaches);
  diffList("decided_tradeoffs", a.decided_tradeoffs, b.decided_tradeoffs);
  diffList("constraints.allowed_paths", a.constraints.allowed_paths, b.constraints.allowed_paths);
  diffList("constraints.forbidden_paths", a.constraints.forbidden_paths, b.constraints.forbidden_paths);
  diffList("constraints.protected_paths", a.constraints.protected_paths, b.constraints.protected_paths);
  diffList(
    "success_criteria",
    a.success_criteria.map((c) => c.behavior),
    b.success_criteria.map((c) => c.behavior),
  );
  diffList(
    "tests",
    a.tests.map((t) => t.command),
    b.tests.map((t) => t.command),
  );
  diffList(
    "tasks",
    a.tasks.map((t) => t.title),
    b.tasks.map((t) => t.title),
  );

  return changes;
}
