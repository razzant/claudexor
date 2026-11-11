import type {
  AccessProfile,
  ActiveTaskContract,
  FinalVerifyRecord,
  GateResult,
  ProjectConfig,
  TestCommandGrant,
  TestCommandInvocation,
} from "@claudexor/schema";
import { finalVerifyFiles, finalVerifyPatch, type VerifyEventLog } from "@claudexor/delivery";
import { canonicalProjectRoot, hashJson, sha256 } from "@claudexor/util";
import type { CandidateRun } from "./candidateEvidence.js";
import { gateProtectedPaths } from "./runSupport.js";
import { runScopeGateEnv } from "./runScope.js";
import type { GateSpec } from "@claudexor/review";

type GateCommands = ActiveTaskContract["tests"]["commands"];

/** Merge the command authorities once and attach external grants only
 * to versioned project commands. Operator commands are explicit input. */
export function resolveContractGates(input: {
  repoRoot: string;
  effectiveAccess: AccessProfile;
  config: ProjectConfig;
  trustGrants: TestCommandGrant[];
  operatorCommands: TestCommandInvocation[];
  projectCommands: TestCommandInvocation[];
}): { commands: GateCommands; autoProtectedPaths: string[] } {
  if (input.effectiveAccess === "readonly") return { commands: [], autoProtectedPaths: [] };
  const projectDigest = sha256(canonicalProjectRoot(input.repoRoot));
  const configDigest = hashJson(input.config);
  const seen = new Set<string>();
  const sourced = [
    ...input.operatorCommands.map((command) => ({ command, source: "operator" as const })),
    ...input.projectCommands.map((command) => ({ command, source: "project" as const })),
  ];
  const commands = sourced
    .filter(({ command }) => {
      const digest = hashJson(command);
      if (seen.has(digest)) return false;
      seen.add(digest);
      return true;
    })
    .map(({ command, source }, index) => {
      const commandDigest = hashJson(command);
      const trustGrant =
        source === "project"
          ? (input.trustGrants.find(
              (candidate) =>
                candidate.projectDigest === projectDigest &&
                candidate.configDigest === configDigest &&
                candidate.commandDigest === commandDigest &&
                candidate.accessProfile === input.effectiveAccess,
            ) ?? null)
          : null;
      return {
        id: `gate-${index + 1}`,
        ...command,
        required: true,
        trust_required: source === "project",
        trust_grant: trustGrant,
      };
    });
  return {
    commands,
    autoProtectedPaths: [
      ...new Set(gateProtectedPaths(commands.flatMap(({ program, args }) => [program, ...args]))),
    ],
  };
}

/** The run's gates. Given the run's scope marker, every gate process (candidate gates, final
 * verification, adoption) is launched in the run's custody and ended at its barrier (INV-144). */
export function gateSpecsFromContract(
  contract: ActiveTaskContract,
  runScopeMarker?: string,
): GateSpec[] {
  const env = runScopeGateEnv(runScopeMarker);
  return contract.tests.commands.map((command) => ({
    id: command.id,
    program: command.program,
    args: command.args,
    cwd: command.cwd,
    envAllowlist: command.envAllowlist,
    ...(env ? { env } : {}),
    trustRequired: command.trust_required,
    trustGrant: command.trust_grant,
    projectRoot: contract.repo.root,
    accessProfile: contract.access.effective_profile,
    required: command.required,
  }));
}

/** Fresh verification (INV-115) of the run's own result, its gates in the run's custody. */
export function finalVerifyRun(
  execRoot: string,
  result: CandidateRun,
  contract: ActiveTaskContract,
  log: VerifyEventLog,
  owner: { runScopeMarker?: string },
): Promise<FinalVerifyRecord> {
  const specs = gateSpecsFromContract(contract, owner.runScopeMarker);
  if (result.files) return finalVerifyFiles(result.files, undefined, specs, log);
  // An object result verifies its own trees at its base (#535); a legacy patch applies.
  return result.result && result.baseSha
    ? finalVerifyPatch(
        execRoot,
        {
          baseSha: result.baseSha,
          baseTree: result.result.base_tree,
          tree: result.result.candidate_tree,
          projectRoot: contract.repo.root,
        },
        specs,
        log,
      )
    : finalVerifyPatch(execRoot, result, specs, log);
}

export function renderTestsEvidence(contract: ActiveTaskContract, gates?: GateResult[]): string {
  const specs = gateSpecsFromContract(contract);
  if (gates === undefined || gates.length === 0) {
    if (specs.length === 0) return "(no test commands configured)";
    const heading = gates
      ? "Configured test commands did not produce gate results before this review:"
      : "Configured test commands (not run yet):";
    return [
      heading,
      ...specs.map(
        (spec) =>
          `- ${spec.id}${spec.required === false ? " (optional)" : ""}: ${JSON.stringify([spec.program, ...spec.args])}`,
      ),
    ].join("\n");
  }
  const required = gates.filter((gate) => gate.required);
  const lines = [
    `Gate results: required ${required.filter((gate) => gate.status === "passed").length}/${required.length} passed; total ${gates.length}.`,
  ];
  const appendTail = (label: string, text: string | null): void => {
    if (!text) return;
    lines.push(`  ${label}: |`, ...text.split(/\r?\n/).map((line) => `    ${line}`));
  };
  for (const gate of gates) {
    lines.push(
      `- ${gate.id}${gate.required === false ? " (optional)" : ""}: ${gate.status}; exit=${gate.exit_code ?? "null"}; duration_ms=${gate.duration_ms}`,
      `  command: ${gate.command}`,
    );
    if (gate.output_truncated) lines.push("  output_truncated: true");
    appendTail("stdout_tail", gate.stdout_tail);
    appendTail("stderr_tail", gate.stderr_tail);
  }
  return lines.join("\n");
}
