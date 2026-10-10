import { describe, expect, it, vi } from "vitest";
import { ControlProject, ControlProjectRegisterResponse } from "@claudexor/schema";
import { failure, projectListLines, projectRegistrationLines } from "./project-command.js";

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

// `project register` states whether this registration created the project or
// found it already registered; relink answers stay plain project lines.
describe("project register created/existing disclosure", () => {
  const now = new Date().toISOString();
  const project = {
    schemaVersion: 2 as const,
    createdAt: now,
    updatedAt: now,
    id: "pr-a",
    root: "/repo/a",
    nesting: [{ relation: "inside" as const, root: "/repo", projectId: "pr-repo" }],
  };

  it("leads with created or existing from the daemon's answer", () => {
    const created = ControlProjectRegisterResponse.parse({ ...project, created: true });
    const existing = ControlProjectRegisterResponse.parse({ ...project, created: false });
    expect(projectRegistrationLines(created)[0]).toBe("created  pr-a  /repo/a");
    expect(projectRegistrationLines(existing)[0]).toBe("existing  pr-a  /repo/a");
    expect(projectRegistrationLines(existing).slice(1)).toEqual(
      projectListLines(ControlProject.parse(project)).slice(1),
    );
  });

  it("keeps relink answers without the fact and refuses a registration without it", () => {
    expect(projectRegistrationLines(ControlProject.parse(project))).toEqual(
      projectListLines(ControlProject.parse(project)),
    );
    expect(ControlProjectRegisterResponse.safeParse(project).success).toBe(false);
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
