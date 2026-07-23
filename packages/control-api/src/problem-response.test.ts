import { describe, expect, it } from "vitest";
import { controlProblemError, projectControlProblem } from "./problem-response.js";

describe("control problem projection", () => {
  it("projects Zod-like issues into safe field paths and a concise validation message", () => {
    const issues = [
      { code: "too_small", path: ["n"], message: "Number must be greater than or equal to 1" },
      { code: "invalid_type", path: ["items", 0, "name"], message: "Expected string" },
      { code: "custom", path: ["__proto__", "value"], message: "Unsafe field" },
    ];
    const error = Object.assign(new Error(JSON.stringify(issues, null, 2)), { issues });

    const projected = projectControlProblem(error, {
      status: 500,
      code: "internal_error",
      retryable: true,
    });

    expect(projected.status).toBe(400);
    expect(projected.body).toMatchObject({
      code: "invalid_request",
      message: "Number must be greater than or equal to 1",
      retryable: false,
      fieldErrors: {
        n: ["Number must be greater than or equal to 1"],
        "items[0].name": ["Expected string"],
        '["__proto__"].value': ["Unsafe field"],
      },
    });
    expect(projected.body.message).not.toContain('"too_small"');
    expect(Object.hasOwn(projected.body.fieldErrors, "__proto__")).toBe(false);
  });

  it("preserves a complete problem's HTTP status, flat context, and safe typed arrays", () => {
    const secret = `ghp_${"a".repeat(36)}`;
    const context: Record<string, unknown> = {
      attempt: 2,
      secret,
      unsupported: () => "not serializable",
      bigint: 42n,
    };
    context["self"] = context;
    const fieldErrors: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    fieldErrors["query"] = ["invalid", 7, `${secret} leaked`];
    fieldErrors["__proto__"] = ["not a prototype mutation"];

    const error = controlProblemError(422, {
      code: "request_rejected",
      message: "request rejected",
      retryable: false,
      fieldErrors,
      requiredActions: ["edit_input", 7, "", `${secret} leaked`],
      evidenceRefs: ["request.body", null],
      context,
      requestId: "req-1",
    });

    expect(error).toMatchObject({
      status: 422,
      code: "request_rejected",
      message: "request rejected",
      retryable: false,
      fieldErrors: {
        query: ["invalid", "[redacted] leaked"],
        '["__proto__"]': ["not a prototype mutation"],
      },
      requiredActions: ["edit_input", "[redacted] leaked"],
      evidenceRefs: ["request.body"],
      context: {
        attempt: 2,
        secret: "[redacted]",
        bigint: "42",
        self: "[circular]",
        requestId: "req-1",
      },
    });
    expect(error.context).not.toHaveProperty("context");
    expect(error.context).not.toHaveProperty("unsupported");
    expect(JSON.stringify(error.context)).not.toContain(secret);
  });

  it("honors a typed error status and fallback code without losing recovery details", () => {
    const error = Object.assign(new Error("try again"), {
      status: 409,
      code: "state_conflict",
      retryable: true,
      fieldErrors: { state: ["stale"] },
      requiredActions: ["refresh"],
      evidenceRefs: ["run:1"],
      context: { generation: 3 },
    });

    expect(
      projectControlProblem(error, {
        status: 500,
        code: "internal_error",
        retryable: false,
      }),
    ).toEqual({
      status: 409,
      body: {
        code: "state_conflict",
        message: "try again",
        retryable: true,
        fieldErrors: { state: ["stale"] },
        requiredActions: ["refresh"],
        evidenceRefs: ["run:1"],
        context: { generation: 3 },
      },
    });
  });

  it("preserves a safe plain-text HTTP error body", () => {
    expect(controlProblemError(502, "upstream returned invalid JSON")).toMatchObject({
      status: 502,
      code: "http_502",
      message: "upstream returned invalid JSON",
    });
  });

  it("keeps raw Node errno codes in system context instead of the domain-code slot", () => {
    const projected = projectControlProblem(
      Object.assign(new Error("EPERM: operation not permitted, fchmod"), {
        code: "EPERM",
        syscall: "fchmod",
        path: "/tmp/daemon-token",
      }),
      {
        status: 500,
        code: "internal_error",
        retryable: false,
      },
    );

    expect(projected.body).toMatchObject({
      code: "internal_error",
      context: {
        systemCode: "EPERM",
        syscall: "fchmod",
        path: "/tmp/daemon-token",
      },
    });
  });

  it("redacts explicit sensitive-key values and omits sensitive promoted error properties", () => {
    const explicitContext = {
      password: "plain-password-value",
      db_passwd: "plain-passwd-value",
      clientSecret: "plain-secret-value",
      access_token: "plain-token-value",
      authorization: "plain-authorization-value",
      apiKey: "plain-api-key-value",
      privateKey: "plain-private-key-value",
      db_pwd: "plain-pwd-value",
      service_credentials: "plain-credentials-value",
      sessionCookie: "plain-cookie-value",
      credentialProfileId: "work",
      credentialProfileSecret: "plain-profile-secret-value",
      tokenCount: 3,
      publicKey: "public-value",
      monkey: "banana",
      nested: {
        refreshToken: "nested-token-value",
        safe: "kept",
      },
    };
    const error = Object.assign(new Error("request failed"), {
      context: explicitContext,
      fieldErrors: {
        password: ["plain-field-password-value"],
      },
      topLevelPassword: "must not be promoted",
      access_token: "must not be promoted either",
      cookieJar: { session: "must not be promoted" },
      requestId: "req-safe",
    });

    const projected = projectControlProblem(error, {
      status: 500,
      code: "internal_error",
      retryable: false,
    });

    expect(projected.body.context).toMatchObject({
      password: "[redacted]",
      db_passwd: "[redacted]",
      clientSecret: "[redacted]",
      access_token: "[redacted]",
      authorization: "[redacted]",
      apiKey: "[redacted]",
      privateKey: "[redacted]",
      db_pwd: "[redacted]",
      service_credentials: "[redacted]",
      sessionCookie: "[redacted]",
      credentialProfileId: "work",
      credentialProfileSecret: "[redacted]",
      tokenCount: 3,
      publicKey: "public-value",
      monkey: "banana",
      nested: {
        refreshToken: "[redacted]",
        safe: "kept",
      },
      requestId: "req-safe",
    });
    expect(projected.body.context).not.toHaveProperty("topLevelPassword");
    expect(projected.body.context).not.toHaveProperty("cookieJar");
    expect(projected.body.fieldErrors).toEqual({ password: ["[redacted]"] });
    expect(JSON.stringify(projected.body.context)).not.toContain("plain-");
    expect(JSON.stringify(projected.body.context)).not.toContain("must not be promoted");
  });

  it("screens secret atoms without relying on word boundaries and falls back for codes", () => {
    const secret = `ghp_${"b".repeat(36)}`;
    const embedded = `prefix${secret}suffix`;
    const error = Object.assign(new Error(embedded), {
      code: `code${secret}suffix`,
      fieldErrors: { [`field${secret}suffix`]: [embedded] },
      requiredActions: [embedded],
      evidenceRefs: [embedded],
      context: { [`key${secret}suffix`]: embedded },
    });

    const projected = projectControlProblem(error, {
      status: 500,
      code: "internal_error",
      retryable: false,
    });
    const wire = JSON.stringify(projected.body);

    expect(projected.body.code).toBe("internal_error");
    expect(projected.body.message).toBe("[redacted]");
    expect(projected.body.fieldErrors).toEqual({ "[redacted]": ["[redacted]"] });
    expect(projected.body.requiredActions).toEqual(["[redacted]"]);
    expect(projected.body.evidenceRefs).toEqual(["[redacted]"]);
    expect(projected.body.context).toEqual({ "[redacted]": "[redacted]" });
    expect(wire).not.toContain(secret);
    expect(wire).not.toContain("ghp_");
  });

  it("redacts a token that crosses the public-atom truncation boundary", () => {
    const token = `ghp_${"z".repeat(36)}`;
    const boundaryValue = `${"x".repeat(225)}${token}`;
    const projected = projectControlProblem(
      Object.assign(new Error(boundaryValue), {
        code: boundaryValue,
        context: { note: boundaryValue },
      }),
      {
        status: 500,
        code: "internal_error",
        retryable: false,
      },
    );
    const wire = JSON.stringify(projected.body);

    expect(projected.body.code).toBe("internal_error");
    expect(projected.body.message).toBe("[redacted]");
    expect(wire).not.toContain("ghp_");
    expect(wire).not.toContain(token);
  });

  it("keeps sanitized key collisions distinct, including prototype-name mappings", () => {
    const secret = `ghp_${"c".repeat(36)}`;
    const context = Object.create(null) as Record<string, unknown>;
    context["__proto__"] = "prototype-name";
    context['["__proto__"]'] = "already-mapped";
    context[secret] = "first secret-key value";
    context[`prefix${secret}`] = "second secret-key value";
    const fieldErrors = Object.create(null) as Record<string, unknown>;
    fieldErrors["__proto__"] = ["first"];
    fieldErrors['["__proto__"]'] = ["second"];

    const error = controlProblemError(422, {
      code: "request_rejected",
      message: "request rejected",
      fieldErrors,
      context,
    });

    expect(error.context).toEqual({
      '["__proto__"]': "prototype-name",
      '["__proto__"]#2': "already-mapped",
      "[redacted]": "[redacted]",
      "[redacted]#2": "[redacted]",
    });
    expect(error.fieldErrors).toEqual({
      '["__proto__"]': ["first"],
      '["__proto__"]#2': ["second"],
    });
  });

  it("bounds the whole traversal without treating shared acyclic values as circular", () => {
    const shared = { value: "preserved twice" };
    let dag: Record<string, unknown> = { leaf: "bounded" };
    for (let depth = 0; depth < 18; depth += 1) {
      dag = { left: dag, right: dag };
    }

    const error = controlProblemError(500, {
      message: "failed",
      context: {
        first: shared,
        second: shared,
        oversized: "x".repeat(10_000),
        expansion: dag,
      },
    });
    const serialized = JSON.stringify(error.context);

    expect(error.context).toMatchObject({
      first: { value: "preserved twice" },
      second: { value: "preserved twice" },
    });
    expect(error.context["oversized"]).toMatch(/\[truncated\]$/);
    expect(serialized).not.toContain("[circular]");
    expect(serialized).toContain("[truncated]");
    expect(serialized.length).toBeLessThan(25_000);
  });

  it("only reserves a numeric HTTP status and preserves domain statuses in context", () => {
    const domainStatus = projectControlProblem(
      Object.assign(new Error("still working"), { status: "pending" }),
      {
        status: 503,
        code: "service_unavailable",
        retryable: true,
      },
    );
    const transportStatus = projectControlProblem(
      Object.assign(new Error("conflict"), { status: 409 }),
      {
        status: 503,
        code: "service_unavailable",
        retryable: true,
      },
    );

    expect(domainStatus.status).toBe(503);
    expect(domainStatus.body.context).toEqual({ status: "pending" });
    expect(transportStatus.status).toBe(409);
    expect(transportStatus.body.context).not.toHaveProperty("status");
  });

  it("does not duplicate identical top-level aliases already present in explicit context", () => {
    const projected = projectControlProblem(
      {
        code: "job_failed",
        message: "job failed",
        retryable: false,
        fieldErrors: {},
        requiredActions: [],
        evidenceRefs: [],
        context: { jobId: "job-1", state: "failed" },
        jobId: "job-1",
        state: "failed",
      },
      {
        status: 500,
        code: "internal_error",
        retryable: false,
      },
    );

    expect(projected.body.context).toEqual({ jobId: "job-1", state: "failed" });
  });

  it("redacts validation messages attached to sensitive field paths", () => {
    const projected = projectControlProblem(
      Object.assign(new Error("validation failed"), {
        issues: [{ path: ["password"], message: "Password hunter2 is invalid" }],
      }),
      {
        status: 500,
        code: "internal_error",
        retryable: true,
      },
    );

    expect(projected.body.message).toBe("[redacted]");
    expect(projected.body.fieldErrors).toEqual({ password: ["[redacted]"] });
    expect(JSON.stringify(projected.body)).not.toContain("hunter2");
  });

  it("fails closed for revoked proxy values instead of breaking the problem response", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    const projected = projectControlProblem(
      Object.assign(new Error("failed"), {
        context: { hostile: proxy },
      }),
      {
        status: 500,
        code: "internal_error",
        retryable: false,
      },
    );

    expect(() => JSON.stringify(projected.body)).not.toThrow();
  });

  it("fails closed when an array proxy throws while reading its length", () => {
    const hostile = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") throw new Error("hostile length");
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      projectControlProblem(
        Object.assign(new Error("failed"), {
          issues: hostile,
          context: { hostile },
        }),
        {
          status: 500,
          code: "internal_error",
          retryable: false,
        },
      ),
    ).not.toThrow();
  });
});
