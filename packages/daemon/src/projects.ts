import { lstatSync, realpathSync, statSync, type BigIntStats } from "node:fs";
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
  /** The request opted in to `storeId` (`X-Claudexor-Store-Identity: 1`). */
  includeStoreId?: boolean;
}

export interface ProjectRegistration {
  project: Project;
  created: boolean;
  /** Present only on the store-identity opt-in, and only when known. */
  storeId?: string;
}

/** The three-valued verdict of the one folder comparison of the paired-custody
 * contract: `same` (the candidate is the recorded folder), `different` (it
 * resolves elsewhere — an independent folder), `unknown` (it cannot be resolved
 * now; never folded into `different`). */
export type FolderComparison = "same" | "different" | "unknown";

export function canonicalRoot(input: string): string {
  if (!isAbsolute(input))
    throw Object.assign(new Error("project root must be absolute"), { status: 400 });
  let root: string;
  try {
    root = realpathSync(input);
  } catch {
    // Named so a caller replaying an accepted launch learns why nothing was
    // replayed or started: a vanished root is refused, never re-registered.
    throw Object.assign(new Error(`project root does not exist: ${input}`), {
      status: 400,
      code: "project_root_missing",
      retryable: false,
      requiredActions: [
        "Restore or remount the project at the same absolute path, or relink the registered project; a missing root never starts or replays work.",
      ],
    });
  }
  if (!lstatSync(root).isDirectory()) {
    throw Object.assign(new Error(`project root is not a directory: ${input}`), { status: 400 });
  }
  return root;
}

/** The one folder comparison, applied at check time: the candidate equals the
 * recorded root, or resolves to it through the registry's own canonicalization
 * (realpath — the same resolution `canonicalRoot` performs at registration).
 * When two spellings still differ after resolution, only the two named
 * directories' own filesystem identity (device and inode, one stat of each,
 * compared as the exact 64-bit values the filesystem reports — no floating
 * point rounding, no traversal and no durable tokens) may prove them the same
 * folder or distinct objects — a string difference alone is never proof of
 * `different` (case-variant spellings of one folder may resolve differently on
 * some volumes), and a path that no longer names a directory on either side
 * carries none of that evidence. A candidate that cannot be resolved now, or
 * whose directory identity evidence is unavailable (inode 0), answers
 * `unknown`, never `different` — unavailability is not independence. The
 * resolved form itself is never returned or stored, and a non-absolute
 * candidate is honestly `unknown`. The verdict is accounting only: it is never
 * permission. */
export function compareFolder(candidate: string, recordedRoot: string): FolderComparison {
  if (candidate === recordedRoot) return "same";
  if (!isAbsolute(candidate)) return "unknown";
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    return "unknown";
  }
  if (resolved === recordedRoot) return "same";
  let candidateDirectory: BigIntStats, recordedDirectory: BigIntStats;
  try {
    candidateDirectory = statSync(resolved, { bigint: true });
    recordedDirectory = statSync(recordedRoot, { bigint: true });
  } catch {
    return "unknown";
  }
  // A stat that is not a directory is not directory-identity evidence.
  if (!candidateDirectory.isDirectory() || !recordedDirectory.isDirectory()) return "unknown";
  if (candidateDirectory.ino === 0n || recordedDirectory.ino === 0n) return "unknown";
  return candidateDirectory.dev === recordedDirectory.dev &&
    candidateDirectory.ino === recordedDirectory.ino
    ? "same"
    : "different";
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
