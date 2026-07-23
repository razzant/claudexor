import { describe, expect, it } from "vitest";
import { ControlProject } from "@claudexor/schema";
import { projectListLines } from "./project-command.js";

// QA-072: the daemon returns disclosed nesting relations, and the CLI parses
// them, but human `project list` printed only id/root — the overlap was
// invisible unless you asked for --json. Human output must show it too.
describe("project list nesting disclosure (QA-072)", () => {
  const now = new Date().toISOString();
  const base = { schemaVersion: 2 as const, createdAt: now, updatedAt: now };

  it("prints a 'nested inside' / 'contains' line per relation, never a refusal", () => {
    const project = ControlProject.parse({
      ...base,
      id: "pr-child",
      root: "/repo/child",
      nesting: [{ relation: "inside", root: "/repo", projectId: "pr-parent" }],
    });
    const lines = projectListLines(project);
    expect(lines[0]).toBe("pr-child  /repo/child");
    expect(lines[1]).toContain("nested inside /repo");
    expect(lines[1]).toContain("pr-parent");
  });

  it("stays quiet for a disjoint project (no nesting lines)", () => {
    const project = ControlProject.parse({
      ...base,
      id: "pr-solo",
      root: "/solo",
      nesting: [],
    });
    expect(projectListLines(project)).toEqual(["pr-solo  /solo"]);
  });
});
