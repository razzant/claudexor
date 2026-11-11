import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "./args.js";
import { commandFlagScopeError, commandPositionalError } from "./command-scope.js";
import { uploadCommand } from "./upload-command.js";

const mocks = vi.hoisted(() => ({ query: vi.fn(), print: vi.fn() }));
vi.mock("./upload-query.js", () => ({ uploadQuery: mocks.query }));
vi.mock("./cli-io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cli-io.js")>()),
  printJson: mocks.print,
}));
afterEach(() => vi.resetAllMocks());

describe("upload CLI controls", () => {
  it.each([
    [
      "upload-create",
      [
        "--request-json",
        '{"kind":"file","mime":"text/plain","name":"note.txt","sizeBytes":8}',
        "--idempotency-key",
        "create-key",
      ],
      {
        request: { kind: "file", mime: "text/plain", name: "note.txt", sizeBytes: 8 },
        idempotencyKey: "create-key",
      },
    ],
    ["upload-import-local", ["u", "/host/note.txt"], { uploadId: "u", path: "/host/note.txt" }],
    ["upload-status", ["u"], { uploadId: "u" }],
    [
      "upload-finalize",
      [
        "u",
        "--request-json",
        '{"expectedSha256":"sha256:saved"}',
        "--idempotency-key",
        "final-key",
      ],
      { uploadId: "u", request: { expectedSha256: "sha256:saved" }, idempotencyKey: "final-key" },
    ],
    ["upload-cancel", ["u"], { uploadId: "u" }],
  ] as const)("registers and forwards %s", async (command, tokens, expected) => {
    const args = parseArgs([command, ...tokens, "--json"]);
    expect(commandFlagScopeError(command, Object.keys(args.flags))).toBeNull();
    expect(commandPositionalError(command, args._.slice(1))).toBeNull();
    mocks.query.mockResolvedValue({ uploadId: "u" });
    expect(await uploadCommand(args, true)).toBe(0);
    expect(mocks.query).toHaveBeenCalledWith(
      command.slice("upload-".length).replaceAll("-", "_"),
      expected,
    );
    expect(mocks.print).toHaveBeenCalledWith({ uploadId: "u" });
  });
  it("keeps stage flags off unrelated commands", () => {
    expect(commandFlagScopeError("ask", ["request-json"])).toContain("--request-json");
    expect(commandFlagScopeError("upload-status", ["idempotency-key"])).toContain(
      "--idempotency-key",
    );
    expect(commandPositionalError("upload-import-local", ["u"])).toBeTruthy();
  });

  const storeId = "11111111-1111-4111-8111-111111111111";
  const importArgs = (...extra: string[]) =>
    parseArgs([
      "upload-import",
      "/host/note.txt",
      "--expected-store-id",
      storeId,
      "--idempotency-key",
      "import-key",
      ...extra,
      "--json",
    ]);
  const importIdentity = {
    path: "/host/note.txt",
    expectedStoreId: storeId,
    idempotencyKey: "import-key",
  };

  it("forwards store identity and keyed import with only kind/mime/name from --request-json", async () => {
    mocks.query.mockResolvedValue({ state: "ready" });
    const identity = parseArgs(["store-identity", "--json"]);
    expect(commandFlagScopeError("store-identity", Object.keys(identity.flags))).toBeNull();
    expect(await uploadCommand(identity, true)).toBe(0);
    expect(mocks.query).toHaveBeenLastCalledWith("store_identity", {});
    const metadata = { kind: "file", mime: "text/markdown", name: "Brief.md" };
    const args = importArgs("--request-json", JSON.stringify(metadata));
    expect(commandFlagScopeError("upload-import", Object.keys(args.flags))).toBeNull();
    expect(commandPositionalError("upload-import", args._.slice(1))).toBeNull();
    expect(await uploadCommand(args, true)).toBe(0);
    expect(mocks.query).toHaveBeenLastCalledWith("import", { ...metadata, ...importIdentity });
    expect(await uploadCommand(importArgs(), true)).toBe(0);
    expect(mocks.query).toHaveBeenLastCalledWith("import", importIdentity);
    expect(mocks.print).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["path", { path: "/host/other.txt" }],
    ["expectedStoreId", { expectedStoreId: "22222222-2222-4222-8222-222222222222" }],
    ["idempotencyKey", { idempotencyKey: "other-key" }],
  ])("refuses %s inside upload-import --request-json", async (field, smuggled) => {
    const args = importArgs("--request-json", JSON.stringify({ name: "note.txt", ...smuggled }));
    expect(await uploadCommand(args, true)).toBe(2);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.print).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        code: "invalid_argument",
        message: expect.stringContaining(`'${field}'`),
      }),
    );
  });

  it("does not let --request-json stand in for the import's explicit arguments", async () => {
    const args = parseArgs([
      "upload-import",
      "/host/note.txt",
      "--request-json",
      JSON.stringify({ expectedStoreId: storeId, idempotencyKey: "import-key" }),
      "--json",
    ]);
    expect(await uploadCommand(args, true)).toBe(2);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
