import { describe, expect, it } from "vitest";
import { ControlUploadCreateRequest } from "./attachment.js";

describe("ControlUploadCreateRequest", () => {
  it("rejects an unknown field and still accepts the declared request", () => {
    const request = { kind: "file" as const, mime: "text/plain", name: "note.txt", sizeBytes: 4 };
    expect(ControlUploadCreateRequest.parse(request)).toMatchObject(request);
    expect(() => ControlUploadCreateRequest.parse({ ...request, extra: true })).toThrow();
  });
});
