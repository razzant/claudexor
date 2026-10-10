import { z } from "zod/v3";

export const ControlSetupJobAction = z
  .literal("login")
  .describe("The daemon-managed native-login action.");
export type ControlSetupJobAction = z.infer<typeof ControlSetupJobAction>;

export const ControlSetupJobTransport = z
  .enum(["daemon", "client_pty"])
  .describe(
    "Who owns the interactive terminal: daemon opens a local Terminal, or the client attaches its PTY.",
  );
export type ControlSetupJobTransport = z.infer<typeof ControlSetupJobTransport>;

export const ControlSetupJobTransportField = ControlSetupJobTransport.optional()
  .default("daemon")
  .describe(
    "Additive terminal handoff. client_pty prepares a sealed login job for `claudexor setup attach`.",
  );

export function validateSetupTransport(
  value: {
    harness: string;
    transport: ControlSetupJobTransport;
    loginFlow?: string;
  },
  context: z.RefinementCtx,
): void {
  if (
    value.harness === "codex" &&
    value.transport === "client_pty" &&
    value.loginFlow !== "browser_redirect"
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["transport"],
      message:
        "codex client_pty requires loginFlow browser_redirect; device/app-server flows are daemon-owned",
    });
  }
}
