import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ControlJournalExportReceipt,
  ControlJournalInspection,
  ControlJournalQuarantineReceipt,
  ControlJournalQuarantineRequest,
  ControlJournalValidation,
} from "@claudexor/schema";
import { assertNoInlineSecretValues } from "@claudexor/util";
import { requiredIdempotencyKey } from "./run-start.js";

export interface RecoveryRouteContext {
  services?: {
    recoveryInspectPartition?: (partition: string) => Promise<unknown>;
    recoveryValidatePartition?: (partition: string) => Promise<unknown>;
    recoveryExportPartition?: (partition: string) => Promise<unknown>;
    recoveryQuarantinePartition?: (partition: string, input: unknown) => Promise<unknown>;
  };
  readBody(req: IncomingMessage): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown): void;
}

export async function handleRecoveryRoute(
  ctx: RecoveryRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  try {
    const inspectMatch = /^\/recovery\/partitions\/([^/]+)$/.exec(path);
    if (method === "GET" && inspectMatch) {
      const partition = decodeURIComponent(inspectMatch[1] as string);
      const service = required(ctx.services?.recoveryInspectPartition);
      ctx.json(res, 200, ControlJournalInspection.parse(await service(partition)));
      return true;
    }
    const validateMatch = /^\/recovery\/partitions\/([^/]+)\/validate$/.exec(path);
    if (method === "POST" && validateMatch) {
      const partition = decodeURIComponent(validateMatch[1] as string);
      const service = required(ctx.services?.recoveryValidatePartition);
      ctx.json(res, 200, ControlJournalValidation.parse(await service(partition)));
      return true;
    }
    const exportMatch = /^\/recovery\/partitions\/([^/]+)\/export$/.exec(path);
    if (method === "POST" && exportMatch) {
      const partition = decodeURIComponent(exportMatch[1] as string);
      const service = required(ctx.services?.recoveryExportPartition);
      ctx.json(res, 200, ControlJournalExportReceipt.parse(await service(partition)));
      return true;
    }
    const quarantineMatch = /^\/recovery\/partitions\/([^/]+)\/quarantine$/.exec(path);
    if (method === "POST" && quarantineMatch) {
      const partition = decodeURIComponent(quarantineMatch[1] as string);
      const service = required(ctx.services?.recoveryQuarantinePartition);
      const idempotencyKey = requiredIdempotencyKey(req);
      const raw = await ctx.readBody(req);
      assertNoInlineSecretValues(raw);
      const body = ControlJournalQuarantineRequest.parse(raw);
      ctx.json(
        res,
        200,
        ControlJournalQuarantineReceipt.parse(
          await service(partition, { ...body, idempotencyKey }),
        ),
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
  throw Object.assign(new Error("journal recovery is not supported by this build"), {
    status: 501,
  });
}
