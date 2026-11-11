import { describe, expect, it } from "vitest";
import { defaultClaudexorTools } from "./index.js";

describe("MCP run-control applicability", () => {
  it("advertises and preserves shared execution geometry with explicit Processing", async () => {
    let received: unknown;
    const tool = defaultClaudexorTools(async (params) => {
      received = params;
      return {};
    }).find((entry) => entry.name === "claudexor_run")!;
    expect((tool.inputSchema as any).properties.execution.properties.workspaceKind.enum).toEqual([
      "git",
      "directory",
    ]);
    const execution = {
      workspaceKind: "directory",
      scopePaths: ["assets", "brief.txt"],
      auxiliaryWritableRoots: ["/srv/cache"],
    };
    await tool.handler({ prompt: "go", processingPreference: "standard", execution }, {});
    expect(received).toMatchObject({ mode: "agent", execution, processingPreference: "standard" });
  });
  it("advertises a per-turn auxiliary root list on thread turns only beside the run execution", () => {
    const all = defaultClaudexorTools(async () => ({}));
    const run = all.find((entry) => entry.name === "claudexor_run")!.inputSchema as any;
    const turn = all.find((entry) => entry.name === "claudexor_thread_turn")!.inputSchema as any;
    expect(run.properties.execution.properties.auxiliaryWritableRoots).toMatchObject({
      type: "array",
      items: { type: "string", minLength: 1 },
    });
    expect(turn.properties.execution).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: { auxiliaryWritableRoots: { type: "array" } },
    });
  });
  const tools = defaultClaudexorTools(async () => ({ summary: "ok" }));

  it.each(["claudexor_ask", "claudexor_plan"])(
    "%s does not advertise Agent-only review controls",
    (name) => {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema as any;
      expect(schema.properties.review).toBeUndefined();
      expect(schema.properties.reviewerPanel).toBeUndefined();
      expect(schema.properties.reviewerModels).toBeUndefined();
      expect(schema.properties.reviewerEfforts).toBeUndefined();
      expect(schema.properties.protectedPathApprovals).toBeUndefined();
    },
  );

  it("keeps Agent review controls on Agent tools", () => {
    const schema = tools.find((tool) => tool.name === "claudexor_run")?.inputSchema as any;
    expect(schema.properties.review.type).toBe("boolean");
    expect(schema.properties.reviewerPanel.type).toBe("array");
    expect(schema.properties.protectedPathApprovals.type).toBe("array");
  });

  it.each([true, false])("preserves explicit review=%s through the handler", async (review) => {
    let received: unknown;
    const tool = defaultClaudexorTools(async (params) => {
      received = params;
      return {};
    }).find((entry) => entry.name === "claudexor_run");
    await tool?.handler({ prompt: "go", review }, {});
    expect(received).toMatchObject({ mode: "agent", review });
  });

  it("exposes canonical resource refs for Plan without alternate attachment authority", () => {
    const schema = tools.find((tool) => tool.name === "claudexor_plan")?.inputSchema as any;
    expect(schema.properties.attachments).toMatchObject({
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["resourceId"],
        properties: { resourceId: { type: "string", minLength: 1 } },
      },
    });
    for (const key of ["attachment", "resources", "resourceIds", "images"]) {
      expect(schema.properties[key]).toBeUndefined();
    }
  });
});
