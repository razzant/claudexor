import type { ServerResponse } from "node:http";
import { measureWork } from "@claudexor/util";

export interface RouteStageContext {
  requestError(res: ServerResponse, error: unknown, fallbackStatus?: 400 | 500): void;
}

export type RouteValue<T> = { ok: true; value: T } | { ok: false };

/** Keep request/service failures distinct before a response is written. */
export async function routeValue<T>(
  ctx: RouteStageContext,
  res: ServerResponse,
  fallbackStatus: 400 | 500,
  load: () => T | Promise<T>,
): Promise<RouteValue<T>> {
  try {
    return { ok: true, value: await measureWork("control.handler", load) };
  } catch (error) {
    ctx.requestError(res, error, fallbackStatus);
    return { ok: false };
  }
}

/** Fail closed when a service returns a value outside its public contract. */
export function serviceResponse(
  ctx: RouteStageContext,
  res: ServerResponse,
  service: string,
  send: () => void,
): true {
  try {
    measureWork("control.handler", send);
  } catch {
    ctx.requestError(
      res,
      Object.assign(new Error(`${service} returned a response that violates its schema`), {
        status: 500,
        code: "invalid_service_response",
      }),
      500,
    );
  }
  return true;
}
