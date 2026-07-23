import { describe, expect, it, vi } from "vitest";
import { ControlProject } from "@claudexor/schema";
import { failure, projectListLines } from "./project-command.js";

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

// W1: the project failure envelope routes through the central D-7 projector
// (cli-error.ts) — one category→exit table, `exitCode` + `message` present,
// the legacy `error` alias kept, and a typed ControlProblem's fieldErrors
// preserved.
describe("project failure envelope aligns with the D-7 contract (W1)", () => {
  function captureJson(fn: () => number): { code: number; env: Record<string, unknown> } {
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((
      v: string | Uint8Array,
    ) => {
      out.push(String(v));
      return true;
    }) as typeof process.stdout.write);
    try {
      const code = fn();
      return { code, env: JSON.parse(out.join("")) as Record<string, unknown> };
    } finally {
      write.mockRestore();
    }
  }

  it("a 409 remove conflict on a fenced id is operational → exit 1, typed envelope", () => {
    const { code, env } = captureJson(() =>
      failure(true, 409, {
        code: "project_remove_fenced",
        message: "cannot remove pr-x: an active run is using it",
        retryable: false,
      }),
    );
    // 409 conflict is operational per controlProblemError's central table.
    expect(code).toBe(1);
    expect(env.exitCode).toBe(1);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("project_remove_fenced");
    // message present AND the legacy `error` alias kept.
    expect(env.message).toContain("cannot remove pr-x");
    expect(env.error).toBe(env.message);
  });

  it("a 400 validation body is usage → exit 2 and preserves fieldErrors", () => {
    const { code, env } = captureJson(() =>
      failure(true, 400, {
        code: "invalid_argument",
        message: "root must be absolute",
        retryable: false,
        fieldErrors: { root: ["must be absolute"] },
      }),
    );
    expect(code).toBe(2);
    expect(env.exitCode).toBe(2);
    expect(env.fieldErrors).toEqual({ root: ["must be absolute"] });
  });
});
