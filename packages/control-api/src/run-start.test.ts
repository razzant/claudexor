import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findAcceptedAroundPreflight,
  normalizeExistingProjectRoot,
  normalizeRunStartRequest,
} from "./run-start.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("normalizeExistingProjectRoot", () => {
  it("accepts a symlink to an existing directory and preserves its spelling", () => {
    const parent = mkdtempSync(join(tmpdir(), "claudexor-root-symlink-"));
    const target = mkdtempSync(join(tmpdir(), "claudexor-root-target-"));
    roots.push(parent, target);
    const linked = join(parent, "project-link");
    symlinkSync(target, linked, "dir");

    expect(normalizeExistingProjectRoot(`  ${linked}  `)).toBe(linked);
  });

  it("keeps missing paths and regular files on the same typed refusal", () => {
    const parent = mkdtempSync(join(tmpdir(), "claudexor-root-invalid-"));
    roots.push(parent);
    const file = join(parent, "file.txt");
    writeFileSync(file, "not a directory");

    for (const value of [join(parent, "missing"), file]) {
      try {
        normalizeExistingProjectRoot(value);
        throw new Error("expected project-root refusal");
      } catch (error) {
        expect(error).toMatchObject({ status: 400 });
        expect(String(error)).toContain("does not exist or is not a directory");
      }
    }
  });
});

describe("findAcceptedAroundPreflight", () => {
  it("returns a command accepted while a failing mutable preflight was in flight", async () => {
    const accepted = { id: "job-raced" };
    let durable: typeof accepted | null = null;
    let releasePreflight!: () => void;
    const preflightEntered = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    let probes = 0;

    const result = findAcceptedAroundPreflight(
      async () => {
        probes += 1;
        return durable;
      },
      async () => {
        await preflightEntered;
        throw new Error("mutable capability disappeared");
      },
    );
    durable = accepted;
    releasePreflight();

    await expect(result).resolves.toBe(accepted);
    expect(probes).toBe(2);
  });

  it("preserves the original preflight error when the race-closing probe misses", async () => {
    const preflightError = new Error("mutable capability disappeared");
    await expect(
      findAcceptedAroundPreflight(
        async () => null,
        async () => {
          throw preflightError;
        },
      ),
    ).rejects.toBe(preflightError);
  });

  it("keeps custody unknown when the race-closing durable lookup cannot be read", async () => {
    const preflightError = Object.assign(new Error("retired access"), {
      status: 409,
      code: "retired_access_profile",
    });
    let probes = 0;
    await expect(
      findAcceptedAroundPreflight(
        async () => {
          probes += 1;
          if (probes === 1) return null;
          throw new Error("durable command index unavailable");
        },
        async () => {
          throw preflightError;
        },
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "idempotency_status_unavailable",
      retryable: true,
    });
    expect(probes).toBe(2);
  });

  it("surfaces the daemon's typed project_not_registered as a 404, not an unknown custody 503", async () => {
    // The daemon socket carries code/status/retryable but drops requiredActions.
    const transported = Object.assign(new Error("project is not registered: /tmp/unregistered"), {
      code: "project_not_registered",
      status: 404,
      retryable: false,
    });
    let preflights = 0;
    const refusal = await findAcceptedAroundPreflight(
      async () => {
        throw transported;
      },
      async () => {
        preflights += 1;
      },
    ).catch((error: unknown) => error);
    expect(refusal).toBe(transported);
    expect(refusal).toMatchObject({
      status: 404,
      code: "project_not_registered",
      retryable: false,
      requiredActions: [expect.stringMatching(/POST \/v2\/projects.*scope\.ephemeral=true/)],
    });
    expect(preflights).toBe(0);
  });

  it("keeps an unrelated lookup failure on the retryable 503", async () => {
    await expect(
      findAcceptedAroundPreflight(
        async () => {
          throw Object.assign(new Error("journal partition quarantined"), {
            code: "partition_unavailable",
            status: 503,
          });
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "idempotency_status_unavailable",
      retryable: true,
    });
  });
});

describe("ephemeral project roots", () => {
  it("carries the one-shot declaration through normalization", () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-ephemeral-root-"));
    roots.push(root);

    const declared = normalizeRunStartRequest({
      prompt: "do the thing",
      mode: "agent",
      scope: { kind: "project", root, ephemeral: true },
    });
    // The scope is rebuilt field-by-field during normalization; dropping the
    // flag here would silently register the disposable tree after all.
    expect(declared.scope).toEqual({ kind: "project", root, context: "auto", ephemeral: true });

    const ordinary = normalizeRunStartRequest({
      prompt: "do the thing",
      mode: "agent",
      scope: { kind: "project", root },
    });
    expect(ordinary.scope).toEqual({ kind: "project", root, context: "auto", ephemeral: false });
  });
});

describe("readonly strategy admission", () => {
  it.each([
    { attempts: 2 },
    { untilClean: true },
    { tests: [{ program: "sh", args: ["-c", "true"], envAllowlist: [] }] },
  ])("refuses write-backed controls before enqueue (%o)", (strategy) => {
    try {
      normalizeRunStartRequest({
        prompt: "repair without write access",
        mode: "agent",
        access: "readonly",
        ...strategy,
      });
      throw new Error("expected readonly strategy refusal");
    } catch (error) {
      expect(error).toMatchObject({
        status: 400,
        code: "strategy_access_incompatible",
        retryable: false,
        requiredActions: [expect.stringMatching(/workspace_write\/full/)],
      });
    }
  });
});

describe("delegated execution.workspaceRoot", () => {
  function pair() {
    const parent = mkdtempSync(join(tmpdir(), "claudexor-workspace-root-"));
    roots.push(parent);
    const project = join(parent, "stable-project");
    const execution = join(parent, "execution-tree");
    mkdirSync(project);
    mkdirSync(execution);
    return { project, execution };
  }

  it("preserves stable project identity separately from the execution tree", () => {
    const { project, execution } = pair();
    const request = normalizeRunStartRequest({
      prompt: "edit the private tree",
      mode: "agent",
      scope: { kind: "project", root: project },
      execution: { isolation: "live", delegated: true, workspaceRoot: execution },
      access: "workspace_write",
    });
    expect(request.scope).toMatchObject({ kind: "project", root: project });
    expect(request.execution.workspaceRoot).toBe(execution);
  });

  it("requires the field on fresh mutating delegated live runs", () => {
    const { project } = pair();
    expect(() =>
      normalizeRunStartRequest({
        prompt: "edit",
        mode: "agent",
        scope: { kind: "project", root: project },
        execution: { isolation: "live", delegated: true },
        access: "workspace_write",
      }),
    ).toThrow(/workspaceRoot is required/);
    expect(
      normalizeRunStartRequest({
        prompt: "inspect",
        mode: "agent",
        scope: { kind: "project", root: project },
        execution: { isolation: "live", delegated: true },
        access: "readonly",
      }).access,
    ).toBe("readonly");
    // Omitted Agent access is project-configured and cannot be guessed by this
    // filesystem-only normalizer. The project-aware preflight resolves it.
    expect(
      normalizeRunStartRequest({
        prompt: "use the project default",
        mode: "agent",
        scope: { kind: "project", root: project },
        execution: { isolation: "live", delegated: true },
      }).execution.workspaceRoot,
    ).toBeUndefined();
  });

  it("refuses relative, missing, and non-external workspace declarations", () => {
    const { project } = pair();
    const base = {
      prompt: "edit",
      mode: "agent" as const,
      scope: { kind: "project" as const, root: project },
      access: "workspace_write" as const,
    };
    expect(() =>
      normalizeRunStartRequest({
        ...base,
        execution: { isolation: "live", delegated: true, workspaceRoot: "relative/tree" },
      }),
    ).toThrow(/absolute path/);
    expect(() =>
      normalizeRunStartRequest({
        ...base,
        execution: {
          isolation: "live",
          delegated: true,
          workspaceRoot: join(project, "missing"),
        },
      }),
    ).toThrow(/does not exist/);
    expect(() =>
      normalizeRunStartRequest({
        ...base,
        execution: { isolation: "live", delegated: false, workspaceRoot: project },
      }),
    ).toThrow(/only for project-scoped delegated agent runs/);
  });

  it("allows bounded legacy Exact Retry but revalidates a frozen new-shape workspace", () => {
    const { project, execution } = pair();
    expect(
      normalizeRunStartRequest({
        prompt: "legacy retry",
        mode: "agent",
        scope: { kind: "project", root: project },
        execution: { isolation: "live", delegated: true },
        access: "workspace_write",
        retryOf: "run-old",
      }).execution.workspaceRoot,
    ).toBeUndefined();
    rmSync(execution, { recursive: true, force: true });
    expect(() =>
      normalizeRunStartRequest({
        prompt: "new-shape retry",
        mode: "agent",
        scope: { kind: "project", root: project },
        execution: { isolation: "live", delegated: true, workspaceRoot: execution },
        access: "workspace_write",
        retryOf: "run-new",
      }),
    ).toThrow(/does not exist/);
  });
});
