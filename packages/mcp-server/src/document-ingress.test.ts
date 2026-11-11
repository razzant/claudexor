import { Ajv } from "ajv";
import { describe, expect, it, vi } from "vitest";
import { defaultClaudexorTools } from "./index.js";
import { beltClaudexorTools } from "./delegation-belt.js";

describe("document ingress tool contracts", () => {
  const refs = [{ resourceId: "immutable-resource" }];
  const runner = vi.fn(async (_input: Record<string, unknown>) => ({}));
  const tools = defaultClaudexorTools(runner);
  const belt = beltClaudexorTools(runner, {
    parentRunId: "p",
    repoRoot: "/project",
    depth: 0,
    maxSubRuns: 20,
    parentBudget: { kind: "unlimited" },
  });
  for (const tool of [...tools, ...belt].filter(
    (t) => Array.isArray(t.inputSchema.required) && t.inputSchema.required.includes("prompt"),
  )) {
    it(`forwards strict refs through ${tool.name} (${belt.includes(tool) ? "belt" : "public"})`, async () => {
      const validate = new Ajv({ strict: false, formats: { uuid: true } }).compile(
        tool.inputSchema,
      );
      const args = {
        prompt: "read document",
        attachments: refs,
        ...(tool.name === "claudexor_thread_turn" ? { threadId: "thread" } : {}),
      };
      expect(validate(args), JSON.stringify(validate.errors)).toBe(true);
      await tool.handler(args, {});
      expect(runner.mock.lastCall?.[0]).toMatchObject({ attachments: refs });
      for (const attachment of [
        { path: "/host/file" },
        { base64: "abc" },
        { resourceId: "r", path: "/host/file" },
        { resource_id: "r", kind: "file" },
      ]) {
        expect(validate({ ...args, attachments: [attachment] })).toBe(false);
      }
      const { attachments: _refs, ...omitted } = args;
      expect(validate(omitted)).toBe(true);
      await tool.handler(omitted, {});
      expect(runner.mock.lastCall?.[0]).not.toHaveProperty("attachments");
    });
  }
  it("exposes finite schema-owned upload controls outside the belt", () => {
    for (const action of ["create", "import_local", "status", "finalize", "cancel"]) {
      const tool = tools.find((t) => t.name === `claudexor_upload_${action}`);
      expect(tool?.inputSchema.additionalProperties).toBe(false);
      expect(tool?.outputSchema).toBeDefined();
      expect(tool?.annotations?.readOnlyHint).toBe(action === "status");
      expect(belt.some((t) => t.name === tool?.name)).toBe(false);
    }
  });
});
