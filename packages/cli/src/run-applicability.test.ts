import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlRunApplicabilityResponse, type GitCapability } from "@claudexor/schema";
import { buildRunApplicabilityMatrix, projectRunApplicability } from "./run-applicability.js";

const roots: string[] = [];
const unavailable = {
  status: "developer_tools_stub",
  version: null,
  detail: "xcode-select: no developer tools",
  remediation: "Install Apple Command Line Tools with `xcode-select --install`, then retry.",
} satisfies GitCapability;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

describe("run Git applicability", () => {
  it("projects the exact six cells through the canonical workspace predicate", () => {
    expect(
      buildRunApplicabilityMatrix({ repoRoot: "/repo", protectedPaths: [], git: unavailable }),
    ).toMatchObject({
      in_place: {
        read_only: { applicable: true, requiresGit: false },
        agent_convergence: { applicable: true, requiresGit: false },
        agent_other: { applicable: false, requiresGit: true },
      },
      isolated: {
        read_only: { applicable: true, requiresGit: false },
        agent_convergence: { applicable: false, requiresGit: true },
        agent_other: { applicable: false, requiresGit: true },
      },
    });
  });

  it("folds protected-path promotion into the in-place convergence cell", () => {
    const matrix = buildRunApplicabilityMatrix({
      repoRoot: "/repo",
      protectedPaths: ["migrations/**"],
      git: unavailable,
    });
    expect(matrix.in_place.read_only).toMatchObject({ applicable: true, requiresGit: false });
    expect(matrix.in_place.agent_convergence).toMatchObject({
      applicable: false,
      requiresGit: true,
    });
  });

  it("keeps requirements visible while making every cell applicable when Git works", () => {
    const matrix = buildRunApplicabilityMatrix({
      repoRoot: "/repo",
      protectedPaths: [],
      git: { status: "available", version: "git version 2.50", detail: null, remediation: null },
    });
    expect(matrix.isolated.read_only).toEqual({
      applicable: true,
      requiresGit: false,
      code: null,
      reason: null,
      remediation: null,
    });
    expect(matrix.in_place.agent_other.applicable).toBe(true);
  });

  it("keeps refusal codes closed and reason/remediation axes explicit", () => {
    const matrix = buildRunApplicabilityMatrix({
      repoRoot: "/repo",
      protectedPaths: [],
      git: unavailable,
    });
    expect(() =>
      ControlRunApplicabilityResponse.parse({
        repoRoot: "/repo",
        git: unavailable,
        matrix: {
          ...matrix,
          in_place: {
            ...matrix.in_place,
            agent_other: { ...matrix.in_place.agent_other, code: "git_maybe" },
          },
        },
      }),
    ).toThrow();
  });

  it("validates the root and returns an exact root-scoped service response", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-applicability-"));
    roots.push(root);
    await expect(
      projectRunApplicability(root, {
        gitCapability: async () => unavailable,
        protectedPaths: () => [],
      }),
    ).resolves.toMatchObject({ repoRoot: root, git: unavailable });
    await expect(projectRunApplicability("relative/project")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("loads real project protected paths instead of projecting a rootless default", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-applicability-config-"));
    roots.push(root);
    mkdirSync(join(root, ".claudexor"));
    writeFileSync(
      join(root, ".claudexor", "config.yaml"),
      "version: 1\nconstraints:\n  protected_paths:\n    - migrations/**\n",
      "utf8",
    );
    const response = await projectRunApplicability(root, {
      gitCapability: async () => unavailable,
    });
    expect(response.matrix.in_place.agent_convergence).toEqual({
      applicable: false,
      requiresGit: true,
      code: "git_developer_tools_stub",
      reason: "Git is unavailable because Apple Command Line Tools are not installed.",
      remediation: unavailable.remediation,
    });
    expect(response.matrix.in_place.read_only).toEqual({
      applicable: true,
      requiresGit: false,
      code: null,
      reason: null,
      remediation: null,
    });
  });
});
