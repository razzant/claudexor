import type {
  HarnessEvent,
  HarnessProgram,
  HarnessRunSpec,
  NativeProgramEvidence,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { composeSpawnEnv } from "./env-scope.js";
import { resolveSelectedProgramAsync } from "./selected-program.js";

/** Resolve once immediately before dispatch, then launch that exact entry path. */
export async function prepareNativeProgram(
  program: HarnessProgram,
  bin: string,
  spec: HarnessRunSpec,
  patch?: Record<string, string | null | undefined>,
) {
  const environment = composeSpawnEnv(spec.env_inheritance, patch);
  const selected = await resolveSelectedProgramAsync(program, {
    sourceEnv: { ...environment, [program.overrideEnv]: bin },
    environment,
    cwd: spec.cwd,
  });
  let evidence: NativeProgramEvidence = {
    path: selected.path,
    version: selected.version,
    versionSource: selected.version === null ? "unknown" : "version_probe",
  };
  return {
    bin: selected.path ?? bin,
    observeVersion(version: unknown) {
      if (typeof version !== "string" || !version.trim()) return;
      evidence = {
        ...evidence,
        version: redactSecrets(version.trim()).slice(0, 256),
        versionSource: "vendor_stream",
      };
    },
    event(event: HarnessEvent): HarnessEvent {
      return ["started", "error", "completed"].includes(event.type)
        ? {
            ...event,
            program: { ...evidence },
            ...(event.request_refusal?.kind === "vendor_cli_too_old"
              ? {
                  request_refusal: {
                    ...event.request_refusal,
                    binary_path: evidence.path,
                    installed_version: evidence.version,
                  },
                }
              : {}),
          }
        : event;
    },
    evidence: () => ({ ...evidence }),
  };
}
export type NativeProgramRun = Awaited<ReturnType<typeof prepareNativeProgram>>;
