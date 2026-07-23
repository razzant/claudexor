import {
  ControlProject,
  ControlProjectListResponse,
  ControlProjectOutputsResponse,
  ControlProjectRemoveReceipt,
  type ControlProject as ControlProjectType,
} from "@claudexor/schema";
import type { ParsedArgs } from "./args.js";
import { print, printJson, printUsageError } from "./cli-io.js";
import { controlProblemError, renderCliFailure } from "./cli-error.js";
import { ensureDaemon } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";

export async function projectCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const action = args._[1] ?? "list";
  try {
    if (action === "list") {
      if (args._.length !== 2 && args._.length !== 1) {
        return printUsageError(json, "usage: claudexor project list");
      }
      const { addr } = await ensureDaemon();
      const response = await controlApiFetch(addr, "/projects");
      const data = await responseJson(response);
      if (!response.ok) return failure(json, response.status, data);
      const result = ControlProjectListResponse.parse(data);
      if (json) printJson(result);
      else if (result.projects.length === 0) print("No projects registered.");
      else for (const project of result.projects) printProject(project);
      return 0;
    }
    if (action === "register") {
      const root = args._[2];
      if (!root || args._.length !== 3) {
        return printUsageError(json, "usage: claudexor project register <absolute-root>");
      }
      return mutateProject(json, "/projects", { root });
    }
    if (action === "relink") {
      const id = args._[2];
      const root = args._[3];
      if (!id || !root || args._.length !== 4) {
        return printUsageError(
          json,
          "usage: claudexor project relink <project-id> <absolute-root>",
        );
      }
      return mutateProject(json, `/projects/${encodeURIComponent(id)}/relink`, { root });
    }
    if (action === "remove") {
      const id = args._[2];
      if (!id || args._.length !== 3) {
        return printUsageError(json, "usage: claudexor project remove <project-id>");
      }
      const { addr } = await ensureDaemon();
      const response = await controlApiFetch(addr, `/projects/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await responseJson(response);
      if (!response.ok) return failure(json, response.status, data);
      const receipt = ControlProjectRemoveReceipt.parse(data);
      if (json) printJson(receipt);
      else {
        print(`Removed project ${receipt.projectId} (${receipt.root}).`);
        print(
          receipt.journalPartitionArchived
            ? `  Journal partition archived to ${receipt.archivedPartitionPath}.`
            : "  No journal partition to archive.",
        );
        print("  Run artifacts left in place for normal garbage collection.");
      }
      return 0;
    }
    if (action === "outputs") {
      const id = args._[2];
      if (!id || args._.length > 4) {
        return printUsageError(json, "usage: claudexor project outputs <project-id> [output-path]");
      }
      const outputPath = args._[3];
      const { addr } = await ensureDaemon();
      const base = `/projects/${encodeURIComponent(id)}/outputs`;
      if (outputPath === undefined) {
        // List the project's durable outputs.
        const response = await controlApiFetch(addr, base);
        const data = await responseJson(response);
        if (!response.ok) return failure(json, response.status, data);
        const result = ControlProjectOutputsResponse.parse(data);
        if (json) printJson(result);
        else if (result.artifacts.length === 0) print("No durable outputs.");
        else
          for (const artifact of result.artifacts)
            print(
              `${artifact.path}${artifact.kind === "directory" ? "/" : ""}${
                typeof artifact.bytes === "number" ? `  ${artifact.bytes}B` : ""
              }`,
            );
        return 0;
      }
      // Fetch a single durable output file. Text mode streams the raw bytes to
      // stdout; `--json` mode must keep the exactly-one-JSON-object contract, so
      // the bytes ride as base64 inside a self-contained envelope rather than
      // corrupting stdout with raw (possibly binary) content (QA-060).
      const response = await controlApiFetch(addr, `${base}/${encodeURIComponentPath(outputPath)}`);
      if (!response.ok) {
        const data = await responseJson(response);
        return failure(json, response.status, data);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (json) {
        printJson({
          ok: true,
          projectId: id,
          path: outputPath,
          encoding: "base64",
          byteLength: bytes.length,
          content: bytes.toString("base64"),
        });
      } else {
        process.stdout.write(bytes);
      }
      return 0;
    }
    return printUsageError(json, "usage: claudexor project list|register|relink|remove|outputs");
  } catch (error) {
    // Transport / bootstrap throwables are operational (exit 1); render them
    // through the SAME D-7 projector so the envelope shape stays uniform.
    return renderCliFailure(json, error, {
      defaultCategory: "operational",
      messagePrefix: "claudexor project:",
    });
  }
}

async function mutateProject(json: boolean, path: string, body: unknown): Promise<number> {
  const { addr } = await ensureDaemon();
  const response = await controlApiFetch(addr, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await responseJson(response);
  if (!response.ok) return failure(json, response.status, data);
  const project = ControlProject.parse(data);
  if (json) printJson(project);
  else printProject(project);
  return 0;
}

/** Human `project list` lines for one project: the id/root row plus a disclosed
 * (never refused) nesting line per overlap with another registered project, so
 * the operator is not confused by two projects whose files overlap (QA-072). */
export function projectListLines(project: ControlProjectType): string[] {
  const lines = [`${project.id}  ${project.root}`];
  for (const n of project.nesting) {
    lines.push(
      `    ${n.relation === "inside" ? "nested inside" : "contains"} ${n.root}  (${n.projectId})`,
    );
  }
  return lines;
}

function printProject(project: ControlProjectType): void {
  for (const line of projectListLines(project)) print(line);
}

/** Percent-encode each path segment while preserving the `/` separators the
 *  server splits on (it decodeURIComponent's the whole remainder). */
function encodeURIComponentPath(relPath: string): string {
  return relPath.split("/").map(encodeURIComponent).join("/");
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

/**
 * Project-route failure envelope, aligned to the central D-7 contract
 * (cli-error.ts): a typed `ControlProblem` body is preserved intact
 * (code/message/retryable/fieldErrors/requiredActions/context), the exit code
 * comes from the ONE category→exit table via `controlProblemError` (400/422 =
 * usage 2; everything else, incl. a 409 remove conflict on a fenced id =
 * operational 1), and the JSON envelope carries `exitCode` + `message` with the
 * legacy `error` alias. Exported for the failure-envelope test.
 */
export function failure(json: boolean, status: number, data: unknown): number {
  return renderCliFailure(json, controlProblemError(status, data, `HTTP ${status}`), {
    messagePrefix: "claudexor project:",
  });
}
