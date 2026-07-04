/**
 * @claudexor/schema — single source of truth for all Claudexor data shapes.
 *
 * Every other package imports types and validators from here. Do not define
 * competing shapes elsewhere. JSON Schema is generated from these Zod schemas
 * (see scripts/gen-jsonschema.ts).
 */
export * from "./primitives.js";
export * from "./surface-run-controls.js";
export * from "./attachment.js";
export * from "./task.js";
export * from "./spec.js";
export * from "./context.js";
export * from "./harness.js";
export * from "./review.js";
export * from "./workproduct.js";
export * from "./budget.js";
export * from "./route.js";
export * from "./decision.js";
export * from "./control-run-detail.js";
export * from "./gate.js";
export * from "./events.js";
export * from "./telemetry.js";
export * from "./config.js";
export * from "./workspace.js";
export * from "./thread.js";
export * from "./orchestrate.js";
export * from "./control.js";
export * from "./control-trust.js";
