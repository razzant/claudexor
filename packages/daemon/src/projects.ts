import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { DurableJournal } from "@claudexor/journal";
import { Project as ProjectSchema, SCHEMA_VERSION, type Project } from "@claudexor/schema";
import { hashJson, newId, nowIso } from "@claudexor/util";

interface RegistrationBinding {
  keyDigest: string;
  requestDigest: string;
  projectId: string;
}

interface ProjectMutation {
  project: Project;
  registration?: RegistrationBinding;
}

const REGISTERED = "project.registered";
const RELINKED = "project.relinked";

/** Global-journal authority for the deliberately empty v2 project registry. */
export class ProjectStore {
  private readonly projects = new Map<string, Project>();
  private readonly projectIdByRoot = new Map<string, string>();
  private readonly registrationByKey = new Map<
    string,
    { requestDigest: string; projectId: string }
  >();

  constructor(private readonly journal: DurableJournal) {
    this.replay();
  }

  list(): Project[] {
    return [...this.projects.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  get(id: string): Project | undefined {
    return this.projects.get(id);
  }

  register(input: { root: string; idempotencyKey: string; clientId: string }): Project {
    validateKey(input.idempotencyKey);
    const root = canonicalRoot(input.root);
    const keyDigest = hashJson({
      client: input.clientId,
      partition: "global",
      operation: "project.register",
      key: input.idempotencyKey,
    });
    const requestDigest = hashJson({ root });
    const prior = this.registrationByKey.get(keyDigest);
    if (prior) {
      if (prior.requestDigest !== requestDigest) throw conflict();
      const project = this.projects.get(prior.projectId);
      if (!project) throw new Error("project registration points to a missing project");
      return project;
    }
    const existingId = this.projectIdByRoot.get(root);
    const existing = existingId ? this.projects.get(existingId) : undefined;
    const now = nowIso();
    const project =
      existing ??
      ProjectSchema.parse({
        schema_version: SCHEMA_VERSION,
        id: newId("prj"),
        root,
        created_at: now,
        updated_at: now,
      });
    this.commit(REGISTERED, {
      project,
      registration: { keyDigest, requestDigest, projectId: project.id },
    });
    return project;
  }

  relink(id: string, rootInput: string): Project {
    const current = this.projects.get(id);
    if (!current) throw Object.assign(new Error(`no such project: ${id}`), { status: 404 });
    const root = canonicalRoot(rootInput);
    const owner = this.projectIdByRoot.get(root);
    if (owner && owner !== id) {
      throw Object.assign(new Error(`project root is already registered to ${owner}`), {
        code: "project_root_conflict",
        status: 409,
      });
    }
    if (root === current.root) return current;
    const project = ProjectSchema.parse({ ...current, root, updated_at: nowIso() });
    this.commit(RELINKED, { project });
    return project;
  }

  validateProjection(): void {
    for (const project of this.projects.values()) ProjectSchema.parse(project);
    if (this.projectIdByRoot.size !== this.projects.size) {
      throw new Error("project registry contains duplicate roots");
    }
    for (const binding of this.registrationByKey.values()) {
      if (!this.projects.has(binding.projectId)) {
        throw new Error("project registration idempotency index is dangling");
      }
    }
  }

  private replay(): void {
    for (const record of this.journal.records()) {
      if (record.type !== REGISTERED && record.type !== RELINKED) continue;
      this.apply(parseMutation(record.payload));
    }
    this.validateProjection();
  }

  private commit(type: typeof REGISTERED | typeof RELINKED, mutation: ProjectMutation): void {
    const parsed = parseMutation(mutation);
    this.journal.append(type, parsed);
    this.apply(parsed);
  }

  private apply(mutation: ProjectMutation): void {
    const previous = this.projects.get(mutation.project.id);
    if (previous && previous.root !== mutation.project.root)
      this.projectIdByRoot.delete(previous.root);
    const rootOwner = this.projectIdByRoot.get(mutation.project.root);
    if (rootOwner && rootOwner !== mutation.project.id) {
      throw new Error("conflicting project root history");
    }
    this.projects.set(mutation.project.id, mutation.project);
    this.projectIdByRoot.set(mutation.project.root, mutation.project.id);
    if (mutation.registration) {
      const { keyDigest, requestDigest, projectId } = mutation.registration;
      const prior = this.registrationByKey.get(keyDigest);
      if (prior && (prior.requestDigest !== requestDigest || prior.projectId !== projectId)) {
        throw new Error("conflicting project registration history");
      }
      this.registrationByKey.set(keyDigest, { requestDigest, projectId });
    }
  }
}

export function projectProjection() {
  return {
    name: "projects",
    create: (journal: DurableJournal) => new ProjectStore(journal),
    validate: (store: ProjectStore) => store.validateProjection(),
  };
}

function canonicalRoot(input: string): string {
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

function parseMutation(value: unknown): ProjectMutation {
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

function validateKey(key: string): void {
  if (!key || key.length > 256) {
    throw Object.assign(new Error("Idempotency-Key must contain 1-256 characters"), {
      code: "invalid_idempotency_key",
      status: 400,
    });
  }
}

function conflict(): Error & { code: string; status: number } {
  return Object.assign(new Error("idempotency key was already used with a different request"), {
    code: "idempotency_conflict",
    status: 409,
  });
}
