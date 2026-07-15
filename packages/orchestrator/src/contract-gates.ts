import type {
  AccessProfile,
  GateResult,
  ProjectConfig,
  TaskContract,
  TestCommandGrant,
  TestCommandInvocation,
} from "@claudexor/schema";
import { canonicalProjectRoot, containsSecretLikeToken, hashJson, sha256 } from "@claudexor/util";
import { gateProtectedPaths } from "./runSupport.js";
import type { GateSpec } from "@claudexor/review";

type GateCommands = TaskContract["tests"]["commands"];

/** Merge the three command authorities once and attach external grants only
 * to versioned project commands. Spec/operator commands are explicit input. */
export function resolveContractGates(input: {
  repoRoot: string;
  effectiveAccess: AccessProfile;
  config: ProjectConfig;
  trustGrants: TestCommandGrant[];
  specCommands: TestCommandInvocation[];
  operatorCommands: TestCommandInvocation[];
  projectCommands: TestCommandInvocation[];
}): { commands: GateCommands; autoProtectedPaths: string[] } {
  const projectDigest = sha256(canonicalProjectRoot(input.repoRoot));
  const configDigest = hashJson(input.config);
  const seen = new Set<string>();
  const sourced = [
    ...input.specCommands.map((command) => ({ command, source: "spec" as const })),
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
      if (containsSecretLikeToken(JSON.stringify(command))) {
        throw new Error(
          `gate command ${index + 1} contains secret-like token; refusing to persist artifact`,
        );
      }
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

export function gateSpecsFromContract(contract: TaskContract): GateSpec[] {
  return contract.tests.commands.map((command) => ({
    id: command.id,
    program: command.program,
    args: command.args,
    cwd: command.cwd,
    envAllowlist: command.envAllowlist,
    trustRequired: command.trust_required,
    trustGrant: command.trust_grant,
    projectDigest: command.trust_grant?.projectDigest,
    configDigest: command.trust_grant?.configDigest,
    accessProfile: command.trust_grant?.accessProfile,
    required: command.required,
  }));
}

export function renderTestsEvidence(contract: TaskContract, gates?: GateResult[]): string {
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
