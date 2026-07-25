import type * as acp from "@agentclientprotocol/sdk";

export interface AcpAuthOptions {
  /** Experimental terminal methods are emitted only when the client opts in. */
  terminalAuthMethods?: Array<acp.AuthMethodTerminal & { type: "terminal" }>;
}

/** The ACP Registry still sends the pre-draft _meta signal; accept both explicit opt-ins. */
export function terminalAuth(
  capabilities: acp.ClientCapabilities | undefined,
  methods: AcpAuthOptions["terminalAuthMethods"],
): Array<acp.AuthMethodTerminal & { type: "terminal" }> {
  const supported =
    capabilities?.auth?.terminal === true || capabilities?._meta?.["terminal-auth"] === true;
  return supported ? (methods ?? []) : [];
}
