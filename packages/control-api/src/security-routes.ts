import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ControlSecretListResponse,
  ControlSecretMutationResponse,
  ControlSecretSetRequest,
  ControlTrustListResponse,
  ControlTrustState,
  ControlTrustUpdateRequest,
} from "@claudexor/schema";
import { MANAGED_SECRET_NAMES, isManagedSecretName } from "@claudexor/secrets";
import { assertNoInlineSecretValues } from "@claudexor/util";
import { assertOnlyQueryParams, singleQuery } from "./query.js";

export interface SecurityRouteContext {
  services?: {
    listTrust?: (input?: { repoRoot?: string }) => Promise<unknown>;
    updateTrust?: (input: ControlTrustUpdateRequest) => Promise<unknown>;
    listSecrets?: () => Promise<unknown>;
    setSecret?: (input: unknown) => Promise<unknown>;
    deleteSecret?: (name: string) => Promise<unknown>;
  };
  readBody(req: IncomingMessage): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown): void;
}

export async function handleSecurityRoute(
  ctx: SecurityRouteContext,
  method: string,
  path: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  try {
    if (method === "GET" && path === "/trust") {
      assertOnlyQueryParams(url, ["repoRoot"]);
      const repoRoot = singleQuery(url, "repoRoot");
      const result = await required(ctx.services?.listTrust)(
        repoRoot === undefined ? undefined : { repoRoot },
      );
      ctx.json(res, 200, ControlTrustListResponse.parse(result));
      return true;
    }
    if (method === "POST" && path === "/trust") {
      const raw = await ctx.readBody(req);
      assertNoInlineSecretValues(raw);
      const body = ControlTrustUpdateRequest.parse(raw);
      ctx.json(res, 200, ControlTrustState.parse(await required(ctx.services?.updateTrust)(body)));
      return true;
    }
    if (method === "GET" && path === "/secrets") {
      ctx.json(
        res,
        200,
        ControlSecretListResponse.parse(await required(ctx.services?.listSecrets)()),
      );
      return true;
    }
    if (method === "POST" && path === "/secrets") {
      const body = ControlSecretSetRequest.parse(await ctx.readBody(req));
      assertManagedName(body.name);
      ctx.json(
        res,
        200,
        ControlSecretMutationResponse.parse(await required(ctx.services?.setSecret)(body)),
      );
      return true;
    }
    const secretDeleteMatch = /^\/secrets\/([^/]+)$/.exec(path);
    if (method === "DELETE" && secretDeleteMatch) {
      const name = decodeURIComponent(secretDeleteMatch[1] as string);
      assertManagedName(name);
      ctx.json(
        res,
        200,
        ControlSecretMutationResponse.parse(await required(ctx.services?.deleteSecret)(name)),
      );
      return true;
    }
    return false;
  } catch (error) {
    ctx.requestError(res, error);
    return true;
  }
}

function required<T>(service: T | undefined): T {
  if (service) return service;
  throw Object.assign(new Error("security settings are not supported by this build"), {
    status: 501,
  });
}

function assertManagedName(name: string): void {
  if (isManagedSecretName(name)) return;
  throw Object.assign(new Error(`secret name must be one of: ${MANAGED_SECRET_NAMES.join(", ")}`), {
    status: 400,
  });
}
