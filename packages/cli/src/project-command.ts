import {
  ControlProject,
  ControlProjectListResponse,
  ControlProjectOutputsResponse,
  type ControlProject as ControlProjectType,
} from "@claudexor/schema";
import type { ParsedArgs } from "./args.js";
import { print, printJson, printUsageError } from "./cli-io.js";
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
      // Fetch a single durable output file; stream its bytes to stdout.
      const response = await controlApiFetch(addr, `${base}/${encodeURIComponentPath(outputPath)}`);
      if (!response.ok) {
        const data = await responseJson(response);
        return failure(json, response.status, data);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      process.stdout.write(bytes);
      return 0;
    }
    return printUsageError(json, "usage: claudexor project list|register|relink|outputs");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) printJson({ ok: false, error: message });
    else process.stderr.write(`claudexor project: ${message}\n`);
    return 1;
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

function printProject(project: ControlProjectType): void {
  print(`${project.id}  ${project.root}`);
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

function failure(json: boolean, status: number, data: unknown): number {
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const message = String(record["message"] ?? record["error"] ?? `HTTP ${status}`);
  if (json) printJson({ ok: false, status, error: message, code: record["code"] ?? null });
  else process.stderr.write(`claudexor project: ${message}\n`);
  return 1;
}
import process from "node:process";
