import { ControlRunStartRequest } from "@claudexor/schema";
import { normalizeRunStart } from "./run-start.js";

export interface RunStartPreparation {
  validateResources?: (refs: NonNullable<ControlRunStartRequest["attachments"]>) => Promise<void>;
  preflightRunRequirements?: (request: ControlRunStartRequest) => Promise<void>;
}

/** Shared below HTTP: normalization, immutable resource admission and current
 * capabilities. Continuation terminality/reservation stays with its owner. */
export async function prepareRunStart(
  raw: unknown,
  services: RunStartPreparation,
): Promise<ControlRunStartRequest> {
  const request = normalizeRunStart(ControlRunStartRequest.parse(raw));
  await services.validateResources?.(request.attachments ?? []);
  if (!request.threadId) await services.preflightRunRequirements?.(request);
  return request;
}
