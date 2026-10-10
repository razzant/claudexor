import { isAbsolute } from "node:path";
import { DaemonLifecycleOwner } from "@claudexor/schema";

export const EXTERNAL_DAEMON_REMEDY =
  "the owning application must restore its managed daemon; this integration only attaches";

/** Artifact ownership (CLAUDEXOR_MANAGED) and daemon lifecycle are independent. */
export function daemonOwner(): "standalone" | "external" {
  const parsed = DaemonLifecycleOwner.safeParse(process.env.CLAUDEXOR_DAEMON_OWNER ?? "standalone");
  if (!parsed.success)
    throw Object.assign(new Error("invalid CLAUDEXOR_DAEMON_OWNER"), {
      code: "host_binding_invalid",
      status: 422,
    });
  if (parsed.data === "external" && !isAbsolute(process.env.CLAUDEXOR_CONFIG_DIR ?? ""))
    throw Object.assign(new Error("external daemon ownership requires an absolute config root"), {
      code: "host_binding_invalid",
      status: 422,
    });
  return parsed.data;
}

export function daemonUnavailableMessage(outcome: string): string {
  return daemonOwner() === "external"
    ? `the managed Claudexor daemon is unavailable; ${EXTERNAL_DAEMON_REMEDY}`
    : `the Claudexor daemon is not running; ${outcome}`;
}

export function managedDaemonUnavailable(): Error {
  return Object.assign(new Error(daemonUnavailableMessage("no action was performed")), {
    code: "daemon_unavailable",
    retryable: true,
    requiredActions: [EXTERNAL_DAEMON_REMEDY],
  });
}

export function assertOperatorDaemonLifecycle(): void {
  if (daemonOwner() === "external")
    throw Object.assign(
      new Error(`daemon lifecycle is externally owned; ${EXTERNAL_DAEMON_REMEDY}`),
      {
        code: "daemon_lifecycle_external",
        retryable: false,
        requiredActions: [EXTERNAL_DAEMON_REMEDY],
      },
    );
}
