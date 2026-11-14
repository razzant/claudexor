import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HarnessEvent } from "@claudexor/schema";
import { parseCodexEvent } from "./parse.js";

/**
 * #118: Codex keeps the Browser MCP's tool name and server. Real replies of the
 * pinned Browser MCP drive the real parser: the typed retrieval stamp reads the
 * whole reply, while the displayed summary stays bounded.
 */
interface Reply {
  label: string;
  tool: string;
  isError: boolean;
  content: { type: string; text?: string }[];
}
const recording = JSON.parse(
  readFileSync(
    new URL("../../core/fixtures/browser-mcp-0.0.85-replies.json", import.meta.url),
    "utf8",
  ),
) as { replies: Reply[] };
const recorded = (label: string): Reply => {
  const found = recording.replies.find((reply) => reply.label === label);
  if (!found) throw new Error(`no recorded reply ${label}`);
  return found;
};

function result(reply: Reply, server = "browser"): HarnessEvent {
  const out = parseCodexEvent(
    {
      type: "item.completed",
      item: {
        id: "mcp-1",
        type: "mcp_tool_call",
        server,
        tool: reply.tool,
        // Codex reports `failed` for an isError result and keeps its content.
        status: reply.isError ? "failed" : "completed",
        result: { content: reply.content },
      },
    },
    "s1",
  );
  expect(out).toHaveLength(1);
  expect(() => HarnessEvent.parse(out![0])).not.toThrow();
  return out![0]!;
}

describe("Codex Browser MCP retrieval stamp (#118)", () => {
  it("stamps a navigation or snapshot that shows a loaded page as a verified retrieval", () => {
    for (const label of ["navigate-200", "snapshot-200", "navigate-redirect"]) {
      const event = result(recorded(label));
      expect(event.tool?.status, label).toBe("ok");
      expect(event.tool?.web_retrieval, label).toBe("verified");
      expect(event.tool?.web_content, label).toBe("page");
    }
  });

  it("keeps the proof of a long real reply while the displayed summary stays bounded", () => {
    for (const label of ["navigate-long-url", "navigate-tab-3", "snapshot-many-tabs"]) {
      const event = result(recorded(label));
      expect(event.tool?.content_summary?.length, label).toBeLessThanOrEqual(1000);
      expect(event.tool?.content_summary, label).not.toContain("### Snapshot");
      expect(event.tool?.web_retrieval, label).toBe("verified");
    }
  });

  it("stamps a page read that reached an error-status page as dispatched, never verified", () => {
    for (const label of ["navigate-404", "snapshot-of-404", "navigate-500"]) {
      const event = result(recorded(label));
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
      const event = result(recorded(label));
      expect(event.tool?.status, label).toBe("ok");
      expect(event.tool?.web_retrieval, label).toBeUndefined();
      expect(event.tool?.web_content, label).toBeUndefined();
    }
  });

  it("leaves a failed Browser reply and other servers unstamped", () => {
    const refused = result(recorded("navigate-refused"));
    expect(refused.tool?.status).toBe("error");
    expect(refused.tool?.web_retrieval).toBeUndefined();
    expect(result(recorded("navigate-200"), "notes").tool?.web_retrieval).toBeUndefined();
  });
});
