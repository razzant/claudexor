import { describe, expect, it } from "vitest";
import { daemonJobFailure } from "./job-problem.js";

describe("daemon job problem projection", () => {
  it("preserves a safe typed domain code", () => {
    expect(
      daemonJobFailure(
        Object.assign(new Error("access required"), {
          status: 403,
          code: "trust_required",
        }),
      ),
    ).toMatchObject({
      status: 403,
      problem: {
        code: "trust_required",
        message: "access required",
      },
    });
  });

  it("preserves a lowercase code-only domain error", () => {
    expect(
      daemonJobFailure(
        Object.assign(new Error("attachment digest mismatch"), {
          code: "attachment_digest_mismatch",
        }),
      ),
    ).toMatchObject({
      problem: {
        code: "attachment_digest_mismatch",
        message: "attachment digest mismatch",
      },
    });
  });

  it("keeps raw Node errno codes out of the public domain-code slot", () => {
    const failure = daemonJobFailure(
      Object.assign(new Error("EPERM: operation not permitted, fchmod"), {
        code: "EPERM",
        syscall: "fchmod",
        path: "/tmp/daemon-token",
        status: 500,
      }),
    );

    expect(failure).toMatchObject({
      status: 500,
      problem: {
        code: "daemon_job_failed",
        context: {
          systemCode: "EPERM",
          syscall: "fchmod",
          path: "/tmp/daemon-token",
        },
      },
    });
  });

  it("replaces secret-bearing codes and safely disambiguates redacted object keys", () => {
    const firstSecret = `ghp_${"a".repeat(36)}`;
    const secondSecret = `ghp_${"b".repeat(36)}`;
    const fieldErrors = Object.fromEntries([
      [firstSecret, ["first"]],
      [secondSecret, ["second"]],
      ["[redacted]", ["literal"]],
      ["prototype", ["prototype key"]],
    ]);
    const nested = Object.fromEntries([
      [firstSecret, 1],
      [secondSecret, 2],
    ]);
    const context = Object.fromEntries([
      [firstSecret, "first"],
      [secondSecret, "second"],
      ["[redacted]", "literal"],
      ["__proto__", "prototype key"],
      ["nested", nested],
    ]);

    const failure = daemonJobFailure(
      Object.assign(new Error(`failed for ${firstSecret}`), {
        status: 500,
        code: `typed_${firstSecret}`,
        fieldErrors,
        context,
      }),
    );

    expect(failure.problem.code).toBe("daemon_job_failed");
    expect(Object.keys(failure.problem.fieldErrors)).toEqual([
      "[redacted]",
      "[redacted]#2",
      "[redacted]#3",
      '["prototype"]',
    ]);
    expect(Object.keys(failure.problem.context)).toEqual([
      "[redacted]",
      "[redacted]#2",
      "[redacted]#3",
      '["__proto__"]',
      "nested",
    ]);
    expect(failure.problem.context["nested"]).toEqual({
      "[redacted]": "[redacted]",
      "[redacted]#2": "[redacted]",
    });
    expect(Object.hasOwn(failure.problem.fieldErrors, "prototype")).toBe(false);
    expect(Object.hasOwn(failure.problem.context, "__proto__")).toBe(false);
    const serialized = JSON.stringify(failure);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(serialized).not.toContain(firstSecret);
    expect(serialized).not.toContain(secondSecret);
  });

  it("screens prefixed secret atoms on every public surface without key collisions", () => {
    const secret = `ghp_${"c".repeat(36)}`;
    const prefixed = `x${secret}`;
    const failure = daemonJobFailure(
      Object.assign(new Error(`failed for ${prefixed}`), {
        code: `typed_${prefixed}`,
        fieldErrors: Object.fromEntries([
          [prefixed, [prefixed]],
          ["x[redacted]", ["literal"]],
        ]),
        requiredActions: [`replace ${prefixed}`],
        evidenceRefs: [prefixed],
        context: Object.fromEntries([
          [prefixed, "opaque-short-value"],
          ["x[redacted]", "literal"],
          ["value", prefixed],
        ]),
      }),
    );

    expect(failure.problem.code).toBe("daemon_job_failed");
    expect(Object.keys(failure.problem.fieldErrors)).toEqual(["[redacted]", "x[redacted]"]);
    expect(Object.keys(failure.problem.context)).toEqual(["[redacted]", "x[redacted]", "value"]);
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(prefixed);
    expect(serialized).not.toContain("opaque-short-value");
  });

  it("redacts short sensitive-key subtrees and omits sensitive enumerable fields", () => {
    const context: Record<string, unknown> = {
      password: "short-password-value",
      apiKey: { raw: "short-api-value" },
      private_key: "short-private-value",
      dbpwd: "short-pwd-value",
      clientsecret: "short-client-secret-value",
      credentialValue: "short-credential-value",
      credentialsForRoute: { raw: "short-credential-container-value" },
      nested: {
        credentials: { raw: "short-credentials-value" },
        sessionCookie: "short-cookie-value",
      },
      credentialProfileId: "profile-id",
      credentialProfileSecret: "short-profile-secret-value",
      tokenCount: 2,
      publicKey: "public-key",
      monkey: "banana",
      long: "l".repeat(257),
    };
    let sensitiveGetterRead = false;
    Object.defineProperty(context, "clientSecret", {
      enumerable: true,
      get() {
        sensitiveGetterRead = true;
        return "short-getter-value";
      },
    });
    const error = Object.assign(new Error("failed"), {
      context,
      authorization: "short-auth-value",
      refresh_token: "short-token-value",
    });

    const failure = daemonJobFailure(error);

    expect(failure.problem.context).toMatchObject({
      password: "[redacted]",
      apiKey: "[redacted]",
      private_key: "[redacted]",
      dbpwd: "[redacted]",
      clientsecret: "[redacted]",
      credentialValue: "[redacted]",
      credentialsForRoute: "[redacted]",
      nested: {
        credentials: "[redacted]",
        sessionCookie: "[redacted]",
      },
      credentialProfileId: "profile-id",
      credentialProfileSecret: "[redacted]",
      tokenCount: 2,
      publicKey: "public-key",
      monkey: "banana",
      long: "[redacted]",
      clientSecret: "[redacted]",
    });
    expect(Object.hasOwn(failure.problem.context, "authorization")).toBe(false);
    expect(Object.hasOwn(failure.problem.context, "refresh_token")).toBe(false);
    expect(sensitiveGetterRead).toBe(false);
    const serialized = JSON.stringify(failure);
    for (const secret of [
      "short-password-value",
      "short-api-value",
      "short-private-value",
      "short-pwd-value",
      "short-client-secret-value",
      "short-credential-value",
      "short-credential-container-value",
      "short-profile-secret-value",
      "short-credentials-value",
      "short-cookie-value",
      "short-getter-value",
      "short-auth-value",
      "short-token-value",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("projects Zod-like issues as concise non-retryable request failures", () => {
    const issues = [
      { code: "too_small", path: ["n"], message: "Number must be at least 1" },
      { code: "invalid_type", path: ["items", 0], message: "Expected an item" },
    ];
    const failure = daemonJobFailure(
      Object.assign(new Error(JSON.stringify(issues)), {
        issues,
        path: "/tmp/request.json",
        recovery: { action: "edit input" },
      }),
    );

    expect(failure).toEqual({
      status: 400,
      problem: {
        code: "invalid_request",
        message: "Number must be at least 1",
        retryable: false,
        fieldErrors: {
          n: ["Number must be at least 1"],
          "items[0]": ["Expected an item"],
        },
        requiredActions: [],
        evidenceRefs: [],
        context: {
          path: "/tmp/request.json",
          recovery: { action: "edit input" },
        },
      },
    });
    expect(failure.problem.message).not.toContain('"too_small"');
  });

  it("preserves explicit typed validation status, code, and retryability", () => {
    const failure = daemonJobFailure(
      Object.assign(new Error("schema rejected"), {
        status: 422,
        code: "schema_dialect_invalid",
        retryable: true,
        issues: [{ path: ["schema"], message: "Unsupported dialect" }],
      }),
    );

    expect(failure).toMatchObject({
      status: 422,
      problem: {
        code: "schema_dialect_invalid",
        retryable: true,
        fieldErrors: { schema: ["Unsupported dialect"] },
      },
    });
  });

  it("marks only real ancestor cycles while preserving shared acyclic values", () => {
    const shared = { source: "request" };
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;

    const failure = daemonJobFailure(
      Object.assign(new Error("failed"), {
        context: {
          first: shared,
          second: shared,
          cycle,
        },
      }),
    );

    expect(failure.problem.context).toEqual({
      first: { source: "request" },
      second: { source: "request" },
      cycle: { self: "[Circular]" },
    });
    expect(() => JSON.stringify(failure)).not.toThrow();
  });

  it("bounds shared-reference DAG expansion without mislabeling it circular", () => {
    let dag: unknown = { leaf: "ordinary" };
    for (let level = 0; level < 4; level += 1) {
      const previous = dag;
      dag = { branches: Array.from({ length: 50 }, () => previous) };
    }

    const failure = daemonJobFailure(
      Object.assign(new Error("failed"), {
        context: { dag },
      }),
    );
    const serialized = JSON.stringify(failure.problem.context);

    expect(serialized).toContain("[Truncated]");
    expect(serialized).not.toContain("[Circular]");
    expect(serialized.length).toBeLessThan(20_000);
  });

  it("preserves a non-transport domain status in context", () => {
    const failure = daemonJobFailure(
      Object.assign(new Error("still working"), {
        status: "pending",
      }),
    );

    expect(failure.status).toBeUndefined();
    expect(failure.problem.context).toEqual({ status: "pending" });
  });

  it("fails closed for revoked proxy values instead of breaking durable projection", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    const failure = daemonJobFailure(
      Object.assign(new Error("failed"), {
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
      daemonJobFailure(
        Object.assign(new Error("failed"), {
          issues: hostile,
          context: { hostile },
        }),
      ),
    ).not.toThrow();
  });
});
