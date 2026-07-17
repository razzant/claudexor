import type { IncomingMessage, ServerResponse } from "node:http";
import { ControlGcRequest, type ControlGcReceipt } from "@claudexor/schema";

export interface MaintenanceRouteServices {
  /** One retention pass over engine-owned runtime artifacts (W3.6). */
  runRetention(request: ControlGcRequest): Promise<ControlGcReceipt>;
}

export interface MaintenanceRouteContext {
  services?: Partial<MaintenanceRouteServices>;
  readBody(req: IncomingMessage): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown): void;
}

export async function handleMaintenanceRoute(
  ctx: MaintenanceRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (method === "POST" && path === "/maintenance/gc") {
    if (!ctx.services?.runRetention) return false;
    try {
      const request = ControlGcRequest.parse((await ctx.readBody(req)) ?? {});
      ctx.json(res, 200, await ctx.services.runRetention(request));
    } catch (error) {
      ctx.requestError(res, error);
    }
    return true;
  }
  return false;
}
