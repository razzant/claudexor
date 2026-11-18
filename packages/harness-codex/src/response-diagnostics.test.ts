import { describe, expect, it } from "vitest";
import {
  errorClassName,
  responseEventType,
  responseParameter,
  transportErrorCode,
  vendorErrorCode,
} from "./response-diagnostics.js";

describe("the public projection of Codex diagnostic values (#697)", () => {
  it("keeps system and recognized transport codes", () => {
    for (const code of ["ECONNRESET", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_CLOSED"])
      expect(transportErrorCode(code)).toBe(code);
    expect(transportErrorCode("ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION")).toBe(
      "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
    );
    for (const code of ["notes/picnic.txt", "ERR_PICNIC", "UND_ERR_PICNIC", 7, undefined])
      expect(transportErrorCode(code)).toBeNull();
  });

  it("names recognized error classes without borrowing authority from the code", () => {
    for (const name of ["Error", "TypeError", "AggregateError", "AbortError", "CodexModelError"])
      expect(errorClassName(name)).toBe(name);
    expect(errorClassName("SocketError")).toBe("SocketError");
    expect(errorClassName("PicnicError")).toBeNull();
    expect(errorClassName("PicnicNotes")).toBeNull();
  });

  it("treats token-shaped provider values no vocabulary knows as private", () => {
    expect(vendorErrorCode("lilac_napkins")).toBeNull();
    expect(vendorErrorCode("usage_limit_exceeded")).toBeNull();
    expect(vendorErrorCode("usage_limit_reached")).toBe("usage_limit_reached");
    expect(responseEventType("response.picnic_notes")).toBeNull();
    expect(responseEventType("response.reasoning_summary_part.done")).toBe(
      "response.reasoning_summary_part.done",
    );
    expect(responseParameter("input[12].picnic")).toBe("[redacted]");
    expect(responseParameter("input[2].encrypted_content")).toBe("input[2].encrypted_content");
  });
});
