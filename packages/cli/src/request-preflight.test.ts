import type { AdapterRegistry, HarnessAdapter } from "@claudexor/core";
import {
  Attachment,
  ControlRunStartRequest,
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
  options: { attachments?: AttachmentInputClass[]; browser?: boolean } = {},
): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: "local",
        capability_profile: { attachment_inputs: options.attachments ?? [] },
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

  it("uses the project trust default when Browser access is omitted", async () => {
    const browser = adapter("browser", { browser: true });
    const resolvedRoots: string[] = [];
    const preflight = createRunRequirementsPreflight(resources, "/no-project", {
      registry: registry(browser),
      accessDefault: (root) => {
        resolvedRoots.push(root);
        return "full";
      },
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
    expect(resolvedRoots).toEqual(["/trusted-project"]);
  });
});
