import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HarnessEvent } from "@claudexor/schema";
import { createClaudeParser } from "./parse.js";

/**
 * #118: Claude's Browser MCP results carry the typed retrieval stamp the engine
 * reads. Real replies of the pinned Browser MCP drive the real parser: the stamp
 * reads the whole reply, while the displayed summary stays bounded.
 */
interface Reply {
  label: string;
  tool: string;
  isError: boolean;
  content: { type: string; text?: string }[];
}
const recording = JSON.parse(
  readFileSync(
    new URL("../../core/fixtures/browser-mcp-0.0.84-replies.json", import.meta.url),
    "utf8",
  ),
) as { replies: Reply[] };
const recorded = (label: string): Reply => {
  const found = recording.replies.find((reply) => reply.label === label);
  if (!found) throw new Error(`no recorded reply ${label}`);
  return found;
};

function browserResult(tool: string, reply: Reply, server = "browser"): HarnessEvent {
  const parse = createClaudeParser();
  parse(
    {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "toolu_b", name: `mcp__${server}__${tool}`, input: {} }],
      },
    },
    "s1",
  );
  const out = parse(
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_b",
            is_error: reply.isError,
            content: reply.content.filter((block) => block.type === "text"),
          },
        ],
      },
    },
    "s1",
  ) as HarnessEvent[];
  expect(out).toHaveLength(1);
  expect(() => HarnessEvent.parse(out[0])).not.toThrow();
  return out[0]!;
}

describe("Claude Browser MCP retrieval stamp (#118)", () => {
  it("stamps a navigation or snapshot that shows a loaded page as a verified retrieval", () => {
    for (const label of ["navigate-200", "snapshot-200", "navigate-redirect"]) {
      const reply = recorded(label);
      const event = browserResult(reply.tool, reply);
      expect(event.tool?.status, label).toBe("ok");
      expect(event.tool?.web_retrieval, label).toBe("verified");
      expect(event.tool?.web_content, label).toBe("page");
    }
  });

  it("keeps the proof of a long real reply while the displayed summary stays bounded", () => {
    for (const label of ["navigate-long-url", "navigate-tab-3", "snapshot-many-tabs"]) {
      const reply = recorded(label);
      const event = browserResult(reply.tool, reply);
      expect(event.tool?.content_summary?.length, label).toBeLessThanOrEqual(1000);
      expect(event.tool?.content_summary, label).not.toContain("### Snapshot");
      expect(event.tool?.web_retrieval, label).toBe("verified");
    }
  });

  it("stamps a page read that reached an error-status page as dispatched, never verified", () => {
    for (const label of ["navigate-404", "snapshot-of-404", "navigate-500"]) {
      const reply = recorded(label);
      const event = browserResult(reply.tool, reply);
      expect(event.tool?.status, label).toBe("ok");
      expect(event.tool?.web_retrieval, label).toBe("dispatched");
      expect(event.tool?.web_content, label).toBeUndefined();
    }
  });

  it("gives Browser calls that read no web page no retrieval stamp at all", () => {
    for (const label of [
      "close-before-any-page",
      "close-after-pages",
      "tabs-before-any-page",
      "snapshot-of-blank-start",
      "snapshot-about-blank",
      "navigate-data-url",
      "navigate-back",
      "evaluate",
      "screenshot",
    ]) {
      const reply = recorded(label);
      const event = browserResult(reply.tool, reply);
      expect(event.tool?.status, label).toBe("ok");
      expect(event.tool?.web_retrieval, label).toBeUndefined();
      expect(event.tool?.web_content, label).toBeUndefined();
    }
  });

  it("leaves a failed Browser reply and other MCP servers unstamped", () => {
    const refused = recorded("navigate-refused");
    expect(browserResult(refused.tool, refused).tool?.status).toBe("error");
    expect(browserResult(refused.tool, refused).tool?.web_retrieval).toBeUndefined();
    const page = recorded("navigate-200");
    expect(browserResult(page.tool, page, "notes").tool?.web_retrieval).toBeUndefined();
  });
});
