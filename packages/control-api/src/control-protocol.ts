import {
  CONTROL_PROTOCOL_MAJOR,
  ControlHandshakeRequest,
  ControlHandshakeResponse,
  ControlProblem,
} from "@claudexor/schema";
import { engineBuildIdentity } from "@claudexor/util";
import { OPERATION_CATALOG } from "./operation-catalog.js";
import { pathnameDecodes } from "./operation-parameters.js";

export type ControlProtocolBoundary =
  | { kind: "route"; path: string }
  | { kind: "response"; status: number; body: unknown; contentType: string };

/** Product admission mode carried into the protocol boundary (issue #165 D5). */
export type ControlServingMode = NonNullable<ControlHandshakeResponse["servingMode"]>;

const protocolProblem = (code: string, message: string, requiredActions: string[] = []) =>
  ControlProblem.parse({
    code,
    message,
    retryable: false,
    fieldErrors: {},
    requiredActions,
    evidenceRefs: [],
  });

/** Stateless v2 negotiation boundary; product handlers only see unversioned internal paths. */
export async function resolveControlProtocol(input: {
  method: string;
  requestPath: string;
  requestedMajor: string | string[] | undefined;
  readBody: () => Promise<unknown>;
  servingMode?: ControlServingMode;
  storeId?: () => string | undefined;
  /** The request opted in to `storeId` (`X-Claudexor-Store-Identity: 1`). */
  wantsStoreId?: boolean;
}): Promise<ControlProtocolBoundary> {
  const servingMode = input.servingMode ?? "normal";
  if (input.method === "POST" && input.requestPath === "/v2/handshake") {
    const request = ControlHandshakeRequest.parse(await input.readBody());
    if (request.protocolMajor !== CONTROL_PROTOCOL_MAJOR) {
      return {
        kind: "response",
        status: 426,
        contentType: "application/problem+json",
        body: protocolProblem(
          "incompatible_protocol_major",
          `control protocol major ${request.protocolMajor} is incompatible; server requires ${CONTROL_PROTOCOL_MAJOR}`,
          [`use control protocol major ${CONTROL_PROTOCOL_MAJOR}`],
        ),
      };
    }
    // Read after the body await: storage may open or be replaced while it arrives. Only an
    // opted-in client gets it: the handshake response is strict for older same-major clients.
    const storeId = input.wantsStoreId ? input.storeId?.() : undefined;
    return {
      kind: "response",
      status: 200,
      contentType: "application/json",
      body: ControlHandshakeResponse.parse({
        protocolMajor: CONTROL_PROTOCOL_MAJOR,
        compatible: true,
        operationsPath: "/v2/operations",
        engine: engineBuildIdentity(),
        servingMode,
        ...(storeId === undefined ? {} : { storeId }),
      }),
    };
  }
  if (!input.requestPath.startsWith("/v2/")) {
    return {
      kind: "response",
      status: 404,
      contentType: "application/problem+json",
      body: protocolProblem("route_not_found", "product routes require the /v2 prefix"),
    };
  }
  if (input.requestedMajor !== String(CONTROL_PROTOCOL_MAJOR)) {
    return {
      kind: "response",
      status: 426,
      contentType: "application/problem+json",
      body: protocolProblem(
        "handshake_required",
        "a successful v2 handshake is required before product calls",
        ["POST /v2/handshake", `send X-Claudexor-Protocol-Major: ${CONTROL_PROTOCOL_MAJOR}`],
      ),
    };
  }
  if (input.method === "GET" && input.requestPath === "/v2/operations") {
    return {
      kind: "response",
      status: 200,
      contentType: "application/json",
      body: OPERATION_CATALOG,
    };
  }
  // QA-066: malformed percent-encoding in the path is a CLIENT syntax error —
  // validate the whole encoded pathname decodes ONCE, centrally, before route
  // dispatch (typed 400, not a per-route URIError into the 500 handler).
  // Routes still match on the ENCODED path; `%2F`/`%2e%2e` semantics unchanged.
  if (!pathnameDecodes(input.requestPath)) {
    return {
      kind: "response",
      status: 400,
      contentType: "application/problem+json",
      body: protocolProblem(
        "malformed_request_path",
        "request path contains malformed percent-encoding",
      ),
    };
  }
  const path = input.requestPath.slice(3);
  // Issue #165 D5: while the daemon serves recovery only, the journal
  // recovery surface stays reachable and every other product route gets one
  // typed retryable refusal instead of touching unactivated projections.
  if (
    servingMode === "recovery_only" &&
    !path.startsWith("/recovery/") &&
    !(input.method === "GET" && path === "/daemon/status")
  ) {
    return {
      kind: "response",
      status: 503,
      contentType: "application/problem+json",
      body: ControlProblem.parse({
        code: "daemon_recovery_only",
        message:
          "daemon is serving recovery only; product routes are closed until journal recovery completes",
        retryable: true,
        fieldErrors: {},
        requiredActions: ["retry after recovery completes"],
        evidenceRefs: [],
      }),
    };
  }
  return { kind: "route", path };
}
