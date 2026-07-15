import type { McpTool, RunnerFn } from "./index.js";

export function journalRecoveryTools(
  runner: RunnerFn,
  render: (result: unknown) => string,
): McpTool[] {
  const output = (result: unknown) => ({
    text: render(result),
    structured: (result && typeof result === "object" ? result : {}) as Record<string, unknown>,
  });
  return [
    {
      name: "claudexor_journal_recovery",
      description: "Inspect, validate, or export one durable journal partition through v2.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["inspect", "validate", "export"] },
          partition: { type: "string", minLength: 1 },
        },
        required: ["action", "partition"],
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: async (args) =>
        output(
          await runner({
            mode: "__journal_recovery",
            action: args?.action,
            partition: args?.partition,
          }),
        ),
    },
    {
      name: "claudexor_quarantine_journal",
      description:
        "Quarantine a corrupt partition and start a fresh epoch after exact confirmation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          partition: { type: "string", minLength: 1 },
          expectedFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
          confirmation: { type: "string", enum: ["quarantine_and_start_fresh"] },
        },
        required: ["partition", "expectedFingerprint", "confirmation"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      handler: async (args) =>
        output(
          await runner({
            mode: "__journal_recovery",
            action: "quarantine",
            partition: args?.partition,
            expectedFingerprint: args?.expectedFingerprint,
            confirmation: args?.confirmation,
          }),
        ),
    },
  ];
}
