import type { AccessProfile, HarnessRunSpec } from "@claudexor/schema";
import { formatNativeArgs } from "@claudexor/core";

/** Codex's native sandbox mode for an access profile; inherit_native sends none. */
export function codexSandboxMode(access: AccessProfile): string | null {
  if (access === "readonly") return "read-only";
  if (access === "workspace_write") return "workspace-write";
  if (access === "full") return "danger-full-access";
  return null;
}

/** `codex exec` sandbox argv; `exec resume` accepts it only as `-c` config. */
export function codexExecSandboxArgs(spec: {
  access: AccessProfile;
  resume_session_id?: string | null;
}): string[] {
  const mode = codexSandboxMode(spec.access);
  if (!mode) return [];
  return spec.resume_session_id ? ["-c", `sandbox_mode="${mode}"`] : ["--sandbox", mode];
}

export function codexAppServerApprovalParams(spec: Pick<HarnessRunSpec, "access">): {
  approvalPolicy: string;
  approvalsReviewer: string;
} {
  return {
    // Native automatic review needs an interactive policy to receive requests.
    approvalPolicy: spec.access === "workspace_write" ? "on-request" : "never",
    approvalsReviewer: "auto_review",
  };
}

/** The sandbox and approval parameters every app-server thread request carries. */
export function codexAppServerAccessParams(
  spec: Pick<HarnessRunSpec, "access">,
): Record<string, string> {
  const sandbox = codexSandboxMode(spec.access);
  return { ...(sandbox ? { sandbox } : {}), ...codexAppServerApprovalParams(spec) };
}

/** #413: exactly the access settings this adapter passes, from the helpers above. */
export function codexNativeAccess(spec: HarnessRunSpec, appServer: boolean): string | null {
  if (!appServer) return formatNativeArgs(codexExecSandboxArgs(spec));
  return Object.entries(codexAppServerAccessParams(spec))
    .map(([name, value]) => `${name}=${value}`)
    .join(" ");
}

/** `codex exec` has no per-turn policy: a `-c` writable root would persist in the
 * native session and could not be revoked by a later turn, so it is refused. */
export function assertCodexExecSpec(spec: Pick<HarnessRunSpec, "auxiliary_writable_roots">): void {
  // An embedder's unparsed spec may omit the field: omission is no grant.
  if ((spec.auxiliary_writable_roots ?? []).length > 0)
    throw new Error(
      "the codex exec transport cannot apply revocable auxiliary writable roots; use the app-server transport",
    );
}
