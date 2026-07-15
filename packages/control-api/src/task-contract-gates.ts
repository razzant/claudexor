import { FrozenTaskContractArtifact, type TaskContract } from "@claudexor/schema";
import type { verifyAndDeliver } from "@claudexor/delivery";
import { parse as parseYaml } from "yaml";

const unverifiable = (message: string) =>
  Object.assign(new Error(message), { status: 409, code: "task_contract_unverifiable" });

/** Recover the exact frozen gate set; absent/corrupt authority is never an empty set. */
export function requiredGateSpecsFromTaskArtifact(
  raw: string | null,
): NonNullable<Parameters<typeof verifyAndDeliver>[3]> {
  if (raw === null) throw unverifiable("run is missing its required task contract");
  let task: TaskContract;
  try {
    task = FrozenTaskContractArtifact.parse(parseYaml(raw));
  } catch {
    throw unverifiable("run task contract is malformed or unverifiable");
  }
  return task.tests.commands.map((command) => ({
    id: command.id,
    program: command.program,
    args: command.args,
    cwd: command.cwd,
    envAllowlist: command.envAllowlist,
    trustRequired: command.trust_required,
    trustGrant: command.trust_grant,
    projectRoot: task.repo.root,
    accessProfile: task.access.effective_profile,
    required: command.required,
  }));
}
