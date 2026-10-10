import { afterEach, describe, expect, it, vi } from "vitest";
import { assertNoPluginArtifactSkew } from "./plugin-skew.js";

afterEach(() => vi.unstubAllEnvs());

describe("host-resolved plugin binding format", () => {
  it("accepts a supported dynamic runtime change without forging its generator version", () => {
    vi.stubEnv("CLAUDEXOR_HOST_BINDING_VERSION", "1");
    vi.stubEnv("CLAUDEXOR_DAEMON_OWNER", "external");
    vi.stubEnv("CLAUDEXOR_ROOT_MODE", "explicit");
    vi.stubEnv("CLAUDEXOR_PLUGIN_VERSION", "0.1.0");
    expect(() => assertNoPluginArtifactSkew("4.0.0")).not.toThrow();
    expect(process.env.CLAUDEXOR_PLUGIN_VERSION).toBe("0.1.0");
  });

  it("refuses unsupported formats and incomplete external bindings typed", () => {
    vi.stubEnv("CLAUDEXOR_HOST_BINDING_VERSION", "2");
    expect(() => assertNoPluginArtifactSkew("4.0.0")).toThrow(
      expect.objectContaining({ code: "host_binding_unsupported" }),
    );
    vi.stubEnv("CLAUDEXOR_HOST_BINDING_VERSION", "1");
    vi.stubEnv("CLAUDEXOR_DAEMON_OWNER", "standalone");
    expect(() => assertNoPluginArtifactSkew("4.0.0")).toThrow(
      expect.objectContaining({ code: "host_binding_invalid" }),
    );
  });

  it("keeps exact-runtime skew enforcement for fixed artifacts", () => {
    vi.stubEnv("CLAUDEXOR_HOST_BINDING_VERSION", "");
    vi.stubEnv("CLAUDEXOR_PLUGIN_VERSION", "0.1.0");
    expect(() => assertNoPluginArtifactSkew("4.0.0")).toThrow(
      expect.objectContaining({ code: "plugin_artifact_skew" }),
    );
  });
});
