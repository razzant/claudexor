import type { BoundProjectRegistrationPort, ProjectStorePort } from "@claudexor/daemon";
import type { ControlProjectBinding } from "@claudexor/schema";

/** The daemon's project services over the real store: list, register (with its
 * nesting disclosure), relink, and the opt-in paired-custody pair. A store
 * without the bound port serves the probe and release as an explicit 501, so
 * the daemon keeps working on stores that never adopted them. */
export function projectRegistryServices(
  projects: () => ProjectStorePort & Partial<BoundProjectRegistrationPort>,
) {
  const unavailable = () =>
    Object.assign(new Error("conditional project registration is unavailable"), { status: 501 });
  return {
    listProjects: async () => ({ projects: projects().listWithNesting() }),
    registerProject: async (input: Parameters<ProjectStorePort["register"]>[0]) => {
      const registry = projects();
      const { project, ...receipt } = registry.register(input);
      return { ...project, nesting: registry.nestingFor(project.id), ...receipt };
    },
    relinkProject: async (id: string, root: string) => {
      const registry = projects();
      const project = registry.relink(id, root);
      return { ...project, nesting: registry.nestingFor(id) };
    },
    inspectProjectRegistration: async (
      id: string,
      binding: ControlProjectBinding,
      candidate?: string,
    ) => {
      const registry = projects();
      if (!registry.inspectRegistration) throw unavailable();
      return registry.inspectRegistration(id, binding, candidate);
    },
    releaseProject: async (id: string, binding: ControlProjectBinding) => {
      const registry = projects();
      if (!registry.release) throw unavailable();
      return registry.release(id, binding);
    },
  };
}
