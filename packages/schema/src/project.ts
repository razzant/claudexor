import { z } from "zod";
import { Id, IsoTimestamp, SchemaVersion } from "./primitives.js";

/** Durable v2 registration for a local project root. */
export const Project = z
  .object({
    schema_version: SchemaVersion,
    id: Id.describe("Stable Claudexor project id."),
    root: z.string().min(1).describe("Canonical absolute project root."),
    created_at: IsoTimestamp.describe("When the project was first registered."),
    updated_at: IsoTimestamp.describe("When the project link was last updated."),
  })
  .strict()
  .describe("A durable v2 project registration; v1 state is never imported implicitly.");
export type Project = z.infer<typeof Project>;

export const ControlProject = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    root: z.string().min(1),
    createdAt: IsoTimestamp,
    updatedAt: IsoTimestamp,
  })
  .strict()
  .describe("Control API projection of a registered project.");
export type ControlProject = z.infer<typeof ControlProject>;

export const ControlProjectListResponse = z.object({ projects: z.array(ControlProject) }).strict();
export type ControlProjectListResponse = z.infer<typeof ControlProjectListResponse>;

export const ControlProjectRegisterRequest = z.object({ root: z.string().min(1) }).strict();
export type ControlProjectRegisterRequest = z.infer<typeof ControlProjectRegisterRequest>;

export const ControlProjectRelinkRequest = z.object({ root: z.string().min(1) }).strict();
export type ControlProjectRelinkRequest = z.infer<typeof ControlProjectRelinkRequest>;
