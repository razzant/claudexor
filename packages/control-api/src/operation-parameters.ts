import type { ControlOperationParameter } from "@claudexor/schema";

/**
 * Located-parameter builders (QA-055). A descriptor's `requestSchema` is the
 * JSON request BODY; strict query filters and SSE resume-cursor headers are
 * separate non-body inputs, so they get their own typed channel. Every field is
 * spelled explicitly so the generated catalog/endpoints doc can construct a
 * full valid request without guessing.
 */
export function queryParam(input: {
  name: string;
  description: string;
  required?: boolean;
  repeatable?: boolean;
  enum?: string[] | null;
  schemaRef?: string | null;
}): ControlOperationParameter {
  return {
    name: input.name,
    location: "query",
    required: input.required ?? false,
    repeatable: input.repeatable ?? false,
    enum: input.enum ?? null,
    schemaRef: input.schemaRef ?? null,
    description: input.description,
  };
}

export function headerParam(input: {
  name: string;
  description: string;
  required?: boolean;
  enum?: string[] | null;
  schemaRef?: string | null;
}): ControlOperationParameter {
  return {
    name: input.name,
    location: "header",
    required: input.required ?? false,
    repeatable: false,
    enum: input.enum ?? null,
    schemaRef: input.schemaRef ?? null,
    description: input.description,
  };
}

/** The standard SSE resume header, specialized per stream by cursor semantics. */
export const resumeHeader = (cursorSemantics: string): ControlOperationParameter =>
  headerParam({
    name: "Last-Event-ID",
    description: `Resume cursor sent on reconnect: ${cursorSemantics}. Omit to snapshot-then-subscribe from the beginning.`,
  });

/**
 * QA-066: true when every `/`-delimited path segment is strict-decodable (valid
 * percent escapes over valid UTF-8). Used at the protocol boundary to classify a
 * malformed request path as a typed client 400 before any route owner calls
 * `decodeURIComponent` and throws a `URIError` into the generic 500 handler. The
 * raw path is never echoed.
 */
export function pathnameDecodes(pathname: string): boolean {
  try {
    for (const segment of pathname.split("/")) decodeURIComponent(segment);
    return true;
  } catch {
    return false;
  }
}
