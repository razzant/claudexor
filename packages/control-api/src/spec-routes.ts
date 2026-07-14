import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ControlSpecAnswersRequest,
  ControlSpecSession,
  ControlSpecSessionListResponse,
  ControlSpecQuestionsRequest,
  type ControlSpecAnswersRequest as SpecAnswers,
  type ControlSpecQuestionsRequest as SpecQuestions,
} from "@claudexor/schema";
import { assertNoInlineSecretValues, containsSecretLikeToken } from "@claudexor/util";
import { requiredIdempotencyKey } from "./run-start.js";

export interface SpecRouteServices {
  createSpecSession?: (input: {
    request: SpecQuestions;
    idempotencyKey: string;
    clientId: string;
  }) => Promise<unknown>;
  listSpecSessions?: () => Promise<unknown>;
  getSpecSession?: (id: string) => Promise<unknown>;
  answerSpecSession?: (id: string, input: SpecAnswers) => Promise<unknown>;
  freezeSpecSession?: (id: string) => Promise<unknown>;
  cancelSpecSession?: (id: string) => Promise<unknown>;
  resumeSpecSession?: (id: string) => Promise<unknown>;
}

export interface SpecRouteContext {
  services?: SpecRouteServices;
  readBody(req: IncomingMessage): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown): void;
}

export async function handleSpecRoute(
  ctx: SpecRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  try {
    if (method === "GET" && path === "/spec/sessions") {
      const sessions = await required(ctx.services?.listSpecSessions)();
      ctx.json(res, 200, ControlSpecSessionListResponse.parse(sessions));
      return true;
    }
    if (method === "POST" && path === "/spec/sessions") {
      const raw = await ctx.readBody(req);
      assertSpecSafe(raw);
      const request = ControlSpecQuestionsRequest.parse(raw);
      const session = await required(ctx.services?.createSpecSession)({
        request,
        idempotencyKey: requiredIdempotencyKey(req),
        clientId: "control-api",
      });
      ctx.json(res, 200, ControlSpecSession.parse(session));
      return true;
    }
    const specSessionMatch = /^\/spec\/sessions\/([^/]+)$/.exec(path);
    if (method === "GET" && specSessionMatch) {
      const id = decodeURIComponent(specSessionMatch[1] as string);
      ctx.json(
        res,
        200,
        ControlSpecSession.parse(await required(ctx.services?.getSpecSession)(id)),
      );
      return true;
    }
    const specAnswersMatch = /^\/spec\/sessions\/([^/]+)\/answers$/.exec(path);
    if (method === "POST" && specAnswersMatch) {
      const id = decodeURIComponent(specAnswersMatch[1] as string);
      ctx.json(res, 200, ControlSpecSession.parse(await answerSession(ctx, id, req)));
      return true;
    }
    const specFreezeMatch = /^\/spec\/sessions\/([^/]+)\/freeze$/.exec(path);
    if (method === "POST" && specFreezeMatch) {
      const id = decodeURIComponent(specFreezeMatch[1] as string);
      ctx.json(
        res,
        200,
        ControlSpecSession.parse(await required(ctx.services?.freezeSpecSession)(id)),
      );
      return true;
    }
    const specCancelMatch = /^\/spec\/sessions\/([^/]+)\/cancel$/.exec(path);
    if (method === "POST" && specCancelMatch) {
      const id = decodeURIComponent(specCancelMatch[1] as string);
      ctx.json(
        res,
        200,
        ControlSpecSession.parse(await required(ctx.services?.cancelSpecSession)(id)),
      );
      return true;
    }
    const specResumeMatch = /^\/spec\/sessions\/([^/]+)\/resume$/.exec(path);
    if (method === "POST" && specResumeMatch) {
      const id = decodeURIComponent(specResumeMatch[1] as string);
      ctx.json(
        res,
        200,
        ControlSpecSession.parse(await required(ctx.services?.resumeSpecSession)(id)),
      );
      return true;
    }
    return false;
  } catch (error) {
    ctx.requestError(res, error);
    return true;
  }
}

async function answerSession(
  ctx: SpecRouteContext,
  id: string,
  req: IncomingMessage,
): Promise<unknown> {
  const raw = await ctx.readBody(req);
  assertSpecSafe(raw);
  return required(ctx.services?.answerSpecSession)(id, ControlSpecAnswersRequest.parse(raw));
}

function assertSpecSafe(value: unknown): void {
  assertNoInlineSecretValues(value, "$", "spec body");
  if (!containsSecretLikeToken(JSON.stringify(value ?? null))) return;
  throw Object.assign(new Error("secret-like value is not accepted in durable spec content"), {
    status: 400,
  });
}

function required<T>(service: T | undefined): T {
  if (service) return service;
  throw Object.assign(new Error("durable spec sessions are not supported by this build"), {
    status: 501,
  });
}
