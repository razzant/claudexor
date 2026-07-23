import { describe, expect, it } from "vitest";
import { controlProblemError } from "@claudexor/control-api";
import { argvRequestsJson, cliFailureError, projectCliFailure } from "./cli-problem.js";

describe("CLI failure projection", () => {
  it("detects JSON mode before parsed args exist", () => {
    expect(argvRequestsJson(["doctor", "--json"])).toBe(true);
    expect(argvRequestsJson(["doctor", "--json=true"])).toBe(true);
    expect(argvRequestsJson(["doctor", "--json=false"])).toBe(false);
    expect(argvRequestsJson(["doctor", "--json-stream"])).toBe(false);
    expect(argvRequestsJson(["doctor", "--json", "--json=false"])).toBe(false);
    expect(argvRequestsJson(["doctor", "--json=false", "--json"])).toBe(true);
  });

  it("maps explicit categories to stable exit codes", () => {
    expect(projectCliFailure("bad flag", { category: "usage" }).exitCode).toBe(2);
    expect(projectCliFailure("bad field", { category: "validation" }).exitCode).toBe(2);
    expect(projectCliFailure("socket down", { category: "operational" }).exitCode).toBe(1);
    expect(projectCliFailure("boom", { category: "unexpected" }).exitCode).toBe(1);
  });

  it("preserves every safe typed problem field and the legacy error alias", () => {
    const failure = projectCliFailure(
      Object.assign(new Error("invalid request"), {
        code: "typed_refusal",
        status: 400,
        retryable: true,
        fieldErrors: { n: ["must be at least 1"] },
        requiredActions: ["raise n"],
        evidenceRefs: ["request.n"],
        context: { minimum: 1 },
      }),
    );
    expect(failure).toMatchObject({
      ok: false,
      exitCode: 2,
      code: "typed_refusal",
      status: 400,
      retryable: true,
      message: "invalid request",
      error: "invalid request",
      fieldErrors: { n: ["must be at least 1"] },
      requiredActions: ["raise n"],
      evidenceRefs: ["request.n"],
      context: { minimum: 1 },
    });
  });

  it("preserves a complete daemon/API problem through the CLI envelope", () => {
    const transported = controlProblemError(400, {
      code: "invalid_request",
      message: "Number must be greater than or equal to 1",
      retryable: false,
      fieldErrors: { n: ["Number must be greater than or equal to 1"] },
      requiredActions: ["raise n"],
      evidenceRefs: ["request.n"],
      context: { jobId: "job-1" },
    });
    expect(projectCliFailure(transported)).toMatchObject({
      ok: false,
      exitCode: 2,
      status: 400,
      code: "invalid_request",
      fieldErrors: { n: ["Number must be greater than or equal to 1"] },
      requiredActions: ["raise n"],
      evidenceRefs: ["request.n"],
      context: { jobId: "job-1" },
    });
  });

  it("projects Zod issues into concise structured field validation", () => {
    const issues = [
      { code: "too_small", path: ["n"], message: "Number must be greater than or equal to 1" },
      { code: "invalid_type", path: ["items", 0, "name"], message: "Expected string" },
      { code: "custom", path: ["__proto__", "value"], message: "Unsafe field" },
    ];
    const failure = projectCliFailure(
      Object.assign(new Error(JSON.stringify(issues, null, 2)), { issues }),
      { category: "validation" },
    );

    expect(failure).toMatchObject({
      exitCode: 2,
      message: "Number must be greater than or equal to 1",
      fieldErrors: {
        n: ["Number must be greater than or equal to 1"],
        "items[0].name": ["Expected string"],
        '["__proto__"].value': ["Unsafe field"],
      },
    });
    expect(failure.message).not.toContain('"too_small"');
    expect(Object.hasOwn(failure.fieldErrors, "__proto__")).toBe(false);
  });

  it("does not promote a raw Node errno to the public domain code", () => {
    const failure = projectCliFailure(
      Object.assign(new Error("EPERM: operation not permitted, fchmod"), {
        code: "EPERM",
        syscall: "fchmod",
        status: 500,
      }),
      { category: "operational", fallbackCode: "daemon_bootstrap_failed" },
    );
    expect(failure).toMatchObject({
      exitCode: 1,
      code: "daemon_bootstrap_failed",
      context: { systemCode: "EPERM", syscall: "fchmod" },
    });
  });

  it("makes circular, bigint, and otherwise non-JSON context serializable", () => {
    const context: Record<string, unknown> = { bytes: 42n, callback: () => undefined };
    context["self"] = context;
    const failure = projectCliFailure(
      Object.assign(new Error("failed"), {
        code: "typed_failure",
        status: 500,
        context,
      }),
    );
    expect(() => JSON.stringify(failure)).not.toThrow();
    expect(failure.context).toMatchObject({
      bytes: "42",
      callback: null,
      self: "[Circular]",
    });
  });

  it("does not mistake a shared acyclic context value for a cycle", () => {
    const shared = { value: 1 };
    const failure = projectCliFailure(
      Object.assign(new Error("failed"), {
        code: "typed_failure",
        status: 500,
        context: { first: shared, second: shared },
      }),
    );
    expect(failure.context).toEqual({
      first: { value: 1 },
      second: { value: 1 },
    });
  });

  it("carries a projected bootstrap problem across async boundaries", () => {
    const carried = cliFailureError(
      Object.assign(new Error("operation not permitted"), {
        code: "EPERM",
        syscall: "fchmod",
      }),
      {
        category: "operational",
        fallbackCode: "daemon_bootstrap_failed",
        status: 500,
      },
    );
    expect(projectCliFailure(carried)).toMatchObject({
      exitCode: 1,
      code: "daemon_bootstrap_failed",
      status: 500,
      context: { systemCode: "EPERM", syscall: "fchmod" },
    });
  });

  it("replaces secret-bearing codes and makes redacted object-key collisions explicit", () => {
    const firstSecret = `ghp_${"a".repeat(36)}`;
    const secondSecret = `ghp_${"b".repeat(36)}`;
    const fieldErrors = Object.fromEntries([
      [firstSecret, ["first"]],
      [secondSecret, ["second"]],
      ["[redacted]", ["literal"]],
      ["__proto__", ["prototype key"]],
    ]);
    const nested = Object.fromEntries([
      [firstSecret, 1],
      [secondSecret, 2],
    ]);
    const context = Object.fromEntries([
      [firstSecret, "first"],
      [secondSecret, "second"],
      ["[redacted]", "literal"],
      ["constructor", "prototype key"],
      ["nested", nested],
    ]);
    const source = Object.assign(new Error(`failed for ${firstSecret}`), {
      status: 500,
      code: `typed_${firstSecret}`,
      fieldErrors,
      context,
    });

    const failure = projectCliFailure(source, {
      category: "unexpected",
      fallbackCode: "daemon_request_failed",
    });

    expect(failure.code).toBe("daemon_request_failed");
    expect(Object.keys(failure.fieldErrors)).toEqual([
      "[redacted]",
      "[redacted]#2",
      "[redacted]#3",
      '["__proto__"]',
    ]);
    expect(Object.keys(failure.context)).toEqual([
      "[redacted]",
      "[redacted]#2",
      "[redacted]#3",
      '["constructor"]',
      "nested",
    ]);
    expect(failure.context["nested"]).toEqual({
      "[redacted]": 1,
      "[redacted]#2": 2,
    });
    expect(Object.hasOwn(failure.fieldErrors, "__proto__")).toBe(false);
    expect(Object.hasOwn(failure.context, "constructor")).toBe(false);
    const serialized = JSON.stringify(failure);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(serialized).not.toContain(firstSecret);
    expect(serialized).not.toContain(secondSecret);

    expect(
      projectCliFailure(source, {
        category: "unexpected",
        fallbackCode: firstSecret,
      }).code,
    ).toBe("unexpected_error");
  });

  it("redacts short credentials by key and boundary-prefixed tokens everywhere", () => {
    const token = `ghp_${"a".repeat(36)}`;
    let privateKeyGetterRead = false;
    const nested: Record<string, unknown> = {
      accessToken: "short-token",
      db_pwd: "short-password",
      note: `x${token}`,
    };
    Object.defineProperty(nested, "privateKey", {
      enumerable: true,
      get() {
        privateKeyGetterRead = true;
        return "short-private-key";
      },
    });
    const source = Object.assign(new Error(`failed for x${token}`), {
      status: 500,
      code: `typed_x${token}`,
      context: {
        credentials: {
          password: "hunter2",
          authorization: "Basic dXNlcjpwYXNzd29yZA==",
          api_key: "opaque-short-value",
        },
        nested,
        credentialProfileId: "work",
        credentialProfileSecret: "profile-secret-value",
        tokenCount: 3,
        publicKey: "public-value",
        monkey: "banana",
      },
    });

    const serialized = JSON.stringify(
      projectCliFailure(source, { fallbackCode: "daemon_request_failed" }),
    );
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("dXNlcjpwYXNzd29yZA");
    expect(serialized).not.toContain("opaque-short-value");
    expect(serialized).not.toContain("short-token");
    expect(serialized).not.toContain("short-private-key");
    expect(serialized).not.toContain("short-password");
    expect(serialized).not.toContain("profile-secret-value");
    expect(serialized).not.toContain(token);
    expect(privateKeyGetterRead).toBe(false);
    expect(JSON.parse(serialized)).toMatchObject({
      code: "daemon_request_failed",
      context: {
        credentials: "[redacted]",
        nested: {
          accessToken: "[redacted]",
          privateKey: "[redacted]",
          db_pwd: "[redacted]",
        },
        credentialProfileId: "work",
        credentialProfileSecret: "[redacted]",
        tokenCount: 3,
        publicKey: "public-value",
        monkey: "banana",
      },
    });
  });

  it("redacts a token that crosses a public-text truncation boundary", () => {
    const token = `ghp_${"z".repeat(36)}`;
    const failure = projectCliFailure(
      Object.assign(new Error(`${"x".repeat(990)}${token}`), {
        status: 500,
        code: `${"x".repeat(225)}${token}`,
        context: { note: `${"x".repeat(225)}${token}` },
      }),
      { fallbackCode: "daemon_request_failed" },
    );
    const wire = JSON.stringify(failure);

    expect(failure.code).toBe("daemon_request_failed");
    expect(failure.message).toBe("[redacted]");
    expect(wire).not.toContain("ghp_");
    expect(wire).not.toContain(token);
  });

  it("bounds expansion of a highly shared acyclic context graph", () => {
    let level: unknown = { leaf: "safe" };
    for (let depth = 0; depth < 8; depth += 1) {
      level = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`n${index}`, level]));
    }
    const failure = projectCliFailure(
      Object.assign(new Error("failed"), {
        status: 500,
        code: "bounded_failure",
        context: level,
      }),
    );
    const serialized = JSON.stringify(failure);
    expect(serialized.length).toBeLessThan(200_000);
    expect(serialized).toContain("[Truncated]");
    expect(() => JSON.parse(serialized)).not.toThrow();
  });

  it("fails closed for revoked proxy values instead of breaking the envelope", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    const failure = projectCliFailure(
      Object.assign(new Error("failed"), {
        status: 500,
        context: { hostile: proxy },
      }),
    );

    expect(() => JSON.stringify(failure)).not.toThrow();
  });

  it("fails closed when an array proxy throws while reading its length", () => {
    const hostile = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") throw new Error("hostile length");
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      projectCliFailure(
        Object.assign(new Error("failed"), {
          context: { hostile },
          requiredActions: hostile,
        }),
      ),
    ).not.toThrow();
  });
});
