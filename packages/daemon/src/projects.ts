import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Project as ProjectSchema, type Project, type ProjectNesting } from "@claudexor/schema";
import { isClaudexorOwnedRuntimePath } from "@claudexor/util";

interface RegistrationBinding {
  keyDigest: string;
  requestDigest: string;
  projectId: string;
}

export interface ProjectMutation {
  project: Project;
  registration?: RegistrationBinding;
}

/** A registration's answer: the project, and whether THIS registration created
 * it. Derived from journal order on replay, so a key replay after a restart
 * still repeats its original answer. */
export interface RegisterProject {
  root: string;
  idempotencyKey: string;
  clientId: string;
}

export interface ProjectRegistration {
  project: Project;
  created: boolean;
}

export function canonicalRoot(input: string): string {
  if (!isAbsolute(input))
    throw Object.assign(new Error("project root must be absolute"), { status: 400 });
  let root: string;
  try {
    root = realpathSync(input);
  } catch {
    throw Object.assign(new Error(`project root does not exist: ${input}`), { status: 400 });
  }
  if (!lstatSync(root).isDirectory()) {
    throw Object.assign(new Error(`project root is not a directory: ${input}`), { status: 400 });
  }
  return root;
}

/** F2 ghost-project guard: a project root inside the Claudexor
 * runtime tree (`~/.claudexor`, esp. the `projects/<digest>/workspaces/`
 * envelope worktrees) is daemon runtime state, never a user project — refuse it at
 * registration/relink with a typed error so an envelope cwd can never become a
 * durable ghost whose root later vanishes. */
export function assertNotClaudexorOwned(root: string): void {
  if (isClaudexorOwnedRuntimePath(root)) {
    throw Object.assign(
      new Error(
        `project root is inside the Claudexor runtime tree and cannot be registered as a project: ${root}`,
      ),
      { code: "claudexor_owned_root", status: 400 },
    );
  }
}

/** True when `child` is STRICTLY below `parent` (not equal). Both are canonical
 * absolute roots, so a path-segment `relative` is sufficient. */
function pathStrictlyInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Every project's nesting relations in one pass. A root can only lie inside
 * its own ancestors, so each root looks up just its ancestor chain in an index
 * of resolved roots (the same normalization `relative` applies, case-folded
 * where the platform's paths are) instead of testing every other project:
 * O(projects × path depth) predicate tests plus sorting each project's relations
 * (Σ Kᵢ log Kᵢ); only a deep chain of nested roots makes the OUTPUT itself quadratic.
 * Each candidate pair is still decided by `pathStrictlyInside` (`inside`), and
 * ties keep the iteration order, so the answer equals per-project `nestingFor`.
 */
export function projectNesting(
  projects: readonly Project[],
  inside: (child: string, parent: string) => boolean = pathStrictlyInside,
): Map<string, ProjectNesting[]> {
  const key = (root: string) =>
    process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
  const order = new Map(projects.map((project, index) => [project.id, index]));
  const byRoot = new Map<string, Project[]>();
  for (const project of projects) {
    const owners = byRoot.get(key(project.root));
    if (owners) owners.push(project);
    else byRoot.set(key(project.root), [project]);
  }
  const relations = new Map(projects.map((project) => [project.id, [] as ProjectNesting[]]));
  const add = (to: Project, relation: ProjectNesting["relation"], other: Project) =>
    relations.get(to.id)!.push({ relation, root: other.root, projectId: other.id });
  for (const child of projects) {
    let dir = resolve(child.root);
    for (let parent = dirname(dir); parent !== dir; dir = parent, parent = dirname(dir)) {
      for (const owner of byRoot.get(key(parent)) ?? []) {
        if (owner.id === child.id || !inside(child.root, owner.root)) continue;
        add(child, "inside", owner);
        add(owner, "contains", child);
      }
    }
  }
  for (const list of relations.values()) {
    list.sort(
      (a, b) => a.root.localeCompare(b.root) || order.get(a.projectId)! - order.get(b.projectId)!,
    );
  }
  return relations;
}

export function parseMutation(value: unknown): ProjectMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid project mutation");
  }
  const input = value as ProjectMutation;
  const registration = input.registration;
  if (
    registration !== undefined &&
    (!registration ||
      typeof registration.keyDigest !== "string" ||
      typeof registration.requestDigest !== "string" ||
      typeof registration.projectId !== "string")
  ) {
    throw new Error("invalid project registration binding");
  }
  return {
    project: ProjectSchema.parse(input.project),
    ...(registration ? { registration: { ...registration } } : {}),
  };
}

export function validateKey(key: string): void {
  if (!key || key.length > 256) {
    throw Object.assign(new Error("Idempotency-Key must contain 1-256 characters"), {
      code: "invalid_idempotency_key",
      status: 400,
    });
  }
}
