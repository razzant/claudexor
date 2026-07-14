import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ControlProject,
  ControlProjectListResponse,
  ControlProjectRegisterRequest,
  ControlProjectRelinkRequest,
} from "@claudexor/schema";
import { assertNoInlineSecretValues } from "@claudexor/util";
import { requiredIdempotencyKey } from "./run-start.js";

export interface ProjectRouteContext {
  services?: {
    listProjects?: () => Promise<{ projects: unknown[] }>;
    registerProject?: (input: {
      root: string;
      idempotencyKey: string;
      clientId: string;
    }) => Promise<unknown>;
    relinkProject?: (id: string, root: string) => Promise<unknown>;
  };
  readBody(req: IncomingMessage): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown): void;
}

export async function handleProjectRoute(
  ctx: ProjectRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (method === "GET" && path === "/projects") {
    const service = ctx.services?.listProjects;
    if (!service) return unsupported(ctx, res);
    try {
      const { projects } = await service();
      ctx.json(res, 200, ControlProjectListResponse.parse({ projects: projects.map(projectWire) }));
    } catch (error) {
      ctx.requestError(res, error);
    }
    return true;
  }

  if (method === "POST" && path === "/projects") {
    const service = ctx.services?.registerProject;
    if (!service) return unsupported(ctx, res);
    try {
      const idempotencyKey = requiredIdempotencyKey(req);
      const raw = await ctx.readBody(req);
      assertNoInlineSecretValues(raw);
      const body = ControlProjectRegisterRequest.parse(raw);
      const project = await service({ root: body.root, idempotencyKey, clientId: "control-api" });
      ctx.json(res, 200, projectWire(project));
    } catch (error) {
      ctx.requestError(res, error);
    }
    return true;
  }

  const projectRelinkMatch = /^\/projects\/([^/]+)\/relink$/.exec(path);
  if (method === "POST" && projectRelinkMatch) {
    const service = ctx.services?.relinkProject;
    if (!service) return unsupported(ctx, res);
    try {
      const raw = await ctx.readBody(req);
      assertNoInlineSecretValues(raw);
      const body = ControlProjectRelinkRequest.parse(raw);
      const project = await service(decodeURIComponent(projectRelinkMatch[1] as string), body.root);
      ctx.json(res, 200, projectWire(project));
    } catch (error) {
      ctx.requestError(res, error);
    }
    return true;
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
  });
}
