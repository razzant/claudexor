export type AcpAuthHarness = "codex";
export const ACP_SERVE_USAGE = "serve [auth login codex]";

export interface AcpTerminalAuthMethod {
  type: "terminal";
  id: string;
  name: string;
  description: string;
  args: string[];
}

interface AcpTerminalAuthDefinition {
  harness: AcpAuthHarness;
  name: string;
  description: string;
  platforms: readonly NodeJS.Platform[];
}

/**
 * Experimental ACP Terminal Auth projection. Keep this registry narrower than
 * the ordinary CLI login surface: an entry is eligible only when the command
 * can run interactively in the terminal supplied by the ACP client and remain
 * attached until the durable login reaches an honest outcome.
 *
 * Claude and Cursor are intentionally absent for now. Their existing macOS
 * setup jobs launch a second Terminal window and return before the vendor login
 * completes, which does not satisfy ACP Terminal Auth's lifecycle contract.
 */
const ACP_TERMINAL_AUTH: readonly AcpTerminalAuthDefinition[] = [
  {
    harness: "codex",
    name: "Sign in to Codex",
    description: "Sign in to an isolated Claudexor Codex subscription profile.",
    platforms: ["darwin", "linux"],
  },
];

function supportedOn(definition: AcpTerminalAuthDefinition, platform: NodeJS.Platform): boolean {
  return definition.platforms.includes(platform);
}

export function acpTerminalAuthMethods(platform: NodeJS.Platform): AcpTerminalAuthMethod[] {
  return ACP_TERMINAL_AUTH.filter((definition) => supportedOn(definition, platform)).map(
    (definition) => ({
      type: "terminal" as const,
      id: definition.harness,
      name: definition.name,
      description: definition.description,
      // ACP clients append these arguments to the configured agent command,
      // e.g. `claudexor acp serve auth login codex`.
      args: ["auth", "login", definition.harness],
    }),
  );
}

/** Strictly decode the complete positional argv after the shared CLI parser. */
export function resolveAcpServeAuthHarness(
  positionals: readonly string[],
  platform: NodeJS.Platform,
): AcpAuthHarness | null {
  if (
    positionals.length !== 5 ||
    positionals[0] !== "acp" ||
    positionals[1] !== "serve" ||
    positionals[2] !== "auth" ||
    positionals[3] !== "login"
  ) {
    return null;
  }
  const harness = positionals[4];
  const definition = ACP_TERMINAL_AUTH.find(
    (candidate) => candidate.harness === harness && supportedOn(candidate, platform),
  );
  return definition?.harness ?? null;
}
