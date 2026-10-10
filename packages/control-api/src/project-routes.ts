import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ControlProject,
  ControlProjectListResponse,
  ControlProjectRegisterRequest,
  ControlProjectRegisterResponse,
  ControlProjectRelinkRequest,
  ControlProjectRemoveReceipt,
  ControlDirectoryListing,
} from "@claudexor/schema";
import { assertNoInlineSecretValues } from "@claudexor/util";
import type { DaemonRunRecord } from "./daemon-server.js";
import { requiredIdempotencyKey } from "./run-start.js";
import { routeValue, serviceResponse } from "./route-stages.js";
import { runWorkspaceBinding, type RunWorkspaceBinding } from "./run-execution-root.js";

export interface ProjectRouteServices {
  listProjects?: () => Promise<{ projects: unknown[] }>;
  registerProject?: (input: {
    root: string;
    idempotencyKey: string;
    clientId: string;
  }) => Promise<unknown>;
  relinkProject?: (id: string, root: string) => Promise<unknown>;
  removeProject?: (id: string) => Promise<unknown>;
  listDirectory?: (path?: string) => Promise<unknown>;
  /** `binding` (from `runId`) verifies the run belongs to the project and reads
   *  its caller-owned workspace when it recorded an override. */
  fetchProjectFile?: (
    projectId: string,
    path: string,
    binding?: RunWorkspaceBinding,
  ) => Promise<{ data: Buffer; contentType: string; fileName: string }>;
}

export interface ProjectRouteContext {
  services?: ProjectRouteServices;
  readBody(req: IncomingMessage): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown, fallbackStatus?: 400 | 500): void;
  binary(
    res: ServerResponse,
    status: number,
    body: Buffer,
    contentType: string,
    fileName: string,
  ): void;
  findRun(id: string): Promise<DaemonRunRecord | null>;
}

export async function handleProjectRoute(
  ctx: ProjectRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (method === "GET" && path === "/filesystem/directories") {
    const service = ctx.services?.listDirectory;
    if (!service) return unsupported(ctx, res);
    const requestedPath = await routeValue(ctx, res, 400, () => {
      const url = new URL(req.url ?? "", "http://localhost");
      for (const key of url.searchParams.keys()) {
        if (key !== "path") throw new Error(`unexpected query parameter: ${key}`);
      }
      if (url.searchParams.getAll("path").length > 1) {
        throw new Error("path may be specified only once");
      }
      return url.searchParams.get("path") ?? undefined;
    });
    if (!requestedPath.ok) return true;
    const listing = await routeValue(ctx, res, 500, () => service(requestedPath.value));
    if (!listing.ok) return true;
    return serviceResponse(ctx, res, "listDirectory", () =>
      ctx.json(res, 200, ControlDirectoryListing.parse(listing.value)),
    );
  }

  if (method === "GET" && path === "/projects") {
    const service = ctx.services?.listProjects;
    if (!service) return unsupported(ctx, res);
    const response = await routeValue(ctx, res, 500, service);
    if (!response.ok) return true;
    return serviceResponse(ctx, res, "listProjects", () =>
      ctx.json(
        res,
        200,
        ControlProjectListResponse.parse({
          projects: response.value.projects.map(projectWire),
        }),
      ),
    );
  }

  if (method === "POST" && path === "/projects") {
    const service = ctx.services?.registerProject;
    if (!service) return unsupported(ctx, res);
    const input = await routeValue(ctx, res, 400, async () => {
      const idempotencyKey = requiredIdempotencyKey(req);
      const raw = await ctx.readBody(req);
      assertNoInlineSecretValues(raw);
      const body = ControlProjectRegisterRequest.parse(raw);
      return { root: body.root, idempotencyKey, clientId: "control-api" };
    });
    if (!input.ok) return true;
    const project = await routeValue(ctx, res, 500, () => service(input.value));
    if (!project.ok) return true;
    return serviceResponse(ctx, res, "registerProject", () =>
      ctx.json(
        res,
        200,
        ControlProjectRegisterResponse.parse({
          ...projectWire(project.value),
          created: (project.value as Record<string, unknown>)["created"],
        }),
      ),
    );
  }

  const projectRelinkMatch = /^\/projects\/([^/]+)\/relink$/.exec(path);
  if (method === "POST" && projectRelinkMatch) {
    const service = ctx.services?.relinkProject;
    if (!service) return unsupported(ctx, res);
    const input = await routeValue(ctx, res, 400, async () => {
      const projectId = decodeURIComponent(projectRelinkMatch[1] as string);
      const raw = await ctx.readBody(req);
      assertNoInlineSecretValues(raw);
      return { projectId, root: ControlProjectRelinkRequest.parse(raw).root };
    });
    if (!input.ok) return true;
    const project = await routeValue(ctx, res, 500, () =>
      service(input.value.projectId, input.value.root),
    );
    if (!project.ok) return true;
    return serviceResponse(ctx, res, "relinkProject", () =>
      ctx.json(res, 200, projectWire(project.value)),
    );
  }

  const projectFileMatch = /^\/projects\/([^/]+)\/file$/.exec(path);
  if (method === "GET" && projectFileMatch) {
    const service = ctx.services?.fetchProjectFile;
    if (!service) return unsupported(ctx, res);
    const input = await routeValue(ctx, res, 400, () => {
      const projectId = decodeURIComponent(projectFileMatch[1] as string);
      const url = new URL(req.url ?? "", "http://localhost");
      for (const key of url.searchParams.keys()) {
        if (key !== "path" && key !== "runId") {
          throw new Error(`unexpected query parameter: ${key}`);
        }
      }
      if (url.searchParams.getAll("path").length !== 1) {
        throw new Error("one path query parameter is required");
      }
      if (url.searchParams.getAll("runId").length > 1) {
        throw new Error("runId may be specified only once");
      }
      const runId = url.searchParams.get("runId");
      return { projectId, requestedPath: url.searchParams.get("path") ?? "", runId };
    });
    if (!input.ok) return true;
    // Every supplied run keeps its project identity, even without a workspace
    // override; only an unbound request reads the project without correlation.
    const { runId } = input.value;
    const run = await routeValue(ctx, res, 500, () => (runId === null ? null : ctx.findRun(runId)));
    if (!run.ok) return true;
    if (runId !== null && !run.value) return (ctx.json(res, 404, { error: "no such run" }), true);
    const binding = run.value ? runWorkspaceBinding(run.value) : undefined;
    const file = await routeValue(ctx, res, 500, () =>
      service(input.value.projectId, input.value.requestedPath, binding),
    );
    if (!file.ok) return true;
    return serviceResponse(ctx, res, "fetchProjectFile", () =>
      ctx.binary(res, 200, file.value.data, file.value.contentType, file.value.fileName),
    );
  }

  // QA-049: DELETE /projects/:id — retire a durable project (registry entry +
  // journal-partition archival), typed-fenced against non-purged threads and
  // live/queued runs. Not a relink match, so it lives after that branch.
  const projectDeleteMatch = /^\/projects\/([^/]+)$/.exec(path);
  if (method === "DELETE" && projectDeleteMatch) {
    const service = ctx.services?.removeProject;
    if (!service) return unsupported(ctx, res);
    const projectId = await routeValue(ctx, res, 400, () =>
      decodeURIComponent(projectDeleteMatch[1] as string),
    );
    if (!projectId.ok) return true;
    const receipt = await routeValue(ctx, res, 500, () => service(projectId.value));
    if (!receipt.ok) return true;
    return serviceResponse(ctx, res, "removeProject", () =>
      ctx.json(res, 200, ControlProjectRemoveReceipt.parse(receipt.value)),
    );
  }
  return false;
}

function unsupported(ctx: ProjectRouteContext, res: ServerResponse): true {
  ctx.json(res, 501, { error: "projects are not supported by this build" });
  return true;
}

function projectWire(input: unknown): ControlProject {
  const project = input as Record<string, unknown>;
  return ControlProject.parse({
    schemaVersion: project["schema_version"],
    id: project["id"],
    root: project["root"],
    createdAt: project["created_at"],
    updatedAt: project["updated_at"],
    // F3: disclosed nesting relations (default [] when the service omits them).
    nesting: project["nesting"] ?? [],
  });
}
