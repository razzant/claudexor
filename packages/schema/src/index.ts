/**
 * @claudex/schema — single source of truth for all Claudex data shapes.
 *
 * Every other package imports types and validators from here. Do not define
 * competing shapes elsewhere. JSON Schema is generated from these Zod schemas
 * (see scripts/gen-jsonschema.ts).
 */
export * from "./primitives.js";
export * from "./task.js";
export * from "./context.js";
export * from "./harness.js";
export * from "./review.js";
export * from "./workproduct.js";
export * from "./budget.js";
export * from "./route.js";
export * from "./decision.js";
export * from "./gate.js";
export * from "./events.js";
export * from "./config.js";
