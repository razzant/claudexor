import type { AdapterRegistry, HarnessAdapter } from "@claudexor/core";
import {
  Attachment,
  ControlRunStartRequest,
  HarnessCapabilityProfile,
  HarnessManifest,
  type AttachmentInputClass,
} from "@claudexor/schema";
import { describe, expect, it } from "vitest";
import { createRunRequirementsPreflight } from "./request-preflight.js";

const attachment = Attachment.parse({
  resource_id: "res-1",
  kind: "file",
  mime: "text/plain",
  name: "notes.txt",
  sha256: `sha256:${"a".repeat(64)}`,
  size_bytes: 12,
  path: "/external/resources/notes.txt",
});

const textInput: AttachmentInputClass = {
  kind: "file",
  mime_types: ["text/plain"],
  max_bytes: 1024,
  max_count: 1,
  transport: "text_inline",
};

function adapter(
  id: string,
  options: {
    attachments?: AttachmentInputClass[];
    browser?: boolean;
    auxiliaryWritableRoots?: boolean;
  } = {},
): HarnessAdapter {
  const capabilityProfile = HarnessCapabilityProfile.parse({
    attachment_inputs: options.attachments ?? [],
    access_control: { auxiliary_writable_roots: options.auxiliaryWritableRoots ?? false },
  });
  return {
    id,
    capabilityProfile,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "local",
        capability_profile: capabilityProfile,
        capabilities: { implement: true, browser_tool: options.browser ?? false },
        access_profiles_supported: ["readonly", "workspace_write", "full"],
      });
    },
    async doctor() {
      throw new Error("preflight must use the supplied readiness projection");
    },
    async *run() {
      throw new Error("preflight must not run a harness");
    },
  };
}

function registry(...adapters: HarnessAdapter[]): AdapterRegistry {
  return new Map(adapters.map((candidate) => [candidate.id, candidate]));
}

const resources = {
  resolve: (refs?: { resourceId: string }[]) => ((refs?.length ?? 0) > 0 ? [attachment] : []),
};

describe("run request requirements preflight", () => {
  const gitAvailable = async () => ({
    status: "available" as const,
    version: "git version test",
    detail: null,
    remediation: null,
  });

  it("requires every explicit attachment lane but filters an incompatible auto lane", async () => {
    const compatible = adapter("compatible", { attachments: [textInput] });
    const incompatible = adapter("incompatible");
    const adapters = registry(compatible, incompatible);
    const statusAll = async () => [
      { id: compatible.id, status: "ok" as const, enabledIntents: ["implement" as const] },
      { id: incompatible.id, status: "ok" as const, enabledIntents: ["implement" as const] },
    ];
    const preflight = createRunRequirementsPreflight(resources, "/no-project", {
      registry: adapters,
      statusAll,
      gitCapability: gitAvailable,
    });
    const baseRequest = {
      prompt: "read attachment",
      mode: "agent",
      scope: { kind: "project", root: "/project", context: "auto" },
      attachments: [{ resourceId: attachment.resource_id }],
    } as const;

    await expect(
      preflight(
        ControlRunStartRequest.parse({
          ...baseRequest,
          harnesses: [compatible.id, incompatible.id],
        }),
      ),
    ).rejects.toMatchObject({ code: "attachment_pool_unsupported" });
    await expect(preflight(ControlRunStartRequest.parse(baseRequest))).resolves.toBeUndefined();
  });

  it("projects the canonical aggregate refusal when an auto pool has no attachment survivor", async () => {
    const first = adapter("incompatible-a");
    const second = adapter("incompatible-b");
    const preflight = createRunRequirementsPreflight(resources, "/no-project", {
      registry: registry(first, second),
      statusAll: async () =>
        [first, second].map((candidate) => ({
          id: candidate.id,
          status: "ok" as const,
          enabledIntents: ["implement" as const],
        })),
      gitCapability: gitAvailable,
    });

    await expect(
      preflight(
        ControlRunStartRequest.parse({
          prompt: "read attachment",
          mode: "agent",
          scope: { kind: "project", root: "/project", context: "auto" },
          attachments: [{ resourceId: attachment.resource_id }],
        }),
      ),
    ).rejects.toMatchObject({
      code: "attachment_pool_unsupported",
      message: expect.stringMatching(/incompatible-a.*incompatible-b/),
    });
  });

  it("uses the project trust default when Browser access is omitted", async () => {
    const browser = adapter("browser", { browser: true });
    const resolvedRoots: string[] = [];
    const preflight = createRunRequirementsPreflight(resources, "/no-project", {
      registry: registry(browser),
      accessDefault: (root) => {
        resolvedRoots.push(root);
        return "full";
      },
      gitCapability: gitAvailable,
    });

    await expect(
      preflight(
        ControlRunStartRequest.parse({
          prompt: "browse",
          mode: "agent",
          scope: { kind: "project", root: "/trusted-project" },
          harnesses: [browser.id],
          browser: true,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(resolvedRoots).toEqual(["/trusted-project"]);

    await expect(
      preflight(
        ControlRunStartRequest.parse({
          prompt: "plan with browser",
          mode: "plan",
          scope: { kind: "project", root: "/trusted-project" },
          harnesses: [browser.id],
          browser: true,
        }),
      ),
    ).rejects.toMatchObject({ code: "browser_unavailable" });
    expect(resolvedRoots).toEqual(["/trusted-project", "/trusted-project"]);
  });

  it("refuses readonly write-backed controls and skips Git", async () => {
    let gitProbes = 0;
    const preflight = createRunRequirementsPreflight(resources, "/no-project", {
      accessDefault: () => "readonly",
      gitCapability: async () => {
        gitProbes += 1;
        return {
          status: "missing" as const,
          version: null,
          detail: "Git is unavailable",
          remediation: "Install Git and retry.",
        };
      },
    });

    await expect(
      preflight(
        ControlRunStartRequest.parse({
          prompt: "repair",
          mode: "agent",
          access: "readonly",
          attempts: 2,
        }),
      ),
    ).rejects.toMatchObject({
      code: "strategy_access_incompatible",
      status: 400,
      retryable: false,
      requiredActions: [expect.stringMatching(/workspace_write\/full/)],
    });
    await expect(
      preflight(
        ControlRunStartRequest.parse({
          prompt: "repair",
          mode: "agent",
          untilClean: true,
        }),
      ),
    ).rejects.toMatchObject({
      code: "strategy_access_incompatible",
      status: 400,
      retryable: false,
      requiredActions: [expect.stringMatching(/workspace_write\/full/)],
    });
    for (const access of ["readonly", undefined] as const) {
      await expect(
        preflight(
          ControlRunStartRequest.parse({
            prompt: "run a write-backed gate",
            mode: "agent",
            ...(access === undefined ? {} : { access }),
            tests: [{ program: "sh", args: ["-c", "true"], envAllowlist: [] }],
          }),
        ),
      ).rejects.toMatchObject({
        code: "strategy_access_incompatible",
        status: 400,
        retryable: false,
      });
    }
    await expect(
      preflight(ControlRunStartRequest.parse({ prompt: "inspect", mode: "agent" })),
    ).resolves.toBeUndefined();
    await expect(
      preflight(
        ControlRunStartRequest.parse({
          prompt: "inspect the caller-owned tree",
          mode: "agent",
          scope: { kind: "project", root: "/readonly-project" },
          execution: { isolation: "live", delegated: true },
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      preflight(
        ControlRunStartRequest.parse({
          prompt: "cannot converge without writes",
          mode: "agent",
          scope: { kind: "project", root: "/readonly-project" },
          execution: { isolation: "live", delegated: true },
          attempts: 2,
        }),
      ),
    ).rejects.toMatchObject({ code: "strategy_access_incompatible" });
    expect(gitProbes).toBe(0);
  });

  it("requires a caller-owned tree when the project default is mutating", async () => {
    let gitProbes = 0;
    const preflight = createRunRequirementsPreflight(resources, "/no-project", {
      accessDefault: () => "workspace_write",
      gitCapability: async () => {
        gitProbes += 1;
        return gitAvailable();
      },
    });

    await expect(
      preflight(
        ControlRunStartRequest.parse({
          prompt: "edit the caller-owned tree",
          mode: "agent",
          scope: { kind: "project", root: "/write-project" },
          execution: { isolation: "live", delegated: true },
        }),
      ),
    ).rejects.toMatchObject({
      code: "execution_workspace_required",
      status: 400,
      retryable: false,
    });
    expect(gitProbes).toBe(0);
  });

  it("refuses only Git-dependent run shapes before harness work", async () => {
    let calls = 0;
    const preflight = createRunRequirementsPreflight(resources, "/no-project", {
      gitCapability: async () => {
        calls += 1;
        return {
          status: "developer_tools_stub",
          version: null,
          detail: "xcode-select: no developer tools",
          remediation:
            "Install Apple Command Line Tools with `xcode-select --install`, then retry.",
        };
      },
    });

    await expect(
      preflight(ControlRunStartRequest.parse({ prompt: "read", mode: "ask" })),
    ).resolves.toBeUndefined();
    await expect(
      preflight(
        ControlRunStartRequest.parse({
          prompt: "repair live",
          mode: "agent",
          untilClean: true,
          execution: { isolation: "live" },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(calls).toBe(0);

    await expect(
      preflight(
        ControlRunStartRequest.parse({
          prompt: "best of",
          mode: "agent",
          n: 2,
          execution: { isolation: "envelope" },
        }),
      ),
    ).rejects.toMatchObject({
      code: "git_developer_tools_stub",
      status: 503,
      retryable: true,
      requiredActions: [expect.stringContaining("xcode-select --install")],
      context: { capability: "git", capabilityStatus: "developer_tools_stub" },
    });
    await expect(
      preflight(
        ControlRunStartRequest.parse({
          prompt: "single live",
          mode: "agent",
          execution: { isolation: "live" },
        }),
      ),
    ).rejects.toMatchObject({ code: "git_developer_tools_stub", status: 503 });
    expect(calls).toBe(2);
  });

  it("honors the daemon's effective thread-workspace Git decision", async () => {
    let probes = 0;
    const preflight = createRunRequirementsPreflight(resources, "/no-project", {
      requiresGit: () => true,
      gitCapability: async () => {
        probes += 1;
        return {
          status: "missing" as const,
          version: null,
          detail: "git executable was not found",
          remediation: "Install Git and retry.",
        };
      },
    });

    await expect(
      preflight(
        ControlRunStartRequest.parse({
          prompt: "repair live",
          mode: "agent",
          untilClean: true,
          execution: { isolation: "live" },
        }),
      ),
    ).rejects.toMatchObject({ code: "git_missing", status: 503 });
    expect(probes).toBe(1);
  });

  it("defers only Git for durable thread jobs while keeping browser admission eager", async () => {
    let probes = 0;
    const lane = adapter("plain");
    const preflight = createRunRequirementsPreflight(
      resources,
      "/no-project",
      {
        requiresGit: () => true,
        gitCapability: async () => {
          probes += 1;
          return {
            status: "missing" as const,
            version: null,
            detail: null,
            remediation: "Install Git and retry.",
          };
        },
        registry: registry(lane),
        statusAll: async () => [
          { id: lane.id, status: "ok" as const, enabledIntents: ["implement" as const] },
        ],
      },
      { git: "durable_job" },
    );

    await expect(
      preflight(ControlRunStartRequest.parse({ prompt: "durable thread", mode: "agent" })),
    ).resolves.toBeUndefined();
    expect(probes).toBe(0);

    await expect(
      preflight(
        ControlRunStartRequest.parse({
          prompt: "browser",
          mode: "agent",
          browser: true,
          access: "full",
        }),
      ),
    ).rejects.toMatchObject({ code: "browser_unavailable" });
    expect(probes).toBe(0);
  });

  it("requires every explicit lane to apply auxiliary roots, filters Auto, refuses empty", async () => {
    const capable = adapter("capable", { auxiliaryWritableRoots: true });
    const plain = adapter("plain");
    // A static capability fact: no doctor/readiness probe for a roots-only request.
    const statusAll = async (): Promise<never> => {
      throw new Error("auxiliary roots must not add a readiness probe");
    };
    const preflight = (
      accessDefault: "readonly" | "workspace_write" = "workspace_write",
      adapters = registry(capable, plain),
    ) =>
      createRunRequirementsPreflight(resources, "/no-project", {
        registry: adapters,
        statusAll,
        accessDefault: () => accessDefault,
        gitCapability: gitAvailable,
      });
    const request = (extra: Record<string, unknown>) =>
      ControlRunStartRequest.parse({
        prompt: "bootstrap",
        mode: "agent",
        scope: { kind: "project", root: "/project", context: "auto" },
        execution: { auxiliaryWritableRoots: ["/srv/cache"] },
        ...extra,
      });
    await expect(preflight()(request({}))).resolves.toBeUndefined();
    await expect(preflight()(request({ harnesses: ["capable"] }))).resolves.toBeUndefined();
    await expect(preflight()(request({ harnesses: ["capable", "plain"] }))).rejects.toMatchObject({
      code: "auxiliary_writable_roots_unsupported",
      status: 400,
      retryable: false,
    });
    await expect(preflight()(request({ harnesses: ["plain"] }))).rejects.toMatchObject({
      code: "auxiliary_writable_roots_unsupported",
    });
    await expect(preflight("workspace_write", registry(plain))(request({}))).rejects.toMatchObject({
      code: "auxiliary_writable_roots_unsupported",
    });
    await expect(preflight()(request({ harnesses: ["missing"] }))).rejects.toMatchObject({
      code: "harness_unavailable",
    });
    // The project trust default is the effective access of an omitted Agent request.
    await expect(preflight("readonly")(request({}))).rejects.toMatchObject({
      code: "auxiliary_writable_roots_access_conflict",
    });
    // Omission never consults lane capability.
    await expect(
      preflight()(request({ harnesses: ["plain"], execution: {} })),
    ).resolves.toBeUndefined();
  });
});
