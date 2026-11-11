import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveHarnessBinary,
  resolveSelectedProgramAsync,
  selectProgramLauncher,
  HarnessUnavailableError,
  type DoctorSpec,
  type HarnessModelSpec,
} from "@claudexor/core";
import {
  ConformanceReport,
  HarnessModel,
  HarnessRunSpec,
  type ConformanceCheck,
  type HarnessCapabilityProfile,
  type Intent,
} from "@claudexor/schema";
import type { AcpEntry } from "./entry.js";
import { AcpFailure } from "./events.js";
import { acpToken } from "./env.js";
import { acpManifest } from "./manifest.js";
import { acpRunner, ACP_DISCLOSURE } from "./run.js";
import type { AcpObservation } from "./transport.js";

const INTENTS: Intent[] = [
  "plan",
  "spec",
  "implement",
  "repair",
  "create_from_scratch",
  "review",
  "verify",
  "synthesize",
  "explain",
  "audit",
];

export function acpProbes(
  entry: AcpEntry,
  profile: HarnessCapabilityProfile,
  runner: ReturnType<typeof acpRunner>,
) {
  let version: string | undefined;
  const binary = () => {
    const bin = selectProgramLauncher(entry.program);
    if (!resolveHarnessBinary(bin))
      throw new HarnessUnavailableError(`${entry.displayName} binary is not installed`);
    return bin;
  };
  const probe = async (spec: HarnessModelSpec, paid = false) => {
    binary();
    acpToken(entry, spec.credentialProfile ?? null);
    const temporary = paid ? mkdtempSync(join(tmpdir(), "acp-conformance-")) : null;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    spec.abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (spec.abortSignal?.aborted) abort.abort();
    const timer = setTimeout(onAbort, 45_000);
    const observation: AcpObservation = { writePermission: false, promptDispatched: false };
    try {
      let problem: AcpFailure | undefined;
      for await (const event of runner.run(
        HarnessRunSpec.parse({
          session_id: randomUUID(),
          intent: "implement",
          cwd: temporary ?? spec.cwd,
          access: paid ? "workspace_write" : "readonly",
          env: spec.env,
          auth_preference: spec.authPreference ?? "api_key",
          credential_profile: spec.credentialProfile ?? null,
          prompt: paid
            ? "Create claudexor-acp-conformance.txt in the current directory containing only ok. Then say done."
            : "",
          extra: { abortSignal: abort.signal },
        }),
        { probe: !paid, observation },
      )) {
        if (event.type === "error")
          problem = new AcpFailure(
            String(event.payload?.["code"] ?? "acp_error"),
            event.error ?? event.text ?? "ACP probe failed",
          );
        if (event.type === "completed" && event.payload?.["aborted"])
          problem ??= new AcpFailure("probe_cancelled", "ACP probe cancelled");
      }
      if (problem) throw problem;
      version = observation.version ?? version;
      return observation;
    } finally {
      clearTimeout(timer);
      spec.abortSignal?.removeEventListener("abort", onAbort);
      if (temporary) rmSync(temporary, { recursive: true, force: true });
    }
  };
  return {
    async discover() {
      const selected = await resolveSelectedProgramAsync(entry.program);
      if (!selected.versionOutput)
        throw new HarnessUnavailableError(`${entry.displayName} --version failed`);
      version = selected.versionOutput;
      return acpManifest(entry, version, profile);
    },
    async doctor(spec: DoctorSpec) {
      // Check ids follow the shared readiness table: `installed` is the binary
      // check remote install reads, `api_key` the managed token. A passed check
      // stays in the report when a later step fails.
      const passed: ConformanceCheck[] = [];
      let step = "acp_session";
      try {
        if (spec.authSource && spec.authSource !== "api_key_env")
          throw new HarnessUnavailableError("ACP supports only api_key_env authentication");
        step = "installed";
        binary();
        passed.push({ id: "installed", status: "pass" });
        step = "api_key";
        acpToken(entry);
        passed.push({ id: "api_key", status: "pass" });
        step = "acp_session";
        if (spec.conformance) profile.access_control.write_mechanism = "none";
        const observation = await probe(spec, spec.conformance === true);
        if (spec.conformance && observation.writePermission)
          profile.access_control.write_mechanism = "tool_policy";
        return ConformanceReport.parse({
          harness_id: entry.id,
          status: "degraded",
          enabled_intents: INTENTS,
          reasons: [ACP_DISCLOSURE],
          checks: [
            ...passed,
            {
              id: "acp_session",
              status: "pass",
              detail: "initialize and session/new accepted; default probe sends no prompt",
            },
            {
              id: "write_conformance",
              status: spec.conformance ? (observation.writePermission ? "pass" : "fail") : "skip",
              detail: `write_mechanism=${profile.access_control.write_mechanism}; ${observation.writePermission ? "typed write permission callback observed; shell is not sandboxed" : "write permission callback unproven or absent (#4537); writes are unfenced"}`,
            },
          ],
          auth_sources: [
            {
              source: "api_key_env",
              availability: "available",
              verification: spec.conformance ? "passed" : "not_run",
              detail: spec.conformance
                ? "explicit prompt completed"
                : "session creation accepted; paid capability smoke not run",
            },
          ],
        });
      } catch (error) {
        const code = error instanceof AcpFailure ? error.code : step;
        const message = error instanceof Error ? error.message : String(error);
        const detail = error instanceof Error ? `${code}: ${message}` : message;
        return ConformanceReport.parse({
          harness_id: entry.id,
          status: "unavailable",
          disabled_intents: INTENTS,
          reasons: [detail],
          checks: [...passed, { id: code, status: "fail", detail: message }],
          auth_sources: [
            { source: "api_key_env", availability: "unavailable", verification: "not_run", detail },
          ],
        });
      }
    },
    async models(spec?: HarnessModelSpec) {
      const hints = () => entry.modelHints.map((id) => HarnessModel.parse({ id, origin: "hint" }));
      if (!spec) return hints();
      try {
        const observation = await probe(spec);
        const models: HarnessModel[] = [];
        for (const config of observation.session?.configOptions ?? []) {
          if (config.category !== "model" || config.type !== "select") continue;
          for (const option of config.options) {
            for (const item of "options" in option ? option.options : [option])
              models.push(HarnessModel.parse({ id: item.value, label: item.name, origin: "live" }));
          }
        }
        return models.length ? models : hints();
      } catch {
        return hints();
      }
    },
  };
}
